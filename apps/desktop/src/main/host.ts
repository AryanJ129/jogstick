import { compileProfile, createState, formatCommand, resolveCommand, step } from '@jogstick/engine';
import type { Command, EngineInput, EngineState, Mod, Os, StepResult } from '@jogstick/engine';
import { CLOSED, evaluateGate, sameGate } from './gate';
import type { GateState } from './gate';
import type { Log } from './log';
import type { FrontmostInfo, Native } from './native';
import type { PadSink, PadSource } from './pad';
import { ComboWriter, OutputQueue } from './queue';
import type { Clock, Op, OsMod, Sink } from './queue';
import type { Config } from './store';

/**
 * The input host: PadFrames → engine → output queue → addon, behind the gate. Owns safety: every
 * path that can leave something held ends in `releaseAll` (gate loss, mode/profile switch, pad
 * disconnect, sleep/lock, exceptions, native errors, quit).
 */
export interface HostStatus {
  mode: string;
  layers: string[];
  fine: boolean;
  gate: GateState;
  pad: { connected: boolean; name: string | null };
  paused: boolean;
  /** The frontmost window's bounds from the last watcher event (the overlay follows Resolve). */
  bounds?: number[] | undefined;
}

export interface HostDeps {
  native: Native;
  log: Log;
  os: Os;
  pad: PadSource;
  /** Extra app ids the gate accepts (JOGSTICK_GATE_APP, for the harness e2e only). */
  extraGateApps?: string[];
  now?: () => number;
  clock?: Clock;
}

const TICK_MS = 8;

/** `Mod` is ⌘ on macOS and Ctrl on Windows. */
export function osMod(m: Mod, os: Os): OsMod {
  return m === 'Mod' ? (os === 'darwin' ? 'Cmd' : 'Ctrl') : m;
}

export function osMods(mods: readonly Mod[], os: Os): OsMod[] {
  return mods.map((m) => osMod(m, os));
}

export class Host {
  private engine: EngineState;
  private config: Config;
  private readonly writer: ComboWriter;
  private readonly queue: OutputQueue;
  private gate: GateState = CLOSED;
  private paused = false;
  private access = true;
  private padConnected = false;
  private padName: string | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTick = 0;
  private wantsTick = false;
  /** Command holds: owner → the key that went down (released exactly, even after a reload). */
  private heldCommands = new Map<string, string>();
  private warnedDrive = false;
  private listeners = new Set<(s: HostStatus) => void>();
  private lastFrame: { buttons: number[]; axes: number[] } | null = null;
  /** Windows: whether Jogstick itself runs elevated (then an elevated Resolve isn't blocked). */
  private readonly selfElevated: boolean;
  private bounds: number[] | undefined;
  private padRestart: ReturnType<typeof setTimeout> | null = null;
  private padRestarts = 0;
  private unknownElevation = new Set<number>();
  readonly now: () => number;

  constructor(
    private readonly deps: HostDeps,
    config: Config,
  ) {
    this.now = deps.now ?? (() => performance.now());
    this.config = config;
    this.engine = createState(compileProfile(config.profile));
    this.engine.gateOpen = false;
    this.writer = new ComboWriter(config.profile.settings.comboSpacingMs);
    const n = deps.native;
    this.selfElevated =
      deps.os === 'win32' &&
      safe(deps.log, 'isProcessElevated(self)', () => n.isProcessElevated(process.pid), null) ===
        true;
    if (this.selfElevated) deps.log.add('app', 'Jogstick runs elevated (as administrator)');
    const sink: Sink = {
      modifierChanged: (mods) => n.modifierChanged(mods),
      keyDown: (code, mods) => n.keyDown(code, mods),
      keyUp: (code, mods) => n.keyUp(code, mods),
      mouseButton: (btn, down) => n.mouseButton(btn, down),
      mouseMoveRel: (dx, dy) => n.mouseMoveRel(dx, dy),
      scroll: (dx, dy, units) => n.scroll(dx, dy, units),
    };
    this.queue = new OutputQueue(
      sink,
      deps.clock ?? { setTimeout, clearTimeout: (h) => clearTimeout(h as never) },
      {
        canInject: () => this.gate.open && this.stillFront(),
        onDropped: (op) => this.deps.log.add('queue', `dropped ${describeOp(op)} (gate closed)`),
        onError: (err, op) => {
          this.deps.log.add(
            'error',
            `injecting ${op ? describeOp(op) : '(queue)'}: ${String(err)}`,
          );
          this.releaseAll('injection error');
        },
      },
    );
  }

  // --- lifecycle -------------------------------------------------------------

  start(): void {
    const { native, log } = this.deps;
    try {
      const left = native.releaseLeftovers();
      if (left.length > 0)
        log.add('app', `released leftovers from a previous run: ${left.join(', ')}`);
    } catch (e) {
      log.add('error', `releaseLeftovers: ${String(e)}`);
    }
    native.onFrontmostChanged((front) => this.onFrontmost(front), 25);
    this.onFrontmost(this.frontmost());
    this.deps.pad.start(this.padSink());
  }

  stop(reason = 'quit'): void {
    this.releaseAll(reason);
    if (this.padRestart) clearTimeout(this.padRestart);
    this.padRestart = null;
    this.deps.pad.stop();
    this.deps.native.offFrontmostChanged();
    this.setTicking(false);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  onStatus(l: (s: HostStatus) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  status(): HostStatus {
    return {
      mode: this.engine.mode,
      layers: [...this.engine.layerStack],
      fine: this.engine.fine,
      gate: this.gate,
      pad: { connected: this.padConnected, name: this.padName },
      paused: this.paused,
      bounds: this.bounds,
    };
  }

  get currentConfig(): Config {
    return this.config;
  }

  get queueBusy(): boolean {
    return this.queue.busy;
  }

  // --- safety ----------------------------------------------------------------

  /**
   * Drop pending output, reset the engine's holds (its up-commands are discarded: the addon
   * releases what it actually holds, mouse buttons → keys → modifiers).
   */
  releaseAll(reason: string): void {
    this.queue.clear();
    this.writer.reset();
    this.heldCommands.clear();
    // The OS release comes first and never depends on the engine: after an engine exception its
    // state may be half-updated and throw again.
    try {
      this.deps.native.releaseAll();
    } catch (e) {
      this.deps.log.add('error', `releaseAll: ${String(e)}`);
    }
    try {
      const r = step(this.engine, { kind: 'releaseAll', reason }, this.now());
      this.engine = r.state;
      this.schedule(r);
    } catch (e) {
      this.deps.log.add('error', `engine releaseAll: ${String(e)} (engine state rebuilt)`);
      this.rebuildEngine();
    }
    this.deps.log.add('app', `releaseAll (${reason})`);
  }

  /** A fresh engine in the same mode, holding nothing; held buttons wait for a new press. */
  private rebuildEngine(): void {
    const compiled = compileProfile(this.config.profile);
    const mode = this.engine.mode;
    let fresh = createState(compiled, compiled.modes.includes(mode) ? mode : undefined);
    fresh.connected = this.padConnected;
    fresh.gateOpen = false;
    this.setTicking(false);
    // Like a gate re-open: the last frame (taken while gated, so nothing fires) tells the engine
    // what is still held, then the gate opens and those inputs wait for a fresh press. Steps are
    // called directly (commands dropped) so a second failure can't loop back through releaseAll.
    try {
      const t = this.now();
      if (this.lastFrame)
        fresh = step(fresh, { kind: 'frame', frame: { t, ...this.lastFrame } }, t).state;
      if (this.gate.open) fresh = step(fresh, { kind: 'gate', open: true }, t).state;
    } catch (e) {
      this.deps.log.add('error', `engine rebuild: ${String(e)}`);
    }
    this.engine = fresh;
  }

  /** macOS: without the Accessibility grant nothing can be posted or read; the gate stays shut. */
  setAccess(ok: boolean): void {
    if (ok === this.access) return;
    this.access = ok;
    this.deps.log.add('app', ok ? 'Accessibility granted' : 'Accessibility not granted');
    this.onFrontmost(this.frontmost());
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.deps.log.add('app', paused ? 'paused from the tray' : 'resumed');
    this.onFrontmost(this.frontmost());
  }

  /** Re-read the frontmost app now (tray pause/resume, Accessibility granted). */
  refreshGate(): void {
    this.onFrontmost(this.frontmost());
  }

  private frontmost(): FrontmostInfo | null {
    return safe(this.deps.log, 'frontmostApp', () => this.deps.native.frontmostApp(), null);
  }

  /**
   * A new profile/keymap/overrides: releaseAll, then swap atomically. The new engine keeps what is
   * physically pressed or deflected and treats it like a gate re-open: nothing fires until it is
   * let go and pressed again.
   */
  applyConfig(config: Config): void {
    this.releaseAll('config reloaded');
    const prev = this.engine;
    const compiled = compileProfile(config.profile);
    const next = createState(compiled, compiled.modes.includes(prev.mode) ? prev.mode : undefined);
    next.connected = prev.connected;
    next.pressed = { ...prev.pressed };
    next.axes = [...prev.axes];
    next.triggerValues = { ...prev.triggerValues };
    next.gateOpen = false;
    this.config = config;
    this.engine = next;
    if (this.gate.open) this.run({ kind: 'gate', open: true });
    this.writer.spacingMs = config.profile.settings.comboSpacingMs;
    this.deps.log.add(
      'app',
      `active profile ${config.profile.id} (${config.profileSource}), comboSpacingMs ${this.writer.spacingMs}`,
    );
    this.emitStatus();
  }

  // --- inputs ----------------------------------------------------------------

  private padSink(): PadSink {
    return {
      frame: (buttons, axes) => this.onFrame(buttons, axes),
      connected: (name) => {
        this.padConnected = true;
        this.padName = name;
        this.padRestarts = 0;
        this.deps.log.add('pad', `connected: ${name}`);
        // One buzz on connect, so the user knows Jogstick has the pad (quick-start step 2).
        safe(this.deps.log, 'rumble', () => this.deps.pad.rumble('pulse'), undefined);
        this.emitStatus();
      },
      disconnected: () => {
        this.padConnected = false;
        this.deps.log.add('pad', 'disconnected');
        this.lastFrame = null;
        this.run({ kind: 'disconnect' }, true);
        this.releaseAll('controller disconnected');
        this.emitStatus();
      },
      error: (message, fatal) => {
        this.deps.log.add('error', `pad: ${message}`);
        this.releaseAll('pad error');
        if (fatal) this.restartPad();
      },
    };
  }

  /** The pad source died (thread panic, renderer gone): show it, then restart it with backoff. */
  private restartPad(): void {
    if (this.padConnected) this.run({ kind: 'disconnect' }, true);
    this.padConnected = false;
    this.lastFrame = null;
    this.emitStatus();
    if (this.padRestart) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.padRestarts++);
    this.deps.log.add('pad', `restarting the controller input in ${delay / 1000} s`);
    this.padRestart = setTimeout(() => {
      this.padRestart = null;
      safe(this.deps.log, 'pad stop', () => this.deps.pad.stop(), undefined);
      safe(this.deps.log, 'pad start', () => this.deps.pad.start(this.padSink()), undefined);
    }, delay);
  }

  onFrame(buttons: number[], axes: number[]): void {
    this.logFrameDiff(buttons, axes);
    this.run({ kind: 'frame', frame: { t: this.now(), buttons, axes } });
    // Windows: the addon thread's 120 Hz snapshots (high-resolution timer) double as ticks.
    if (this.wantsTick && this.now() - this.lastTick >= TICK_MS / 2) this.tick();
  }

  private evaluate(front: FrontmostInfo | null): GateState {
    return !this.access
      ? { open: false, reason: 'noAccess', app: front?.id ?? null }
      : this.paused
        ? { open: false, reason: 'paused', app: front?.id ?? null }
        : evaluateGate(front, {
            appMatch: [
              ...this.config.profile.appMatch[this.deps.os],
              ...(this.deps.extraGateApps ?? []),
            ],
            selfPid: process.pid,
            ...(this.deps.os === 'win32' && {
              isElevated: (pid: number) => this.elevated(pid),
              selfElevated: this.selfElevated,
            }),
          });
  }

  private elevated(pid: number): boolean | null {
    const e = safe(
      this.deps.log,
      'isProcessElevated',
      () => this.deps.native.isProcessElevated(pid),
      null,
    );
    if (e === null && !this.unknownElevation.has(pid)) {
      this.unknownElevation.add(pid);
      this.deps.log.add('warn', `can't tell whether pid ${pid} runs elevated; treating it as not`);
    }
    return e;
  }

  /**
   * Windows: the watcher polls every 25 ms, so a dialog or another app can be in front before the
   * gate hears of it, with a combo still in the queue. Each press re-reads the foreground window
   * (cheap on Windows; on macOS it is several AX calls, so the watcher alone decides there). A
   * mismatch drops the op and closes the gate right after this pump.
   */
  private stillFront(): boolean {
    if (this.deps.os !== 'win32') return true;
    const front = this.frontmost();
    if (this.evaluate(front).open) return true;
    setTimeout(() => this.onFrontmost(front), 0);
    return false;
  }

  private onFrontmost(front: FrontmostInfo | null): void {
    const next = this.evaluate(front);
    const boundsChanged = front?.bounds?.join() !== this.bounds?.join();
    this.bounds = front?.bounds;
    if (sameGate(next, this.gate)) {
      if (boundsChanged) this.emitStatus();
      return;
    }
    const was = this.gate.open;
    this.gate = next;
    this.deps.log.add(
      'gate',
      `${next.open ? 'open' : 'closed'} (${next.reason}${next.app ? `, ${next.app}` : ''})`,
    );
    if (was && !next.open) {
      this.run({ kind: 'gate', open: false }, true);
      this.releaseAll(`gate closed: ${next.reason}`);
    } else if (!was && next.open) this.run({ kind: 'gate', open: true });
    this.emitStatus();
  }

  // --- engine loop -----------------------------------------------------------

  private tick(): void {
    this.lastTick = this.now();
    this.run({ kind: 'tick' });
  }

  /** One engine step; `discard` drops its commands (releaseAll handles them). */
  private run(input: EngineInput, discard = false): void {
    let r: StepResult;
    try {
      r = step(this.engine, input, this.now());
    } catch (e) {
      this.deps.log.add(
        'error',
        `engine: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      this.releaseAll('engine exception');
      return;
    }
    this.engine = r.state;
    if (!discard) this.dispatch(r.commands);
    this.schedule(r);
  }

  private schedule(r: StepResult): void {
    this.setTicking(r.tick);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (r.wakeAt !== null) {
      const delay = Math.max(0, r.wakeAt - this.now());
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.tick();
      }, delay);
    }
  }

  private setTicking(on: boolean): void {
    this.wantsTick = on;
    if (on && !this.tickTimer) {
      this.tickTimer = setInterval(() => {
        if (this.now() - this.lastTick >= TICK_MS / 2) this.tick();
      }, TICK_MS);
    } else if (!on && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // --- commands → queue -------------------------------------------------------

  private dispatch(commands: Command[]): void {
    const os = this.deps.os;
    const log = this.deps.log;
    let statusChanged = false;
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i];
      if (!c) continue;
      if (c.type !== 'mouseMove' && c.type !== 'driveDelta') log.add('command', formatCommand(c));
      switch (c.type) {
        case 'command': {
          if (c.phase === 'up') {
            const code = this.heldCommands.get(c.owner);
            this.heldCommands.delete(c.owner);
            if (code) this.queue.push(this.writer.up(code));
            break;
          }
          const r = resolveCommand(c.id, os, this.config.keymap, this.config.overrides);
          if (!r.combo) {
            log.add('warn', `command ${c.id} has no shortcut`);
            break;
          }
          const mods = osMods([...r.combo.mods, ...c.mods], os);
          if (c.phase === 'tap') this.queue.push(this.writer.tap(r.combo.code, mods));
          else if (r.combo.code !== null) {
            this.heldCommands.set(c.owner, r.combo.code);
            this.queue.push(this.writer.down(r.combo.code, mods));
          }
          break;
        }
        case 'keyDown': {
          const next = commands[i + 1];
          // keyTap arrives as keyDown + keyUp of the same owner: send it as one combo.
          if (next?.type === 'keyUp' && next.code === c.code && next.owner === c.owner) {
            this.queue.push(this.writer.tap(c.code, osMods(c.mods, os)));
            i++;
          } else this.queue.push(this.writer.down(c.code, osMods(c.mods, os)));
          break;
        }
        case 'keyUp':
          this.queue.push(this.writer.up(c.code));
          break;
        case 'modifierDown':
        case 'modifierUp':
          this.queue.push(this.writer.modifier(osMod(c.mod, os), c.type === 'modifierDown'));
          break;
        case 'mouseButton':
          this.queue.push([{ op: 'button', btn: c.button, down: c.down }]);
          break;
        case 'mouseMove':
          if (c.dx !== 0 || c.dy !== 0) this.queue.push([{ op: 'move', dx: c.dx, dy: c.dy }]);
          break;
        case 'scroll':
          this.queue.push([{ op: 'scroll', dx: c.dx, dy: c.dy, units: c.units }]);
          break;
        case 'driveStart':
        case 'driveDelta':
        case 'driveEnd':
          // Color wheel drives are Phase 5 (pointer backend); never move the cursor for them here.
          if (!this.warnedDrive)
            log.add('warn', 'wheel drives arrive with Color mode (Phase 5); ignored');
          this.warnedDrive = true;
          break;
        case 'modeChanged':
        case 'layerChanged':
          statusChanged = true;
          break;
        case 'haptic':
          safe(log, 'rumble', () => this.deps.pad.rumble(c.kind), undefined);
          break;
      }
    }
    if (statusChanged) this.emitStatus();
  }

  private emitStatus(): void {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  private logFrameDiff(buttons: number[], axes: number[]): void {
    const prev = this.lastFrame;
    this.lastFrame = { buttons, axes };
    if (!prev) return;
    const changed: string[] = [];
    buttons.forEach((v, i) => {
      if (v > 0.5 !== (prev.buttons[i] ?? 0) > 0.5) changed.push(`b${i}${v > 0.5 ? '↓' : '↑'}`);
    });
    if (changed.length > 0) this.deps.log.add('frame', changed.join(' '));
  }
}

function describeOp(op: Op): string {
  switch (op.op) {
    case 'mods':
      return `mods [${op.mods.join('+')}]`;
    case 'keyDown':
    case 'keyUp':
      return `${op.op} ${[...op.mods, op.code].join('+')}`;
    case 'button':
      return `mouse ${op.btn} ${op.down ? 'down' : 'up'}`;
    case 'move':
      return `move ${op.dx},${op.dy}`;
    case 'scroll':
      return `scroll ${op.dx},${op.dy}`;
    case 'wait':
      return `wait ${op.ms}`;
  }
}

/** For calls whose failure must not stop the host; the error still reaches the Console. */
function safe<T>(log: Log, what: string, f: () => T, fallback: T): T {
  try {
    return f();
  } catch (e) {
    log.add('error', `${what}: ${String(e)}`);
    return fallback;
  }
}
