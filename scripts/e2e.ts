// Phase 3 verification: the real host (Electron, built) drives jogstick-harness, on the Mac and on
// the Windows CI runner.
//
//   pnpm -F @jogstick/native build && pnpm -F @jogstick/desktop build && pnpm e2e
//   (Windows also needs the harness: cargo build --release --features harness --bins)
//
// 1. Opens the harness in --log mode and waits until it holds the front (macOS: signed first with
//    scripts/harness-mac.sh --build, then opened, so it gets its own Accessibility entry).
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
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { crc32, inflateRawSync } from 'node:zlib';
import { parseCombo, parseKeymap, resolveCommand } from '../packages/engine/src/index';
import resolveKeymap from '../packages/profiles/resolve-keymap.json';

const root = join(import.meta.dirname, '..');
const work = join(root, 'packages/native/target/e2e');
mkdirSync(work, { recursive: true });
const keymap = parseKeymap(resolveKeymap);
const os = process.platform === 'win32' ? 'win32' : 'darwin';
const require = createRequire(import.meta.url);

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
  const r = resolveCommand(id, os, keymap);
  if (!r.combo || r.combo.code === null) return; // unbound: nothing must arrive
  expected.push({ kind: 'key', code: r.combo.code, mods: winitMods(r.combo.mods), why });
};
const expectCombo = (combo: string, why: string) => {
  const c = parseCombo(combo);
  expected.push({ kind: 'key', code: c.code ?? '', mods: winitMods(c.mods), why });
};
/** Our modifier names → winit's ModifiersState flags as the harness prints them. */
function winitMods(mods: string[]): string[] {
  const map: Record<string, string> = {
    Mod: os === 'darwin' ? 'SUPER' : 'CONTROL',
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

// releaseAll with keys held: slow zone holds K + L (checked through the injector's held state at
// the mark). Its K/L downs follow the shuttle's with no other key between, so the walk takes both
// as one run: a greedy match would give the first all of them.
set(BTN.rt, 0.25);
wait(500);
mark('releaseAll');
wait(300);
set(BTN.rt, 0);
wait(500);
expected.push({
  kind: 'run',
  codes: ['KeyK', 'KeyL'],
  min: 4,
  why: 'shuttle forward, then slow-zone K+L',
});
emit();

const scriptPath = join(work, 'script.json');
writeFileSync(scriptPath, JSON.stringify({ steps }));

// --- run ----------------------------------------------------------------------------

const harnessOut = join(root, 'packages/native/target/harness-logs/stdout.log');
const userData = mkdtempSync(join(tmpdir(), 'jogstick-e2e-'));
const overrides = join(userData, 'keymap-overrides.json');
// What the gate sees: the bundle id on macOS, the exe name on Windows.
const HARNESS = os === 'darwin' ? 'dev.jogstick.harness' : 'jogstick-harness.exe';

/** macOS only; on Windows the harness focuses its own window at creation. */
function activateHarness() {
  if (os === 'darwin')
    execFileSync('osascript', ['-e', `tell application id "${HARNESS}" to activate`]);
}

/** Opens the harness in --log mode with its stdout going to `harnessOut`. */
function openHarness() {
  if (os === 'darwin') {
    // Sign first (SecurityAgent flashes while the key is used), then open the signed app.
    execFileSync('sh', [join(root, 'scripts/harness-mac.sh'), '--build'], { stdio: 'ignore' });
    const app = join(root, 'packages/native/target/JogstickHarness.app');
    return spawn('open', ['-W', '-n', '--stdout', harnessOut, app, '--args', '--log'], {
      stdio: 'ignore',
    });
  }
  const exe = join(root, 'packages/native/target/release/jogstick-harness.exe');
  const child = spawn(exe, ['--log'], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', (b: Buffer) => appendFileSync(harnessOut, b));
  return child;
}

function closeHarness(child: ReturnType<typeof spawn>) {
  if (os === 'darwin')
    execFileSync('pkill', ['-f', 'JogstickHarness.app/Contents/MacOS/jogstick-harness']);
  else child.kill();
}

const native = require(join(root, 'packages/native/index.js')) as {
  frontmostApp(): { id: string } | null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the harness has been frontmost for a full second (SecurityAgent etc. come and go). */
async function harnessSettled(): Promise<boolean> {
  let since: number | null = null;
  for (let i = 0; i < 300; i++) {
    const front = native.frontmostApp()?.id.toLowerCase();
    if (front === HARNESS.toLowerCase()) {
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

/**
 * A native module that won't load (a junk `.node`): the host must not quit silently. It saves a
 * report with the exact error and the versions, says where it is, and exits 1. Needs no harness.
 */
async function loadFailure(): Promise<[boolean, string][]> {
  const out: [boolean, string][] = [];
  const ok = (pass: boolean, what: string) => out.push([pass, what]);
  const dir = mkdtempSync(join(tmpdir(), 'jogstick-e2e-loadfail-'));
  const broken = join(dir, 'broken.node');
  writeFileSync(broken, 'not a native module');
  const electron = require('electron') as string;
  const host = spawn(electron, [join(root, 'apps/desktop')], {
    env: { ...process.env, JOGSTICK_E2E_NATIVE_FAIL: broken, JOGSTICK_USER_DATA: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let failure: { report: string | null; message: string; detail: string } | null = null;
  createInterface({ input: host.stdout }).on('line', (line) => {
    if (line.startsWith('E2E-LOADFAIL ')) failure = JSON.parse(line.slice(13));
  });
  const code = await new Promise<number | null>((r) => host.on('exit', r));
  const f = failure as { report: string | null; message: string; detail: string } | null;
  ok(code === 1, `load failure: host exited 1 (${code})`);
  ok(
    !!f && f.message.length > 0 && f.detail.startsWith(f.message),
    `load failure: the dialog shows the exact error (${f?.message.split('\n')[0] ?? 'no E2E-LOADFAIL line'})`,
  );
  ok(
    !!f?.report && f.detail.includes(f.report) && /send that \.zip/.test(f.detail),
    `load failure: the dialog names the report and asks to send it (${f?.report ?? 'no report'})`,
  );
  let zip = new Map<string, string>();
  try {
    if (f?.report) zip = readZip(readFileSync(f.report));
  } catch (e) {
    console.log(`load failure report: ${String(e)}`);
  }
  const parts = ['README.txt', 'load-error.txt', 'system.json', 'console.txt'];
  ok(
    /jogstick-report-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/.test(f?.report ?? '') &&
      parts.every((p) => zip.has(p)),
    `load failure: report has all ${parts.length} parts (${[...zip.keys()].join(', ') || 'none'})`,
  );
  const err = zip.get('load-error.txt') ?? '';
  ok(
    err.includes('broken.node') && err.includes('code: ERR_DLOPEN_FAILED'),
    `load failure: load-error.txt has the error (${err.split('\n')[0] ?? ''})`,
  );
  const sys = JSON.parse(zip.get('system.json') ?? '{}') as {
    jogstick?: string;
    versions?: { electron?: string };
    os?: { platform?: string; version?: string };
  };
  ok(
    !!sys.jogstick && !!sys.versions?.electron && sys.os?.platform === os && !!sys.os.version,
    `load failure: system.json has versions and OS (${sys.jogstick} / electron ${sys.versions?.electron} / ${sys.os?.platform} ${sys.os?.version})`,
  );
  const user = userInfo().username.toLowerCase();
  const leaks = [...zip].filter(
    ([, text]) =>
      text.toLowerCase().includes(homedir().toLowerCase()) ||
      (user.length >= 3 && new RegExp(`\\b${user}\\b`).test(text.toLowerCase())),
  );
  ok(
    zip.size > 0 && leaks.length === 0,
    `load failure: report holds no home folder or user name (${leaks.map(([n]) => n).join(', ') || 'clean'})`,
  );
  return out;
}

async function main() {
  const loadFailureResults = await loadFailure();
  console.log(`script: ${steps.length} steps, ${t} ms; userData ${userData}`);
  mkdirSync(dirname(harnessOut), { recursive: true });
  writeFileSync(harnessOut, '');
  const harness = openHarness();
  await sleep(500);
  if (!(await harnessSettled())) {
    console.log(`ABORT: the harness never stayed in front (now: ${native.frontmostApp()?.id})`);
    process.exit(2);
  }

  // The electron package exports the path of its binary.
  const electron = require('electron') as string;
  const host = spawn(electron, [join(root, 'apps/desktop')], {
    env: {
      ...process.env,
      JOGSTICK_E2E_SCRIPT: scriptPath,
      // The tray's "Test with harness", switched on at start: the run goes through the same gate
      // path a user gets (JOGSTICK_GATE_APP still exists for other harness apps).
      JOGSTICK_E2E_TEST_MODE: '1',
      JOGSTICK_USER_DATA: userData,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  let held: unknown = null;
  let released: unknown = null;
  let done: { held: Held; osHeld: Held; rumbles: string[] } | null = null;
  const echoes: string[] = [];
  let reportPath: string | null = null;
  const rl = createInterface({ input: host.stdout });
  rl.on('line', (line) => {
    lines.push(line);
    if (line.startsWith('E2E-MARK ')) {
      const name = line.slice(9);
      if (name === 'ready' || name === 'go') activateHarness();
      if (name === 'override-enter')
        writeFileSync(overrides, JSON.stringify({ 'edit.pasteInsert': { [os]: 'Enter' } }));
      if (name === 'override-bad')
        writeFileSync(overrides, JSON.stringify({ 'edit.pasteInsert': { [os]: 'Nope+Key' } }));
      if (name === 'override-f13')
        writeFileSync(overrides, JSON.stringify({ 'edit.pasteInsert': { [os]: 'F13' } }));
    } else if (line.startsWith('E2E-HELD ')) held = JSON.parse(line.slice(9));
    else if (line.startsWith('E2E-RELEASED ')) released = JSON.parse(line.slice(13));
    else if (line.startsWith('E2E-DONE ')) done = JSON.parse(line.slice(9));
    else if (line.startsWith('E2E-ECHO ')) echoes.push(line.slice(9));
    else if (line.startsWith('E2E-REPORT ')) reportPath = line.slice(11);
  });
  const code = await new Promise<number | null>((r) => host.on('exit', r));
  await new Promise((r) => setTimeout(r, 300));
  closeHarness(harness);
  await new Promise((r) => harness.on('exit', r));
  writeFileSync(join(work, 'host.log'), lines.join('\n'));

  check(code, held, released, done, lines, echoes, reportPath, loadFailureResults);
}

/** Read a zip through its central directory, as unzip/Explorer do, checking each CRC. */
function readZip(buf: Buffer): Map<string, string> {
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) throw new Error('no end-of-central-directory record');
  const out = new Map<string, string>();
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const data = inflateRawSync(buf.subarray(start, start + size));
    if (crc32(data) !== buf.readUInt32LE(p + 16)) throw new Error(`${name}: CRC mismatch`);
    out.set(name, data.toString('utf8'));
    p += 46 + nameLen;
  }
  return out;
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

const MODIFIER_KEYS = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'SuperLeft',
  'SuperRight',
  'MetaLeft',
  'MetaRight',
]);

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
  echoes: string[],
  reportPath: string | null,
  earlier: [boolean, string][],
) {
  const results: [boolean, string][] = [...earlier];
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
    console.log('Run again and leave the machine untouched for ~30 s (harness window in front).');
    process.exit(2);
  }

  const events = readFileSync(harnessOut, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { type: string } & Partial<KeyEv>)
    .filter((e): e is KeyEv => e.type === 'key');
  // Windows reports a modifier as its own key event (ControlLeft down…up around the combo, location
  // Left); macOS sends flagsChanged, which the harness doesn't log as keys. Either way the combo's
  // modifiers are checked through each key's `mods` flags, so modifier keys are left out of the walk
  // (they still count for "every key that went down came up").
  const keyEvents = events.filter((e) => !MODIFIER_KEYS.has(e.physical));
  const downs = keyEvents.filter((e) => e.pressed && !e.repeat);
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

  const standard = keyEvents.every((e) => e.location === 'Standard');
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
  const r = released as { held: Held; osHeld: Held; settledMs?: number } | null;
  const empty = (x: Held | undefined) =>
    !!x && x.keys.length + x.mods.length + x.buttons.length === 0;
  const fmt = (x: unknown) => JSON.stringify(x);
  ok(
    empty(r?.held) && empty(r?.osHeld),
    `after releaseAll nothing is down (injector ${fmt(r?.held)}, OS ${fmt(r?.osHeld)} after ${r?.settledMs ?? '?'} ms)`,
  );
  ok(
    empty(done?.held) && empty(done?.osHeld),
    `at the end nothing is down (OS ${fmt(done?.osHeld)})`,
  );
  const pulses = done?.rumbles.filter((k) => k === 'pulse').length ?? 0;
  ok(pulses === 3, `connect buzz + two mode-switch buzzes (${done?.rumbles.join() || 'none'})`);
  const rejected = hostLines.some(
    (l) => l.includes('keymap-overrides.json') && l.includes('keeping the last good version'),
  );
  ok(rejected, 'invalid override file rejected in the Console');
  const reloads = hostLines.filter((l) => l.includes('reloaded keymap-overrides.json')).length;
  ok(reloads === 2, `two valid reloads in the Console (${reloads})`);
  const want = `[gate] open (open, ${HARNESS})`.toLowerCase();
  const opened = hostLines.some((l) => l.toLowerCase().includes(want));
  ok(opened, 'gate opened for the harness');
  ok(
    hostLines.some((l) => l.includes('test mode on: driving')),
    'the harness was reached through "Test with harness"',
  );

  // Test mode echoes every command with the keys it became (the overlay shows these).
  const mod = os === 'darwin' ? 'Cmd' : 'Ctrl';
  ok(
    echoes.includes(`edit.splitClip ${mod}+B`),
    `test mode echoed A as "edit.splitClip ${mod}+B" (${echoes.length} echoes)`,
  );
  const commandKeys = expected.filter((e) => e.kind === 'key').length;
  const commandEchoes = echoes.filter((e) => !e.startsWith('key ')).length;
  // Every 'key' expectation comes from a command (expectCommand, or an override via expectCombo).
  ok(
    commandEchoes >= commandKeys,
    `an echo per command (${commandEchoes} for ${commandKeys} expected keys)`,
  );

  // The test report the tray writes, built from this run's state.
  let report = new Map<string, string>();
  try {
    if (reportPath) report = readZip(readFileSync(reportPath));
  } catch (e) {
    console.log(`report: ${String(e)}`);
  }
  const parts = [
    'README.txt',
    'console.txt',
    'system.json',
    'controller.json',
    'profile.json',
    'keymap-overrides.json',
    'settings.json',
    'keymap.json',
    'gate-events.txt',
    'errors.txt',
  ];
  ok(
    parts.every((p) => report.has(p)),
    `test report has all ${parts.length} parts (${[...report.keys()].join(', ') || reportPath || 'no report'})`,
  );
  const sys = JSON.parse(report.get('system.json') ?? '{}') as {
    versions?: { native?: string };
    testMode?: boolean;
  };
  ok(
    !!sys.versions?.native && sys.testMode === true,
    `report system.json: native ${sys.versions?.native ?? '?'}, testMode ${String(sys.testMode)}`,
  );
  ok(
    (report.get('gate-events.txt') ?? '').includes('open (open,') &&
      (report.get('console.txt') ?? '').includes('test mode on'),
    'report has the gate events and the Console',
  );
  ok(
    JSON.parse(report.get('keymap-overrides.json') ?? 'null')?.['edit.pasteInsert']?.[os] === 'F13',
    'report has the active keymap override (F13)',
  );
  const user = userInfo().username.toLowerCase();
  const leaks = [...report].filter(
    ([, text]) =>
      text.toLowerCase().includes(homedir().toLowerCase()) ||
      (user.length >= 3 && new RegExp(`\\b${user}\\b`).test(text.toLowerCase())),
  );
  ok(
    report.size > 0 && leaks.length === 0,
    `report holds no home folder or user name (${leaks.map(([n]) => n).join(', ') || 'clean'})`,
  );
  ok(code === 0, `host exited 0 (${code})`);

  for (const [pass, what] of results) console.log(`${pass ? 'PASS' : 'FAIL'} ${what}`);
  const passed = results.filter(([p]) => p).length;
  console.log(`e2e-${process.platform}: ${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

void main();
