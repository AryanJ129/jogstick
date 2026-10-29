/**
 * The output queue: every injected event goes through here, serialized and time-scheduled
 * (BUILD_BRIEF → Processes and data flow). A combo with modifiers expands to
 * modifiers-down → spacing → key-down → key-up → spacing → modifiers-back; nothing interleaves
 * while it is in flight. Plain keys (jog arrows) carry no extra modifiers, so they skip the spacing
 * but still keep their place in line.
 */

/** Modifier names the addon understands. */
export type OsMod = 'Shift' | 'Ctrl' | 'Alt' | 'Cmd';
export type Btn = 'left' | 'right' | 'middle';

export type Op =
  | { op: 'mods'; mods: OsMod[] }
  | { op: 'keyDown'; code: string; mods: OsMod[] }
  | { op: 'keyUp'; code: string; mods: OsMod[] }
  | { op: 'button'; btn: Btn; down: boolean }
  | { op: 'move'; dx: number; dy: number }
  | { op: 'scroll'; dx: number; dy: number; units: 'lines' | 'pixels' }
  | { op: 'wait'; ms: number };

/** Where ops land: the addon in the app, a recorder in tests. */
export interface Sink {
  modifierChanged(mods: OsMod[]): void;
  keyDown(code: string, mods: OsMod[]): void;
  keyUp(code: string, mods: OsMod[]): void;
  mouseButton(btn: Btn, down: boolean): void;
  mouseMoveRel(dx: number, dy: number): void;
  scroll(dx: number, dy: number, units: 'lines' | 'pixels'): void;
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface QueueHooks {
  /** Checked before every op that presses or moves something; releases always go out. */
  canInject: () => boolean;
  onDropped?: (op: Op) => void;
  /** The sink threw (or the queue overflowed): the host runs releaseAll. */
  onError: (err: unknown, op: Op | undefined) => void;
}

/** Ops that only let go of something are always allowed, even with the gate closed. */
function isRelease(op: Op, held: OsMod[]): boolean {
  if (op.op === 'keyUp') return true;
  if (op.op === 'button') return !op.down;
  if (op.op === 'mods') return op.mods.every((m) => held.includes(m));
  return op.op === 'wait';
}

const sameMods = (a: OsMod[], b: OsMod[]) => a.length === b.length && a.every((m, i) => m === b[i]);

const MAX_PENDING = 1000;

export class OutputQueue {
  private pending: Op[] = [];
  private timer: unknown = null;
  /** The modifier set we last sent. */
  private held: OsMod[] = [];
  /** Keys we sent down; an up for a key that never went down (dropped press) is not sent. */
  private keys = new Set<string>();

  constructor(
    private readonly sink: Sink,
    private readonly clock: Clock,
    private readonly hooks: QueueHooks,
  ) {}

  get length(): number {
    return this.pending.length;
  }

  get busy(): boolean {
    return this.timer !== null || this.pending.length > 0;
  }

  push(ops: Op[]): void {
    this.pending.push(...ops);
    if (this.pending.length > MAX_PENDING) {
      this.clear();
      this.hooks.onError(new Error(`output queue over ${MAX_PENDING} entries`), ops[0]);
      return;
    }
    if (this.timer === null) this.drain();
  }

  /** Drop everything pending (releaseAll does the actual releasing through the addon). */
  clear(): void {
    this.pending = [];
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.held = [];
    this.keys.clear();
  }

  private drain(): void {
    for (let op = this.pending.shift(); op !== undefined; op = this.pending.shift()) {
      if (op.op === 'wait') {
        if (op.ms <= 0) continue;
        this.timer = this.clock.setTimeout(() => {
          this.timer = null;
          this.drain();
        }, op.ms);
        return;
      }
      if (op.op === 'mods' && sameMods(op.mods, this.held)) continue;
      const orphanUp = op.op === 'keyUp' && !this.keys.has(op.code);
      if (orphanUp || (!isRelease(op, this.held) && !this.hooks.canInject())) {
        this.hooks.onDropped?.(op);
        continue;
      }
      try {
        this.send(op);
      } catch (err) {
        this.clear();
        this.hooks.onError(err, op);
        return;
      }
    }
  }

  private send(op: Exclude<Op, { op: 'wait' }>): void {
    switch (op.op) {
      case 'mods':
        this.sink.modifierChanged(op.mods);
        this.held = [...op.mods];
        break;
      case 'keyDown':
        this.sink.keyDown(op.code, op.mods);
        this.held = [...op.mods];
        this.keys.add(op.code);
        break;
      case 'keyUp':
        this.sink.keyUp(op.code, op.mods);
        this.keys.delete(op.code);
        break;
      case 'button':
        this.sink.mouseButton(op.btn, op.down);
        break;
      case 'move':
        this.sink.mouseMoveRel(op.dx, op.dy);
        break;
      case 'scroll':
        this.sink.scroll(op.dx, op.dy, op.units);
        break;
    }
  }
}

const MOD_ORDER: OsMod[] = ['Ctrl', 'Alt', 'Shift', 'Cmd'];

export function sortMods(mods: Iterable<OsMod>): OsMod[] {
  const set = new Set(mods);
  return MOD_ORDER.filter((m) => set.has(m));
}

/**
 * Expands combos into queue ops around the standalone modifiers currently held (`base`).
 * `spacingMs` is `comboSpacingMs` from the profile (16 until Spike B says otherwise).
 */
export class ComboWriter {
  base: OsMod[] = [];

  constructor(public spacingMs: number) {}

  private extra(mods: OsMod[]): OsMod[] | null {
    const all = sortMods([...this.base, ...mods]);
    return all.length === this.base.length ? null : all;
  }

  private wait(): Op[] {
    return this.spacingMs > 0 ? [{ op: 'wait', ms: this.spacingMs }] : [];
  }

  tap(code: string | null, mods: OsMod[]): Op[] {
    const all = this.extra(mods);
    if (code === null) {
      if (!all) return [];
      return [{ op: 'mods', mods: all }, ...this.wait(), { op: 'mods', mods: this.base }];
    }
    if (!all)
      return [
        { op: 'keyDown', code, mods: this.base },
        { op: 'keyUp', code, mods: this.base },
      ];
    return [
      { op: 'mods', mods: all },
      ...this.wait(),
      { op: 'keyDown', code, mods: all },
      { op: 'keyUp', code, mods: all },
      ...this.wait(),
      { op: 'mods', mods: this.base },
    ];
  }

  /**
   * Hold a key. Extra modifiers go down for the press only and come back up right after it, so a
   * held combo never leaks its modifiers into the next event; Resolve acts on the key-down.
   */
  down(code: string, mods: OsMod[]): Op[] {
    const all = this.extra(mods);
    if (!all) return [{ op: 'keyDown', code, mods: this.base }];
    return [
      { op: 'mods', mods: all },
      ...this.wait(),
      { op: 'keyDown', code, mods: all },
      ...this.wait(),
      { op: 'mods', mods: this.base },
    ];
  }

  up(code: string): Op[] {
    return [{ op: 'keyUp', code, mods: this.base }];
  }

  /** A standalone (bare-modifier binding) modifier goes down or up. */
  modifier(mod: OsMod, down: boolean): Op[] {
    const next = down ? sortMods([...this.base, mod]) : this.base.filter((m) => m !== mod);
    if (next.length === this.base.length) return [];
    this.base = next;
    return [{ op: 'mods', mods: next }];
  }

  reset(): void {
    this.base = [];
  }
}
