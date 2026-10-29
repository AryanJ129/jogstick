/**
 * Synthetic pad timelines. A Timeline holds the current pad state; each change emits a
 * frame at the current time and `wait()` emits host-style ticks (8 ms by default, with
 * optional jitter to mimic Windows timer resolution on battery).
 */
import { BUTTON_INDEX } from '../../src/engine';
import type { TimedInput } from '../../src/replay';
import type { ButtonInput, PadFrame, StickId } from '../../src/types';

export interface TimelineOptions {
  start?: number;
  tickMs?: number;
  /** Tick intervals cycle through this list instead of `tickMs` (e.g. [8, 16, 11]). */
  tickPattern?: number[];
}

const STICK_AXES: Record<StickId, [number, number]> = { lstick: [0, 1], rstick: [2, 3] };

export class Timeline {
  t: number;
  private readonly pattern: number[];
  private tickIndex = 0;
  private nextTick: number;
  readonly buttons: number[] = Array<number>(17).fill(0);
  readonly axes: number[] = [0, 0, 0, 0];
  readonly events: TimedInput[] = [];

  constructor(opts: TimelineOptions = {}) {
    this.t = opts.start ?? 1000;
    this.pattern = opts.tickPattern ?? [opts.tickMs ?? 8];
    this.nextTick = this.t + this.interval();
  }

  private interval(): number {
    return this.pattern[this.tickIndex % this.pattern.length] as number;
  }

  private frame(): this {
    const frame: PadFrame = { t: this.t, buttons: [...this.buttons], axes: [...this.axes] };
    this.events.push({ now: this.t, input: { kind: 'frame', frame } });
    return this;
  }

  press(...inputs: ButtonInput[]): this {
    for (const i of inputs) this.buttons[BUTTON_INDEX[i]] = 1;
    return this.frame();
  }

  release(...inputs: ButtonInput[]): this {
    for (const i of inputs) this.buttons[BUTTON_INDEX[i]] = 0;
    return this.frame();
  }

  /** Set a raw button/trigger value (0..1). */
  value(input: ButtonInput, v: number): this {
    this.buttons[BUTTON_INDEX[input]] = v;
    return this.frame();
  }

  stick(stick: StickId, x: number, y: number): this {
    const [ix, iy] = STICK_AXES[stick];
    this.axes[ix] = x;
    this.axes[iy] = y;
    return this.frame();
  }

  /** Advance `ms`, emitting a tick at every tick boundary passed. */
  wait(ms: number): this {
    const end = this.t + ms;
    while (this.nextTick <= end) {
      this.t = this.nextTick;
      this.events.push({ now: this.t, input: { kind: 'tick' } });
      this.tickIndex += 1;
      this.nextTick = this.t + this.interval();
    }
    this.t = end;
    return this;
  }

  /** A single host tick at the current time (no time advance). */
  tick(): this {
    this.events.push({ now: this.t, input: { kind: 'tick' } });
    return this;
  }

  disconnect(): this {
    this.buttons.fill(0);
    this.axes.fill(0);
    this.events.push({ now: this.t, input: { kind: 'disconnect' } });
    return this;
  }

  gate(open: boolean): this {
    this.events.push({ now: this.t, input: { kind: 'gate', open } });
    return this;
  }

  releaseAll(reason = 'test'): this {
    this.events.push({ now: this.t, input: { kind: 'releaseAll', reason } });
    return this;
  }

  /** Release every button, center sticks, zero triggers. */
  neutral(): this {
    this.buttons.fill(0);
    this.axes.fill(0);
    return this.frame();
  }

  frames(): PadFrame[] {
    return this.events.flatMap((e) => (e.input.kind === 'frame' ? [e.input.frame] : []));
  }
}

// --- scenario builders -----------------------------------------------------------

/** Left-stick X sweep from `from` to `to` over `ms`, updating every `stepMs`, then back to center. */
export function jogSweep(
  tl: Timeline,
  from: number,
  to: number,
  ms: number,
  stepMs = 16,
): Timeline {
  const steps = Math.max(1, Math.round(ms / stepMs));
  for (let i = 0; i <= steps; i++) {
    tl.stick('lstick', from + ((to - from) * i) / steps, 0).wait(stepMs);
  }
  return tl.stick('lstick', 0, 0).wait(50);
}

/** Pull a trigger through `values`, holding each for `holdMs`, then release. */
export function triggerPull(
  tl: Timeline,
  trig: 'lt' | 'rt',
  values: number[],
  holdMs: number,
): Timeline {
  for (const v of values) tl.value(trig, v).wait(holdMs);
  return tl.value(trig, 0).wait(50);
}

/** Push a stick to polar (angleDeg, magnitude) and hold. 0° = right, 90° = down (+Y). */
export function diagonalPush(
  tl: Timeline,
  stick: StickId,
  angleDeg: number,
  mag: number,
  holdMs: number,
): Timeline {
  const r = (angleDeg * Math.PI) / 180;
  return tl
    .stick(stick, mag * Math.cos(r), mag * Math.sin(r))
    .wait(holdMs)
    .stick(stick, 0, 0)
    .wait(30);
}

/** Press inputs one after another `spreadMs` apart, hold, then release all. */
export function chord(
  tl: Timeline,
  inputs: ButtonInput[],
  spreadMs: number,
  holdMs: number,
): Timeline {
  inputs.forEach((i, n) => {
    if (n > 0) tl.wait(spreadMs);
    tl.press(i);
  });
  return tl
    .wait(holdMs)
    .release(...inputs)
    .wait(100);
}

/** Press and release an input after `ms`. */
export function quickTap(tl: Timeline, input: ButtonInput, ms: number): Timeline {
  return tl.press(input).wait(ms).release(input);
}

/** Hold a layer activator, press a key, release the activator first, then the key. */
export function layerHoldWithKeyDown(tl: Timeline, layer: ButtonInput, key: ButtonInput): Timeline {
  return tl.press(layer).wait(30).press(key).wait(50).release(layer).wait(50).release(key).wait(50);
}

/** Drive a wheel with a stick and flip modes (view + menu) mid-drive. */
export function modeSwitchMidDrive(tl: Timeline): Timeline {
  return tl
    .press('view', 'menu')
    .wait(20)
    .release('view', 'menu')
    .wait(100)
    .stick('lstick', 0.8, 0)
    .wait(200)
    .press('view', 'menu')
    .wait(20)
    .release('view', 'menu')
    .wait(100)
    .stick('lstick', 0, 0)
    .wait(100);
}

/**
 * The committed replay fixture (test/fixtures/edit-session.frames.json): a jog sweep,
 * a shuttle pull through the slow zone and 1×, a quick tap of a chord participant,
 * a trim-layer ripple delete, then frames stop mid-hold (a frames file can't encode the
 * disconnect itself; replay's tail returns everything to rest). Regenerate with
 * `pnpm -F @jogstick/engine exec tsx scripts/make-fixture.ts`.
 */
export function editSessionFixture(): { description: string; mode: string; frames: PadFrame[] } {
  const tl = new Timeline({ start: 0 });
  jogSweep(tl, 0, 1, 600);
  jogSweep(tl, 0, -0.5, 300);
  triggerPull(tl, 'rt', [0.2, 0.5], 300);
  quickTap(tl, 'view', 20).wait(200);
  layerHoldWithKeyDown(tl, 'lb', 'a');
  disconnectMidHold(tl, 'dpadRight');
  return {
    description: 'synthetic edit session (generator: editSessionFixture)',
    mode: 'edit',
    frames: tl.frames(),
  };
}

/** Pad disconnects while a key and a drive are held. */
export function disconnectMidHold(tl: Timeline, key: ButtonInput): Timeline {
  return tl.press(key).wait(50).stick('rstick', 0.9, 0).wait(100).disconnect().wait(50);
}
