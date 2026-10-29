// Phase 3 verification on the Mac: the real host (Electron, built) drives jogstick-harness.
//
//   pnpm -F @jogstick/desktop build && pnpm e2e:mac
//
// 1. Opens the harness (scripts/harness-mac.sh --log) and brings it to the front.
// 2. Runs the host with a generated pad script (JOGSTICK_E2E_SCRIPT), the gate pointed at the
//    harness (JOGSTICK_GATE_APP) and a fresh <userData> (JOGSTICK_USER_DATA).
// 3. Acts on the script's marks: writes keymap-overrides.json (hot reload, incl. an invalid file).
// 4. Checks what the harness received against expectations computed from the profile + keymap
//    (not from the engine): every Edit-mode command, layers, jog arrows at the Standard location,
//    Backspace/Enter after jogging, overrides, shuttle, and releaseAll leaving nothing down.
//
// Mouse buttons/moves are not driven here (the cursor may be outside the harness window, and a
// click would land in another app); the harness self-test covers mouse injection.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseCombo, parseKeymap, resolveCommand } from '../packages/engine/src/index';
import resolveKeymap from '../packages/profiles/resolve-keymap.json';

const root = join(import.meta.dirname, '..');
const work = join(root, 'packages/native/target/e2e');
mkdirSync(work, { recursive: true });
const keymap = parseKeymap(resolveKeymap);

// --- the pad script ---------------------------------------------------------------

const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, view: 8, menu: 9, l3: 10 };
const DPAD = { up: 12, down: 13, left: 14, right: 15 };
type Step = { at: number; buttons: number[]; axes: number[] } | { at: number; mark: string };
type Expect =
  | { kind: 'key'; code: string; mods: string[]; why: string }
  | { kind: 'run'; codes: string[]; min: number; why: string };

const steps: Step[] = [];
const expected: Expect[] = [];
const buttons = new Array<number>(17).fill(0);
const axes = [0, 0, 0, 0];
let t = 0;

const emit = () => steps.push({ at: t, buttons: [...buttons], axes: [...axes] });
const wait = (ms: number) => (t += ms);
const mark = (name: string) => steps.push({ at: t, mark: name });
const set = (i: number, v: number) => {
  buttons[i] = v;
  emit();
};
const expectCommand = (id: string, why: string) => {
  const r = resolveCommand(id, 'darwin', keymap);
  if (!r.combo || r.combo.code === null) return; // unbound: nothing must arrive
  expected.push({ kind: 'key', code: r.combo.code, mods: macMods(r.combo.mods), why });
};
const expectCombo = (combo: string, why: string) => {
  const c = parseCombo(combo);
  expected.push({ kind: 'key', code: c.code ?? '', mods: macMods(c.mods), why });
};
function macMods(mods: string[]): string[] {
  const map: Record<string, string> = {
    Mod: 'SUPER',
    Cmd: 'SUPER',
    Ctrl: 'CONTROL',
    Shift: 'SHIFT',
    Alt: 'ALT',
  };
  return [...new Set(mods.map((m) => map[m] ?? m))].sort();
}
const tap = (i: number, id: string | null, why: string) => {
  set(i, 1);
  wait(80);
  set(i, 0);
  wait(200);
  if (id) expectCommand(id, why);
};
function layer(i: number, body: () => void) {
  set(i, 1);
  wait(100);
  body();
  set(i, 0);
  wait(200);
}
function axis(i: number, v: number, ms: number) {
  axes[i] = v;
  emit();
  wait(ms);
  axes[i] = 0;
  emit();
  wait(300);
}
function trigger(i: number, v: number, ms: number) {
  set(i, v);
  wait(ms);
  set(i, 0);
  wait(300);
}

mark('ready');
// The driver brings the harness to the front, twice: the dev host's app.dock.hide() hands focus
// back to the launching terminal a moment after startup.
wait(1500);
mark('go');
wait(1000);
emit();
wait(200);

// Base layer, Edit mode.
tap(BTN.a, 'edit.splitClip', 'A');
tap(BTN.x, 'edit.cut', 'X');
tap(BTN.y, 'edit.copy', 'Y');
tap(BTN.b, 'edit.paste', 'B');
tap(DPAD.up, 'nav.prevEdit', 'd-pad up');
tap(DPAD.down, 'nav.nextEdit', 'd-pad down');
tap(DPAD.left, 'nav.stepFrameBackward', 'd-pad left');
tap(DPAD.right, 'nav.stepFrameForward', 'd-pad right');
tap(BTN.l3, 'transport.playPause', 'L3');
tap(BTN.view, 'edit.undo', 'View');
tap(BTN.menu, 'edit.redo', 'Menu');
axis(1, -0.8, 200);
expectCommand('view.zoomIn', 'left stick up');
axis(1, 0.8, 200);
expectCommand('view.zoomOut', 'left stick down');

// Trim layer (hold LB).
layer(BTN.lb, () => {
  tap(BTN.a, 'edit.rippleDelete', 'LB+A');
  tap(BTN.x, 'edit.rippleCut', 'LB+X');
  tap(BTN.y, 'trim.extendEdit', 'LB+Y');
  tap(BTN.b, 'edit.pasteInsert', 'LB+B (unbound: nothing)');
  tap(DPAD.up, 'trim.trimStart', 'LB+up');
  tap(DPAD.down, 'trim.trimEnd', 'LB+down');
  tap(DPAD.left, 'trim.nudgeLeft', 'LB+left');
  tap(DPAD.right, 'trim.nudgeRight', 'LB+right');
  tap(BTN.l3, 'transport.playAround', 'LB+L3');
  axis(1, -0.8, 200);
  expectCommand('view.zoomToFit', 'LB+stick up');
});

// Mark layer (hold RB).
layer(BTN.rb, () => {
  tap(BTN.a, 'view.toggleSourceTimeline', 'RB+A');
  tap(BTN.x, 'select.clipsForwardAllTracks', 'RB+X');
  tap(BTN.y, 'select.nearestClipGap', 'RB+Y');
  tap(BTN.b, 'nav.matchFrame', 'RB+B');
  tap(DPAD.up, 'mark.in', 'RB+up');
  tap(DPAD.down, 'mark.out', 'RB+down');
  tap(DPAD.left, 'trim.rippleStartToPlayhead', 'RB+left');
  tap(DPAD.right, 'trim.rippleEndToPlayhead', 'RB+right');
  tap(BTN.l3, 'mark.clearInOut', 'RB+L3');
});

// Jog, then Backspace right after it (arrows must not leave numpad/fn flags behind).
axis(0, 0.6, 1000);
expected.push({ kind: 'run', codes: ['ArrowRight'], min: 5, why: 'jog right' });
layer(BTN.lb, () => tap(BTN.a, 'edit.rippleDelete', 'LB+A after jog'));

// Mode switch there and back (View+Menu chord): no keys, two buzzes.
for (let i = 0; i < 2; i++) {
  buttons[BTN.view] = 1;
  buttons[BTN.menu] = 1;
  emit();
  wait(150);
  buttons[BTN.view] = 0;
  buttons[BTN.menu] = 0;
  emit();
  wait(400);
}

// Hot reload: Paste insert → Enter; an invalid file keeps Enter; then F13.
mark('override-enter');
wait(1500);
layer(BTN.lb, () => tap(BTN.b, null, ''));
expectCombo('Enter', 'override edit.pasteInsert → Enter (Return after jogging)');
mark('override-bad');
wait(1500);
layer(BTN.lb, () => tap(BTN.b, null, ''));
expectCombo('Enter', 'invalid override file: last good (Enter) stays');
mark('override-f13');
wait(1500);
layer(BTN.lb, () => tap(BTN.b, null, ''));
expectCombo('F13', 'override edit.pasteInsert → F13');

// Shuttle forward.
trigger(BTN.rt, 0.5, 600);
expected.push({ kind: 'run', codes: ['KeyK', 'KeyL'], min: 2, why: 'shuttle forward' });

// releaseAll with keys held: slow zone holds K + L.
set(BTN.rt, 0.25);
wait(500);
mark('releaseAll');
wait(300);
set(BTN.rt, 0);
wait(500);
expected.push({ kind: 'run', codes: ['KeyK', 'KeyL'], min: 2, why: 'slow-zone K+L held' });
emit();

const scriptPath = join(work, 'script.json');
writeFileSync(scriptPath, JSON.stringify({ steps }));

// --- run ----------------------------------------------------------------------------

const harnessOut = join(root, 'packages/native/target/harness-logs/stdout.log');
const userData = mkdtempSync(join(tmpdir(), 'jogstick-e2e-'));
const overrides = join(userData, 'keymap-overrides.json');
const HARNESS = 'dev.jogstick.harness';

function activateHarness() {
  execFileSync('osascript', ['-e', `tell application id "${HARNESS}" to activate`]);
}

const native = createRequire(import.meta.url)(join(root, 'packages/native/index.js')) as {
  frontmostApp(): { id: string } | null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the harness has been frontmost for a full second (SecurityAgent etc. come and go). */
async function harnessSettled(): Promise<boolean> {
  let since: number | null = null;
  for (let i = 0; i < 300; i++) {
    const front = native.frontmostApp()?.id;
    if (front === HARNESS) {
      since ??= Date.now();
      if (Date.now() - since >= 1000) return true;
    } else {
      since = null;
      if (i % 20 === 0) activateHarness();
    }
    await sleep(50);
  }
  return false;
}

async function main() {
  console.log(`script: ${steps.length} steps, ${t} ms; userData ${userData}`);
  // Sign first (SecurityAgent flashes while the key is used), then open the signed app.
  execFileSync('sh', [join(root, 'scripts/harness-mac.sh'), '--build'], { stdio: 'ignore' });
  mkdirSync(dirname(harnessOut), { recursive: true });
  writeFileSync(harnessOut, '');
  const app = join(root, 'packages/native/target/JogstickHarness.app');
  const harness = spawn('open', ['-W', '-n', '--stdout', harnessOut, app, '--args', '--log'], {
    stdio: 'ignore',
  });
  await sleep(500);
  if (!(await harnessSettled())) {
    console.log(`ABORT: the harness never stayed in front (now: ${native.frontmostApp()?.id})`);
    process.exit(2);
  }

  const host = spawn(join(root, 'node_modules/.bin/electron'), [join(root, 'apps/desktop')], {
    env: {
      ...process.env,
      JOGSTICK_E2E_SCRIPT: scriptPath,
      JOGSTICK_GATE_APP: HARNESS,
      JOGSTICK_USER_DATA: userData,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  let held: unknown = null;
  let released: unknown = null;
  let done: { held: Held; osHeld: Held; rumbles: string[] } | null = null;
  const rl = createInterface({ input: host.stdout });
  rl.on('line', (line) => {
    lines.push(line);
    if (line.startsWith('E2E-MARK ')) {
      const name = line.slice(9);
      if (name === 'ready' || name === 'go') activateHarness();
      if (name === 'override-enter')
        writeFileSync(overrides, JSON.stringify({ 'edit.pasteInsert': { darwin: 'Enter' } }));
      if (name === 'override-bad')
        writeFileSync(overrides, JSON.stringify({ 'edit.pasteInsert': { darwin: 'Nope+Key' } }));
      if (name === 'override-f13')
        writeFileSync(overrides, JSON.stringify({ 'edit.pasteInsert': { darwin: 'F13' } }));
    } else if (line.startsWith('E2E-HELD ')) held = JSON.parse(line.slice(9));
    else if (line.startsWith('E2E-RELEASED ')) released = JSON.parse(line.slice(13));
    else if (line.startsWith('E2E-DONE ')) done = JSON.parse(line.slice(9));
  });
  const code = await new Promise<number | null>((r) => host.on('exit', r));
  await new Promise((r) => setTimeout(r, 300));
  execFileSync('pkill', ['-f', 'JogstickHarness.app/Contents/MacOS/jogstick-harness']);
  await new Promise((r) => harness.on('exit', r));
  writeFileSync(join(work, 'host.log'), lines.join('\n'));

  check(code, held, released, done, lines);
}

// --- check ------------------------------------------------------------------------

interface Held {
  keys: string[];
  mods: string[];
  buttons: string[];
}
interface KeyEv {
  type: 'key';
  physical: string;
  location: string;
  pressed: boolean;
  repeat: boolean;
  mods: string;
}

function flags(mods: string): string[] {
  const m = /ModifiersState\((.*)\)/.exec(mods);
  if (!m?.[1] || m[1] === '0x0') return [];
  return m[1]
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('0x'))
    .sort();
}

function check(
  code: number | null,
  held: unknown,
  released: unknown,
  done: { held: Held; osHeld: Held; rumbles: string[] } | null,
  hostLines: string[],
) {
  const results: [boolean, string][] = [];
  const ok = (pass: boolean, what: string) => results.push([pass, what]);

  // The gate follows the real front app: if anything else came to the front mid-run, the host
  // (correctly) stopped injecting and the rest of the checks would only measure that.
  // Only frames that arrived while the gate was closed spoil the run.
  let open = false;
  let framesClosed = 0;
  let leaked = 0;
  const closures: string[] = [];
  for (const l of hostLines) {
    if (l.startsWith('[gate] ')) {
      open = l.startsWith('[gate] open');
      if (!open) closures.push(l);
    } else if (!open && l.startsWith('[frame]')) framesClosed++;
    else if (!open && l.startsWith('[command]')) leaked++;
  }
  if (framesClosed > 0) {
    console.log('ABORT: other apps came to the front during the run; the gate closed, as it must:');
    for (const l of closures) console.log(`  ${l}`);
    console.log(`  pad frames while closed: ${framesClosed}; commands dispatched then: ${leaked}`);
    console.log('Run again and leave the Mac untouched for ~30 s (harness window in front).');
    process.exit(2);
  }

  const events = readFileSync(harnessOut, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { type: string } & Partial<KeyEv>)
    .filter((e): e is KeyEv => e.type === 'key');
  const downs = events.filter((e) => e.pressed && !e.repeat);
  ok(downs.length > 0, `harness received key events (${downs.length} downs)`);

  // Walk the expected list against the harness's key-downs, in order.
  let i = 0;
  for (const exp of expected) {
    if (exp.kind === 'key') {
      const d = downs[i];
      const got = d ? `${[...flags(d.mods), d.physical].join('+')}` : 'nothing';
      const want = [...exp.mods, exp.code].join('+');
      const pass = d?.physical === exp.code && flags(d.mods).join() === exp.mods.join();
      ok(pass, `${exp.why}: ${want} (got ${got})`);
      i++;
    } else {
      const start = i;
      const inRun = (d: KeyEv | undefined) =>
        !!d && exp.codes.includes(d.physical) && flags(d.mods).length === 0;
      while (inRun(downs[i])) i++;
      const n = i - start;
      ok(n >= exp.min, `${exp.why}: ${n} × ${exp.codes.join('/')}, no modifiers (≥ ${exp.min})`);
    }
  }
  const extra = downs.slice(i).map((d) => d.physical);
  ok(extra.length === 0, `no unexpected keys (${extra.length} extra: ${extra.join(' ')})`);

  const standard = events.every((e) => e.location === 'Standard');
  ok(standard, 'every key at the Standard location (no numpad arrows)');
  const down = new Set<string>();
  for (const e of events) {
    if (e.pressed) down.add(e.physical);
    else down.delete(e.physical);
  }
  ok(down.size === 0, `harness: every key that went down came up (left: ${[...down].join(' ')})`);

  const h = held as { held: Held } | null;
  const heldKL = !!h && h.held.keys.includes('KeyK') && h.held.keys.includes('KeyL');
  ok(heldKL, `before releaseAll the injector held K+L (${JSON.stringify(h?.held)})`);
  const r = released as { held: Held; osHeld: Held } | null;
  const empty = (x: Held | undefined) =>
    !!x && x.keys.length + x.mods.length + x.buttons.length === 0;
  const fmt = (x: unknown) => JSON.stringify(x);
  ok(
    empty(r?.held) && empty(r?.osHeld),
    `after releaseAll nothing is down (injector ${fmt(r?.held)}, OS ${fmt(r?.osHeld)})`,
  );
  ok(
    empty(done?.held) && empty(done?.osHeld),
    `at the end nothing is down (OS ${fmt(done?.osHeld)})`,
  );
  const pulses = done?.rumbles.filter((k) => k === 'pulse').length ?? 0;
  ok(pulses === 2, `two mode-switch buzzes (${done?.rumbles.join() || 'none'})`);
  const rejected = hostLines.some(
    (l) => l.includes('keymap-overrides.json') && l.includes('keeping the last good version'),
  );
  ok(rejected, 'invalid override file rejected in the Console');
  const reloads = hostLines.filter((l) => l.includes('reloaded keymap-overrides.json')).length;
  ok(reloads === 2, `two valid reloads in the Console (${reloads})`);
  const opened = hostLines.some((l) => l.includes(`[gate] open (open, ${HARNESS})`));
  ok(opened, 'gate opened for the harness');
  ok(code === 0, `host exited 0 (${code})`);

  for (const [pass, what] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${what}`);
  const passed = results.filter(([p]) => p).length;
  console.log(`e2e-mac: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

void main();
