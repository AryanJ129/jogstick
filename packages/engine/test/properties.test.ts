/**
 * No-stuck-input properties: any frame sequence that ends all-released (followed by a
 * disconnect) leaves nothing held, and at most one drive is ever active.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BUTTON_INPUTS } from '../src/schema';
import type { LogEntry } from '../src/replay';
import type { ButtonInput } from '../src/types';
import { Timeline, engineFor, play, resolveEngine, testProfile } from './helpers';

type Op =
  | { k: 'press'; i: ButtonInput }
  | { k: 'release'; i: ButtonInput }
  | { k: 'value'; i: 'lt' | 'rt'; v: number }
  | { k: 'stick'; s: 'lstick' | 'rstick'; x: number; y: number }
  | { k: 'wait'; ms: number }
  | { k: 'push'; s: 'lstick' | 'rstick'; x: number; y: number; ms: number }
  | { k: 'chord'; gapMs: number; holdMs: number }
  | { k: 'gateBlip'; ms: number }
  | { k: 'releaseAll' };

const buttons = BUTTON_INPUTS.filter((b) => b !== 'lt' && b !== 'rt');
const axis = fc.double({ min: -1, max: 1, noNaN: true });
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ k: fc.constant('press' as const), i: fc.constantFrom(...buttons) }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ k: fc.constant('release' as const), i: fc.constantFrom(...buttons) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant('value' as const),
      i: fc.constantFrom('lt' as const, 'rt' as const),
      v: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('stick' as const),
      s: fc.constantFrom('lstick' as const, 'rstick' as const),
      x: axis,
      y: axis,
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({ k: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 400 }) }),
  },
  // Structured ops so drives, jogs and mode switches actually happen in most runs.
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant('push' as const),
      s: fc.constantFrom('lstick' as const, 'rstick' as const),
      x: axis,
      y: axis,
      ms: fc.integer({ min: 20, max: 300 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('chord' as const),
      gapMs: fc.integer({ min: 0, max: 80 }),
      holdMs: fc.integer({ min: 0, max: 200 }),
    }),
  },
  // Gate loss is a blip (Resolve loses focus, then regains it); a permanent close would gate the rest of the run.
  {
    weight: 1,
    arbitrary: fc.record({
      k: fc.constant('gateBlip' as const),
      ms: fc.integer({ min: 0, max: 200 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'releaseAll' as const }) },
);

function build(ops: Op[], start: number): Timeline {
  const tl = new Timeline({ start, tickPattern: [8, 12, 16] });
  for (const o of ops) {
    if (o.k === 'press') tl.press(o.i);
    else if (o.k === 'release') tl.release(o.i);
    else if (o.k === 'value') tl.value(o.i, o.v);
    else if (o.k === 'stick') tl.stick(o.s, o.x, o.y);
    else if (o.k === 'wait') tl.wait(o.ms);
    else if (o.k === 'push') tl.stick(o.s, o.x, o.y).wait(o.ms);
    else if (o.k === 'chord')
      tl.press('view').wait(o.gapMs).press('menu').wait(o.holdMs).release('view', 'menu');
    else if (o.k === 'gateBlip') tl.gate(false).wait(o.ms).gate(true);
    else tl.releaseAll();
  }
  // End all-released, let timers settle, then disconnect.
  return tl.gate(true).neutral().wait(1000).disconnect().wait(50);
}

function checkBalanced(log: LogEntry[]): void {
  const keys = new Map<string, number>();
  const cmds = new Map<string, number>();
  const mods = new Map<string, number>();
  const mouse = new Map<string, number>();
  let drives = 0;
  const bump = (m: Map<string, number>, k: string, d: number) => {
    const v = (m.get(k) ?? 0) + d;
    // Never an up without a down, never a second down while held.
    expect(v === 0 || v === 1).toBe(true);
    m.set(k, v);
  };
  for (const { command: c } of log) {
    if (c.type === 'keyDown') bump(keys, c.code, 1);
    else if (c.type === 'keyUp') bump(keys, c.code, -1);
    else if (c.type === 'command' && c.phase === 'down') bump(cmds, c.id, 1);
    else if (c.type === 'command' && c.phase === 'up') bump(cmds, c.id, -1);
    else if (c.type === 'modifierDown') bump(mods, c.mod, 1);
    else if (c.type === 'modifierUp') bump(mods, c.mod, -1);
    else if (c.type === 'mouseButton') bump(mouse, c.button, c.down ? 1 : -1);
    else if (c.type === 'driveStart') {
      drives++;
      expect(drives).toBe(1);
    } else if (c.type === 'driveEnd') {
      drives--;
      expect(drives).toBe(0);
    } else if (c.type === 'driveDelta') expect(drives).toBe(1);
  }
  for (const m of [keys, cmds, mods, mouse]) for (const v of m.values()) expect(v).toBe(0);
  expect(drives).toBe(0);
}

const holdProfile = testProfile(
  [
    { mode: 'edit', input: 'a', action: { type: 'key', combo: 'Mod+V', hold: true } },
    { mode: 'edit', input: 'b', action: { type: 'key', combo: 'Space', hold: true } },
    { mode: 'edit', input: 'x', action: { type: 'key', combo: 'Shift' } },
    { mode: 'edit', input: 'y', action: { type: 'key', combo: 'Shift' } },
    { mode: 'edit', input: 'r3', action: { type: 'mouseButton', button: 'left' } },
    { mode: 'edit', input: 'l3', action: { type: 'command', id: 't.hold', hold: true } },
    { mode: 'edit', input: 'a', layer: 'trim', action: { type: 'key', combo: 'K', hold: true } },
    { mode: 'edit', input: 'dpadUp', action: { type: 'key', combo: 'K', hold: true } },
    { mode: 'edit', input: 'dpadDown', gesture: 'hold', action: { type: 'key', combo: 'H' } },
    { mode: 'edit', input: 'dpadDown', gesture: 'doubleTap', action: { type: 'key', combo: 'D' } },
    { mode: 'edit', input: 'dpadDown', action: { type: 'key', combo: 'T' } },
    { mode: 'edit', input: 'view', action: { type: 'key', combo: 'U', hold: true } },
    { mode: 'edit', input: 'menu', action: { type: 'key', combo: 'R', hold: true } },
    {
      mode: 'edit',
      input: 'rt',
      action: { type: 'shuttle', dir: 'forward', zones: [0.2, 0.5, 0.8], slowZone: true },
    },
    { mode: 'edit', input: 'lt', action: { type: 'key', combo: 'Q', hold: true } },
    { mode: 'edit', input: 'lstick.x', action: { type: 'jog', rate: { min: 2, max: 30 } } },
    { mode: 'edit', input: 'lstick.y', dir: 1, action: { type: 'key', combo: 'Z', hold: true } },
    { mode: 'edit', input: 'rstick', action: { type: 'mouseMove' } },
    { mode: 'color', input: 'lstick', action: { type: 'wheel', wheel: 'lift', part: 'balance' } },
    { mode: 'color', input: 'rstick', action: { type: 'wheel', wheel: 'gain', part: 'balance' } },
    { mode: 'color', input: 'rt', action: { type: 'wheel', wheel: 'active', part: 'master' } },
    { mode: 'color', input: 'a', action: { type: 'key', combo: 'Alt+S', hold: true } },
  ],
  {
    layers: [
      { id: 'trim', hold: 'lb', modes: ['edit'] },
      { id: 'alt', hold: 'lb', modes: ['color'] },
    ],
    fine: { hold: 'rb', modes: ['color'], multiplier: 0.25 },
    chords: [
      { inputs: ['dpadLeft', 'dpadRight'], action: { type: 'key', combo: 'C', hold: true } },
    ],
  },
);

/** What the random runs actually exercised; a property that never holds anything proves nothing. */
interface Coverage {
  runs: number;
  commands: number;
  holds: number;
  drives: number;
  modeChanges: number;
}

function tally(cov: Coverage, log: LogEntry[]): void {
  cov.runs++;
  cov.commands += log.length;
  for (const { command: c } of log) {
    if (
      c.type === 'keyDown' ||
      c.type === 'modifierDown' ||
      (c.type === 'mouseButton' && c.down) ||
      (c.type === 'command' && c.phase === 'down')
    )
      cov.holds++;
    else if (c.type === 'driveStart') cov.drives++;
    else if (c.type === 'modeChanged') cov.modeChanges++;
  }
}

const ops = fc.array(op, { minLength: 15, maxLength: 80 });

describe('properties', () => {
  it('hold-heavy profile: every down has an up, every DriveStart a DriveEnd, never two drives', () => {
    const cov: Coverage = { runs: 0, commands: 0, holds: 0, drives: 0, modeChanges: 0 };
    fc.assert(
      fc.property(ops, fc.constantFrom('edit', 'color'), (o, mode) => {
        const { log } = play(engineFor(holdProfile, mode), build(o, 1000));
        checkBalanced(log);
        tally(cov, log);
      }),
      { numRuns: 400 },
    );
    console.log('properties/hold-heavy coverage', cov);
    expect(cov.runs).toBe(400);
    expect(cov.holds).toBeGreaterThan(400);
    expect(cov.drives).toBeGreaterThan(20);
    expect(cov.modeChanges).toBeGreaterThan(5);
  });

  it('shipped resolve-default profile: same invariants', () => {
    const cov: Coverage = { runs: 0, commands: 0, holds: 0, drives: 0, modeChanges: 0 };
    fc.assert(
      fc.property(ops, fc.constantFrom('edit', 'color'), (o, mode) => {
        const { log } = play(resolveEngine(mode), build(o, 1000));
        checkBalanced(log);
        tally(cov, log);
      }),
      { numRuns: 300 },
    );
    console.log('properties/resolve-default coverage', cov);
    expect(cov.runs).toBe(300);
    expect(cov.holds).toBeGreaterThan(20);
    expect(cov.drives).toBeGreaterThan(20);
    expect(cov.modeChanges).toBeGreaterThan(5);
  });
});
