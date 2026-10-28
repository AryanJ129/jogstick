/**
 * One describe per engine-semantics item in BUILD_BRIEF.md (§1 lives in axes.test.ts);
 * one test per clause.
 */
import { describe, expect, it } from 'vitest';
import { step } from '../src/engine';
import { jogRate } from '../src/transport';
import { compileProfile } from '../src/profile';
import type { LogEntry } from '../src/replay';
import { chord, layerHoldWithKeyDown, quickTap } from './generators';
import {
  Timeline,
  count,
  engineFor,
  ids,
  lines,
  must,
  ofType,
  play,
  resolveEngine,
  testProfile,
} from './helpers';

const keyHold = (combo: string) => ({ type: 'key' as const, combo, hold: true });
const cmd = (id: string) => ({ type: 'command' as const, id });
const after = (log: LogEntry[], t: number) => log.filter((l) => l.now > t);
const before = (log: LogEntry[], t: number) => log.filter((l) => l.now < t);

describe('§2 axis lock', () => {
  it('a mostly-X push locks to X and jogs without zooming, even when Y later grows', () => {
    const tl = new Timeline()
      .stick('lstick', 0.8, 0.4)
      .wait(200)
      .stick('lstick', 0.6, 0.75)
      .wait(300);
    const { log } = play(resolveEngine(), tl);
    expect(ids(log).filter((i) => i.startsWith('view.zoom'))).toEqual([]);
    expect(ids(log).filter((i) => i === 'nav.stepFrameForward').length).toBeGreaterThan(3);
  });

  it('locks immediately when |a| ≥ axisLockRatio·|b|', () => {
    const tl = new Timeline().stick('lstick', 0.8, 0.5).wait(8);
    const { log } = play(resolveEngine(), tl);
    expect(log[0]?.now).toBe(1008);
    expect(ids(log)).toEqual(['nav.stepFrameForward']);
  });

  it('near-diagonal: nothing fires until 40 ms, then it locks to the larger axis', () => {
    const tl = new Timeline().stick('lstick', 0.6, 0.55).wait(100);
    const { log } = play(resolveEngine(), tl);
    const first = log.find((l) => l.command.type === 'command');
    expect(first?.now).toBe(1048); // engaged on the 1008 tick, locked on the first tick ≥ 1048
    expect(ids(log)[0]).toBe('nav.stepFrameForward');
  });

  it('stays locked until the stick returns inside the deadzone, then re-decides', () => {
    const tl = new Timeline().stick('lstick', 0.8, 0).wait(50).stick('lstick', 0, 0.9).wait(400);
    const { log } = play(resolveEngine(), tl);
    // Pushing straight down while X-locked: X is 0 → jog stops, Y ignored.
    expect(ids(log).filter((i) => i.startsWith('view.zoom'))).toEqual([]);
    const tl2 = new Timeline()
      .stick('lstick', 0.8, 0)
      .wait(50)
      .stick('lstick', 0, 0)
      .wait(16)
      .stick('lstick', 0, 0.9)
      .wait(400);
    const r2 = play(resolveEngine(), tl2);
    expect(ids(r2.log)).toContain('view.zoomOut');
  });

  it('2-D bindings (mouse, wheel balance) are never axis-locked', () => {
    const tl = new Timeline().stick('rstick', 0.7, 0.7).wait(200);
    const moves = ofType(play(resolveEngine(), tl).log, 'mouseMove');
    expect(moves.some((m) => m.dx !== 0 && m.dy !== 0)).toBe(true);
  });
});

describe('§3 digital vs analog paths', () => {
  it('buttons are edge events processed on the frame they change', () => {
    const s = resolveEngine();
    const r = step(
      s,
      {
        kind: 'frame',
        frame: { t: 0, buttons: [1, ...Array<number>(16).fill(0)], axes: [0, 0, 0, 0] },
      },
      0,
    );
    expect(r.commands).toEqual([
      { type: 'command', id: 'edit.splitClip', phase: 'tap', mods: [], owner: 'a#1' },
    ]);
  });

  it('sticks are cached on frames and consumed on the tick', () => {
    const s = resolveEngine();
    const f = step(
      s,
      { kind: 'frame', frame: { t: 0, buttons: Array<number>(17).fill(0), axes: [0.9, 0, 0, 0] } },
      0,
    );
    expect(f.commands).toEqual([]);
    expect(f.tick).toBe(true);
    const t = step(f.state, { kind: 'tick' }, 8);
    expect(t.commands.map((c) => c.type === 'command' && c.id)).toContain('nav.stepFrameForward');
  });

  it('buttons count as pressed above 0.5', () => {
    const tl = new Timeline().value('a', 0.5).wait(10).value('a', 0).value('a', 0.51);
    expect(ids(play(resolveEngine(), tl).log)).toEqual(['edit.splitClip']);
  });

  it('digitally bound triggers use a threshold with edge detection both ways (press > 0.5, release < 0.4)', () => {
    const p = testProfile([{ mode: 'edit', input: 'lt', action: keyHold('Q') }]);
    const tl = new Timeline()
      .value('lt', 0.45)
      .wait(10)
      .value('lt', 0.55)
      .wait(10)
      .value('lt', 0.45)
      .wait(10)
      .value('lt', 0.39)
      .wait(10)
      .value('lt', 0.45)
      .wait(10)
      .value('lt', 0.6);
    expect(lines(play(engineFor(p), tl).log)).toEqual([
      'keyDown KeyQ (lt#1)',
      'keyUp KeyQ (lt#1)',
      'keyDown KeyQ (lt#2)',
    ]);
  });
});

describe('§4 resolve at press, release what you pressed', () => {
  const p = testProfile(
    [
      { mode: 'edit', input: 'a', action: keyHold('A') },
      { mode: 'edit', input: 'a', layer: 'trim', action: keyHold('B') },
      { mode: 'color', input: 'a', action: keyHold('C') },
    ],
    { layers: [{ id: 'trim', hold: 'lb' }] },
  );

  it('the action is resolved at press (mode + layers at that instant)', () => {
    const { log } = play(engineFor(p), layerHoldWithKeyDown(new Timeline(), 'lb', 'a'));
    expect(lines(log)).toEqual([
      'layerChanged [trim]',
      'keyDown KeyB (a#1)',
      'layerChanged []',
      'keyUp KeyB (a#1)',
    ]);
  });

  it('a layer pressed mid-hold does not change what the release sends', () => {
    const tl = new Timeline()
      .press('a')
      .wait(20)
      .press('lb')
      .wait(20)
      .release('a')
      .wait(20)
      .release('lb');
    expect(lines(play(engineFor(p), tl).log)).toEqual([
      'keyDown KeyA (a#1)',
      'layerChanged [trim]',
      'keyUp KeyA (a#1)',
      'layerChanged []',
    ]);
  });

  it('changing mode mid-hold releases the held key once; the physical release sends nothing', () => {
    const tl = new Timeline().press('a').wait(20);
    tl.events.push({ now: tl.t, input: { kind: 'setMode', mode: 'color' } });
    tl.wait(20).release('a').wait(20);
    expect(lines(play(engineFor(p), tl).log)).toEqual([
      'keyDown KeyA (a#1)',
      'keyUp KeyA (a#1)',
      'modeChanged color',
      'haptic pulse',
    ]);
  });
});

describe('§5 layers', () => {
  const p = testProfile(
    [
      { mode: 'edit', input: 'a', action: cmd('base.a') },
      { mode: 'edit', input: 'a', layer: 'trim', action: cmd('trim.a') },
      { mode: 'edit', input: 'a', layer: 'mark', action: cmd('mark.a') },
      { mode: 'edit', input: 'x', layer: 'trim', action: cmd('trim.x') },
      { mode: 'edit', input: 'dpadUp', action: cmd('base.up') },
      { mode: 'edit', input: 'y', action: { type: 'layerToggle', layer: 'trim' } },
      { mode: 'edit', input: 'b', layer: 'trim', action: keyHold('B') },
    ],
    {
      layers: [
        { id: 'trim', hold: 'lb' },
        { id: 'mark', hold: 'rb' },
      ],
    },
  );

  it('the activator is consumed: it emits only the layer change', () => {
    const { log } = play(engineFor(p), new Timeline().press('lb'));
    expect(lines(log)).toEqual(['layerChanged [trim]']);
  });

  it('layers are momentary by default', () => {
    const { log } = play(
      engineFor(p),
      new Timeline().press('lb').wait(10).release('lb').wait(10).press('a'),
    );
    expect(lines(log)).toEqual(['layerChanged [trim]', 'layerChanged []', 'command tap base.a']);
  });

  it('layerToggle latches', () => {
    const tl = new Timeline()
      .press('y')
      .release('y')
      .press('a')
      .release('a')
      .press('y')
      .release('y')
      .press('a');
    expect(lines(play(engineFor(p), tl).log)).toEqual([
      'layerChanged [trim]',
      'command tap trim.a',
      'layerChanged []',
      'command tap base.a',
    ]);
  });

  it('lookup: most recently activated layer → older layers → base', () => {
    const tl = new Timeline()
      .press('lb')
      .press('rb')
      .press('a')
      .release('a')
      .press('x')
      .release('x')
      .press('dpadUp');
    expect(ids(play(engineFor(p), tl).log)).toEqual(['mark.a', 'trim.x', 'base.up']);
  });

  it('a layer can be limited to modes (Resolve: LB is TRIM in Edit, ALT in Color)', () => {
    expect(lines(play(resolveEngine('edit'), new Timeline().press('lb')).log)).toEqual([
      'layerChanged [trim]',
    ]);
    expect(lines(play(resolveEngine('color'), new Timeline().press('lb')).log)).toEqual([
      'layerChanged [alt]',
    ]);
  });

  it('a mode switch clears layers after releaseAll', () => {
    const tl = new Timeline().press('lb').press('b').wait(10);
    tl.events.push({ now: tl.t, input: { kind: 'setMode', mode: 'color' } });
    expect(lines(play(engineFor(p), tl).log)).toEqual([
      'layerChanged [trim]',
      'keyDown KeyB (b#1)',
      'keyUp KeyB (b#1)',
      'layerChanged []',
      'modeChanged color',
      'haptic pulse',
    ]);
  });
});

describe('§6 chords', () => {
  const p = testProfile(
    [
      { mode: 'edit', input: 'a', action: cmd('t.a') },
      { mode: 'edit', input: 'view', action: keyHold('U') },
      { mode: 'edit', input: 'menu', action: cmd('t.menu') },
      { mode: 'edit', input: 'dpadUp', action: cmd('t.up') },
    ],
    {
      chords: [
        { inputs: ['dpadLeft', 'dpadRight'], action: keyHold('Q') },
        { inputs: ['dpadLeft', 'dpadRight', 'dpadDown'], action: keyHold('W') },
      ],
    },
  );

  it('inputs that are not chord participants fire immediately', () => {
    const s = engineFor(p);
    const r = step(
      s,
      {
        kind: 'frame',
        frame: { t: 0, buttons: [1, ...Array<number>(16).fill(0)], axes: [0, 0, 0, 0] },
      },
      0,
    );
    expect(r.commands.map((c) => c.type)).toEqual(['command']);
  });

  it('participants are deferred by chordWindowMs', () => {
    const tl = new Timeline().press('view').wait(100);
    const { log } = play(engineFor(p), tl);
    expect(log.map((l) => l.now)).toEqual([1064]); // first tick at or after 1000 + 60
    const r = step(
      engineFor(p),
      {
        kind: 'frame',
        frame: {
          t: 0,
          buttons: Array.from({ length: 17 }, (_, i) => (i === 8 ? 1 : 0)),
          axes: [0, 0, 0, 0],
        },
      },
      0,
    );
    expect(r.wakeAt).toBe(60);
  });

  it('matches the exact set of pressed participants, in any order, within the window', () => {
    const tl = new Timeline()
      .press('menu')
      .wait(20)
      .press('view')
      .wait(20)
      .release('menu', 'view')
      .wait(100);
    expect(lines(play(engineFor(p), tl).log)).toEqual(['modeChanged color', 'haptic pulse']);
  });

  it('no chord when the second participant arrives after the window', () => {
    const tl = new Timeline()
      .press('view')
      .wait(70)
      .press('menu')
      .wait(100)
      .release('view', 'menu')
      .wait(100);
    const { log, state } = play(engineFor(p), tl);
    expect(state.mode).toBe('edit');
    expect(lines(log)).toEqual([
      'keyDown KeyU (view#1)',
      'command tap t.menu',
      'keyUp KeyU (view#1)',
    ]);
  });

  it('a larger chord replaces a smaller one and releases it', () => {
    const tl = new Timeline()
      .press('dpadLeft')
      .wait(10)
      .press('dpadRight')
      .wait(10)
      .press('dpadDown')
      .wait(100);
    tl.release('dpadLeft', 'dpadRight', 'dpadDown').wait(100);
    expect(lines(play(engineFor(p), tl).log)).toEqual([
      'keyDown KeyQ (chord#1)',
      'keyUp KeyQ (chord#1)',
      'keyDown KeyW (chord#2)',
      'keyUp KeyW (chord#2)',
    ]);
  });

  it('releases inside the window are parked and replayed after the press dispatch (no stuck key)', () => {
    const tl = quickTap(new Timeline(), 'view', 20).wait(100);
    const { log, state } = play(engineFor(p), tl);
    expect(log.map((l) => `${l.now} ${lines([l])[0]}`)).toEqual([
      '1064 keyDown KeyU (view#1)',
      '1064 keyUp KeyU (view#1)',
    ]);
    expect(state.keys).toEqual([]);
  });

  it('a quick chord tap is parked too: mode switch fires once, nothing is left held', () => {
    const { log, state } = play(engineFor(p), chord(new Timeline(), ['view', 'menu'], 10, 5));
    expect(lines(log)).toEqual(['modeChanged color', 'haptic pulse']);
    expect(state.keys).toEqual([]);
  });
});

describe('§7 gestures', () => {
  const p = testProfile([
    { mode: 'edit', input: 'a', action: cmd('a.tap') },
    { mode: 'edit', input: 'a', gesture: 'hold', action: cmd('a.hold') },
    { mode: 'edit', input: 'b', action: cmd('b.tap') },
    { mode: 'edit', input: 'b', gesture: 'doubleTap', action: cmd('b.double') },
  ]);

  it('hold fires once at holdThresholdMs and suppresses the tap', () => {
    const { log } = play(engineFor(p), new Timeline().press('a').wait(800).release('a').wait(100));
    expect(log.map((l) => `${l.now} ${ids([l])[0]}`)).toEqual(['1304 a.hold']);
  });

  it('tap with a sibling hold fires on release before the threshold', () => {
    const { log } = play(engineFor(p), quickTap(new Timeline(), 'a', 100).wait(500));
    expect(log.map((l) => `${l.now} ${ids([l])[0]}`)).toEqual(['1100 a.tap']);
  });

  it('doubleTap defers the single tap by the window', () => {
    const { log } = play(engineFor(p), quickTap(new Timeline(), 'b', 50).wait(400));
    expect(log.map((l) => `${l.now} ${ids([l])[0]}`)).toEqual(['1304 b.tap']); // released at 1050, window 250
  });

  it('the second press cancels the single tap and fires the double tap', () => {
    const tl = quickTap(new Timeline(), 'b', 50)
      .wait(100)
      .press('b')
      .wait(30)
      .release('b')
      .wait(400);
    const { log } = play(engineFor(p), tl);
    expect(log.map((l) => `${l.now} ${ids([l])[0]}`)).toEqual(['1150 b.double']);
  });
});

describe('§8 jog', () => {
  const jogProfile = (
    extra: Record<string, unknown> = {},
    settings: Record<string, unknown> = { hapticDetents: false },
  ) =>
    testProfile(
      [
        {
          mode: 'edit',
          input: 'lstick.x',
          action: {
            type: 'jog',
            rate: { min: 2, max: 30, curve: 'linear' },
            fastAtEdge: true,
            ...extra,
          },
        },
      ],
      { settings },
    );
  const steps = (log: LogEntry[]) =>
    log.filter((l) => l.command.type === 'command' && l.command.id.startsWith('nav.step'));

  it('rate r = min + (max − min)·curve(d)', () => {
    const b = must(compileProfile(jogProfile()).bindings[0]);
    expect(jogRate(b, 0)).toBe(2);
    expect(jogRate(b, 0.5)).toBe(16);
    expect(jogRate(b, 1)).toBe(30);
    const q = must(
      compileProfile(jogProfile({ rate: { min: 2, max: 30, curve: 'quad' } })).bindings[0],
    );
    expect(jogRate(q, 0.5)).toBe(9);
  });

  it('one step every 1000/r ms from a time accumulator: exact count under jittery ticks', () => {
    const tl = new Timeline({ tickPattern: [8, 16, 11, 9, 15] })
      .stick('lstick', 0.55, 0)
      .wait(3000);
    const s = steps(play(engineFor(jogProfile()), tl).log);
    const first = must(s[0]).now;
    const lastTick = tl.t - ((tl.t - first) % 1); // ticks end at or before tl.t
    const tickTimes = tl.events.filter((e) => e.input.kind === 'tick').map((e) => e.now);
    const last = Math.max(...tickTimes.filter((t) => t <= lastTick));
    const b = must(compileProfile(jogProfile()).bindings[0]);
    const interval = 1000 / jogRate(b, (0.55 - 0.12) / (0.98 - 0.12));
    expect(s.length).toBe(1 + Math.floor((last - first) / interval));
    expect(new Set(s.map((l) => (l.command as { id: string }).id))).toEqual(
      new Set(['nav.stepFrameForward']),
    );
  });

  it('negative deflection steps backward', () => {
    const s = steps(
      play(engineFor(jogProfile()), new Timeline().stick('lstick', -0.55, 0).wait(200)).log,
    );
    expect(s.every((l) => (l.command as { id: string }).id === 'nav.stepFrameBackward')).toBe(true);
  });

  it('fastAtEdge: d ≥ 0.98 steps one second at 6 Hz', () => {
    const tl = new Timeline().stick('lstick', 1, 0).wait(1000);
    const s = steps(play(engineFor(jogProfile()), tl).log);
    expect(s.every((l) => (l.command as { id: string }).id === 'nav.stepSecondForward')).toBe(true);
    expect(s.length).toBe(1 + Math.floor((1000 - 8) / (1000 / 6)));
  });

  it('return to the deadzone stops instantly, with no trailing steps', () => {
    const tl = new Timeline().stick('lstick', 0.9, 0).wait(203).stick('lstick', 0.05, 0);
    const centeredAt = tl.t;
    tl.wait(500);
    expect(after(steps(play(engineFor(jogProfile()), tl).log), centeredAt - 1).length).toBe(0);
  });

  it('haptic detents: one tick per frame step while r ≤ 8 fps', () => {
    const slow = new Timeline().stick('lstick', 0.2, 0).wait(1000);
    const log = play(engineFor(jogProfile({}, { hapticDetents: true })), slow).log;
    expect(count(log, (c) => c.type === 'haptic' && c.kind === 'detent')).toBe(steps(log).length);
    const fast = play(
      engineFor(jogProfile({}, { hapticDetents: true })),
      new Timeline().stick('lstick', 0.8, 0).wait(500),
    ).log;
    expect(count(fast, (c) => c.type === 'haptic')).toBe(0);
    const off = play(
      engineFor(jogProfile({}, { hapticDetents: false })),
      new Timeline().stick('lstick', 0.2, 0).wait(500),
    ).log;
    expect(count(off, (c) => c.type === 'haptic')).toBe(0);
  });
});

describe('§9 shuttle', () => {
  const shuttle = (slowZone: boolean) =>
    testProfile([
      {
        mode: 'edit',
        input: 'rt',
        action: { type: 'shuttle', dir: 'forward', zones: [0.15, 0.45, 0.75], slowZone },
      },
      {
        mode: 'edit',
        input: 'lt',
        action: { type: 'shuttle', dir: 'reverse', zones: [0.15, 0.45, 0.75], slowZone },
      },
    ]);
  const show = (log: LogEntry[]) => log.map((l) => must(lines([l])[0]).replace('command ', ''));

  it('zone n: K then L×n, after an 80 ms debounce', () => {
    const tl = new Timeline().value('rt', 0.5).wait(200);
    const { log } = play(engineFor(shuttle(false)), tl);
    expect(before(log, 1080)).toEqual([]);
    expect(show(log)).toEqual([
      'tap transport.stop',
      'tap transport.playForward',
      'tap transport.playForward',
    ]);
    expect(must(log[0]).now).toBe(1088); // first seen on the 1008 tick
  });

  it('zone changes are debounced: a 40 ms blip into another zone does nothing', () => {
    const tl = new Timeline()
      .value('rt', 0.2)
      .wait(200)
      .value('rt', 0.9)
      .wait(40)
      .value('rt', 0.2)
      .wait(200);
    expect(show(play(engineFor(shuttle(false)), tl).log)).toEqual([
      'tap transport.stop',
      'tap transport.playForward',
    ]);
  });

  it('moving up a zone re-sends K then L×n', () => {
    const tl = new Timeline().value('rt', 0.2).wait(200).value('rt', 0.8).wait(200);
    expect(show(play(engineFor(shuttle(false)), tl).log)).toEqual([
      'tap transport.stop',
      'tap transport.playForward',
      'tap transport.stop',
      'tap transport.playForward',
      'tap transport.playForward',
      'tap transport.playForward',
    ]);
  });

  it('reverse uses J', () => {
    expect(
      show(play(engineFor(shuttle(false)), new Timeline().value('lt', 0.2).wait(200)).log),
    ).toEqual(['tap transport.stop', 'tap transport.playReverse']);
  });

  it('slowZone: the lightest zone is K held + L held (J+K for reverse), K first', () => {
    expect(
      show(play(engineFor(shuttle(true)), new Timeline().value('rt', 0.2).wait(200)).log),
    ).toEqual(['down transport.stop', 'down transport.playForward']);
    expect(
      show(play(engineFor(shuttle(true)), new Timeline().value('lt', 0.2).wait(200)).log),
    ).toEqual(['down transport.stop', 'down transport.playReverse']);
  });

  it('slowZone shifts the faster zones: zone n sends L×(n−1)', () => {
    const tl = new Timeline().value('rt', 0.2).wait(200).value('rt', 0.8).wait(200);
    expect(show(play(engineFor(shuttle(true)), tl).log)).toEqual([
      'down transport.stop',
      'down transport.playForward',
      'up transport.playForward',
      'up transport.stop',
      'tap transport.stop',
      'tap transport.playForward',
      'tap transport.playForward',
    ]);
  });

  it('release below the first zone: release held keys, then K (immediately)', () => {
    const tl = new Timeline().value('rt', 0.2).wait(200).value('rt', 0.05);
    const releasedAt = tl.t;
    tl.wait(100);
    const { log } = play(engineFor(shuttle(true)), tl);
    const tail = after(log, releasedAt - 1);
    expect(show(tail)).toEqual([
      'up transport.playForward',
      'up transport.stop',
      'tap transport.stop',
    ]);
    expect(must(tail[0]).now - releasedAt).toBeLessThanOrEqual(8);
  });

  it('the later-pulled trigger wins; the other is treated as released until it returns below zone 1', () => {
    const tl = new Timeline()
      .value('rt', 0.5)
      .wait(200)
      .value('lt', 0.2)
      .wait(200)
      .value('rt', 0)
      .wait(50)
      .value('rt', 0.5)
      .wait(200);
    expect(show(play(engineFor(shuttle(false)), tl).log)).toEqual([
      'tap transport.stop',
      'tap transport.playForward',
      'tap transport.playForward',
      'tap transport.stop',
      'tap transport.playReverse',
      // rt dropped to 0 (nothing: it was already released by the handover), then re-pulled: it wins again.
      'tap transport.stop',
      'tap transport.playForward',
      'tap transport.playForward',
    ]);
  });
});

describe('§10 jog / shuttle arbitration', () => {
  it('starting a jog while shuttling sends K and ends the shuttle first', () => {
    const tl = new Timeline().value('rt', 0.5).wait(200).stick('lstick', 0.6, 0).wait(50);
    const { log } = play(resolveEngine(), tl);
    const tail = after(log, 1200);
    expect(ids(tail).slice(0, 2)).toEqual(['transport.stop', 'nav.stepFrameForward']);
  });

  it('pulling a trigger while jogging ends the jog until the stick returns to the deadzone', () => {
    const tl = new Timeline().stick('lstick', 0.6, 0).wait(200).value('rt', 0.5).wait(500);
    const { log } = play(resolveEngine(), tl);
    const shuttleStart = must(
      log.find((l) => l.command.type === 'command' && l.command.id === 'transport.stop'),
    ).now;
    expect(ids(after(log, shuttleStart)).filter((i) => i.startsWith('nav.step'))).toEqual([]);
  });
});

describe('§11 repeat', () => {
  it('frame step repeats 300/60 while held', () => {
    const tl = new Timeline().press('dpadRight').wait(1000).release('dpadRight').wait(300);
    expect(ids(play(resolveEngine(), tl).log).length).toBe(1 + 12); // 300, 360, …, 960
  });

  it('undo/redo repeat 400/120 (after the 60 ms chord deferral of View)', () => {
    const tl = new Timeline().press('view').wait(1000).release('view').wait(300);
    const undo = ids(play(resolveEngine(), tl).log);
    expect(undo).toEqual(Array<string>(6).fill('edit.undo')); // 1060, 1460, 1580, 1700, 1820, 1940
  });

  it('repeat stops on release', () => {
    const tl = new Timeline().press('dpadRight').wait(500).release('dpadRight');
    const releasedAt = tl.t;
    tl.wait(500);
    expect(after(play(resolveEngine(), tl).log, releasedAt)).toEqual([]);
  });
});

describe('§12 modifiers', () => {
  it('bare-modifier bindings hold the modifier, ref-counted', () => {
    const p = testProfile([
      { mode: 'edit', input: 'lb', action: { type: 'key', combo: 'Shift' } },
      { mode: 'edit', input: 'rb', action: { type: 'key', combo: 'Shift' } },
    ]);
    const tl = new Timeline().press('lb').press('rb').release('lb').release('rb');
    expect(lines(play(engineFor(p), tl).log)).toEqual(['modifierDown Shift', 'modifierUp Shift']);
  });

  it("key events carry their own binding's mods plus standalone-held ones, never another held binding's", () => {
    const p = testProfile([
      { mode: 'edit', input: 'a', action: keyHold('Mod+V') },
      { mode: 'edit', input: 'b', action: { type: 'key', combo: 'Space' } },
      { mode: 'edit', input: 'x', action: { type: 'key', combo: 'Shift' } },
    ]);
    const tl = new Timeline().press('a').press('b').release('b').press('x').press('b');
    expect(ofType(play(engineFor(p), tl).log, 'keyDown').map((k) => [k.code, k.mods])).toEqual([
      ['KeyV', ['Mod']],
      ['Space', []],
      ['Space', ['Shift']],
    ]);
  });

  it('key holds are owner-tagged: the key stays down until its last owner releases', () => {
    const p = testProfile([
      { mode: 'edit', input: 'a', action: keyHold('K') },
      { mode: 'edit', input: 'b', action: keyHold('K') },
    ]);
    const tl = new Timeline().press('a').press('b').release('a').release('b');
    expect(lines(play(engineFor(p), tl).log)).toEqual([
      'keyDown KeyK (a#1)',
      'keyUp KeyK (a#1)'.replace('a#1', 'b#2'),
    ]);
  });
});

describe('§13 modes', () => {
  const p = testProfile(
    [
      {
        mode: 'color',
        input: 'lstick',
        action: { type: 'wheel', wheel: 'lift', part: 'balance', curve: 'linear' },
      },
      { mode: 'color', input: 'a', action: keyHold('A') },
    ],
    { layers: [{ id: 'alt', hold: 'lb', modes: ['color'] }] },
  );

  it('exactly one mode is active; the chord cycles edit → color → edit', () => {
    const tl = chord(new Timeline(), ['view', 'menu'], 0, 10);
    const r1 = play(engineFor(p), tl);
    expect(r1.state.mode).toBe('color');
    const r2 = play(r1.state, chord(new Timeline({ start: 5000 }), ['menu', 'view'], 5, 10));
    expect(r2.state.mode).toBe('edit');
  });

  it('switch: releaseAll (drive end, keys), clear layers, haptic pulse, mode changed', () => {
    const tl = new Timeline().press('lb').press('a').stick('lstick', 0.8, 0).wait(100);
    tl.events.push({ now: tl.t, input: { kind: 'setMode', mode: 'edit' } });
    const { log } = play(engineFor(p, 'color'), tl);
    const tail = lines(log).slice(lines(log).indexOf('driveEnd'));
    expect(tail).toEqual([
      'driveEnd',
      'keyUp KeyA (a#1)',
      'layerChanged []',
      'modeChanged edit',
      'haptic pulse',
    ]);
  });

  it('switching to the current mode does nothing', () => {
    const r = step(engineFor(p), { kind: 'setMode', mode: 'edit' }, 0);
    expect(r.commands).toEqual([]);
  });
});

describe('§14 gate', () => {
  const p = testProfile([
    { mode: 'edit', input: 'a', action: keyHold('A') },
    { mode: 'edit', input: 'b', action: cmd('t.b') },
    { mode: 'edit', input: 'rstick', action: { type: 'mouseMove', speed: 1000, curve: 'linear' } },
  ]);

  it('gate loss: releaseAll and end the drive', () => {
    const tl = new Timeline().press('a').wait(20).gate(false);
    expect(lines(play(engineFor(p), tl).log)).toEqual(['keyDown KeyA (a#1)', 'keyUp KeyA (a#1)']);
    const c = testProfile([
      { mode: 'color', input: 'lstick', action: { type: 'wheel', wheel: 'lift', part: 'balance' } },
    ]);
    const d = play(
      engineFor(c, 'color'),
      new Timeline().stick('lstick', 0.9, 0).wait(50).gate(false).wait(100),
    ).log;
    expect(lines(d).filter((l) => l.startsWith('drive') && !l.startsWith('driveDelta'))).toEqual([
      'driveStart lift balance (lstick)',
      'driveEnd',
    ]);
  });

  it('frames are dropped while gated, and polling continues', () => {
    const tl = new Timeline().gate(false).press('b').release('b').stick('rstick', 0.9, 0).wait(100);
    expect(play(engineFor(p), tl).log).toEqual([]);
  });

  it('re-arm: inputs held across the gate are consumed; sticks wait for the deadzone', () => {
    const tl = new Timeline()
      .gate(false)
      .press('a')
      .stick('rstick', 0.9, 0)
      .wait(30)
      .gate(true)
      .wait(100)
      .release('a')
      .wait(20);
    expect(play(engineFor(p), tl).log).toEqual([]);
    tl.stick('rstick', 0, 0).wait(20).stick('rstick', 0.9, 0).wait(100).press('b');
    const after2 = play(engineFor(p), tl).log;
    expect(after2.some((l) => l.command.type === 'mouseMove')).toBe(true);
    expect(ids(after2)).toEqual(['t.b']);
  });
});

describe('§15 safety', () => {
  const p = testProfile([
    { mode: 'edit', input: 'r3', action: { type: 'mouseButton', button: 'left' } },
    { mode: 'edit', input: 'a', action: keyHold('A') },
    { mode: 'edit', input: 'lb', action: { type: 'key', combo: 'Alt' } },
    { mode: 'edit', input: 'b', action: { type: 'command', id: 't.hold', hold: true } },
  ]);
  const holdAll = () => new Timeline().press('lb').press('a').press('b').press('r3').wait(20);

  it('releaseAll order: mouse buttons → keys → modifiers', () => {
    const tl = holdAll().releaseAll('sleep');
    const tail = lines(play(engineFor(p), tl).log).slice(4);
    expect(tail).toEqual([
      'mouseButton left up',
      'command up t.hold',
      'keyUp KeyA (a#2)',
      'modifierUp Alt',
    ]);
  });

  it('controller disconnect releases everything; the next frame starts clean', () => {
    const tl = holdAll().disconnect().wait(10).neutral().wait(10);
    const { log, state } = play(engineFor(p), tl);
    expect(lines(log).slice(4)).toEqual([
      'mouseButton left up',
      'command up t.hold',
      'keyUp KeyA (a#2)',
      'modifierUp Alt',
    ]);
    expect([state.keys, state.mods, state.mouse, state.cmdHolds]).toEqual([[], [], [], []]);
  });

  it('after releaseAll the still-held buttons are consumed: their release emits nothing', () => {
    const tl = holdAll().releaseAll('exception');
    const n = play(engineFor(p), tl).log.length;
    tl.release('lb', 'a', 'b', 'r3').wait(20);
    expect(play(engineFor(p), tl).log.length).toBe(n);
  });
});

describe('§16 wheel drive', () => {
  const wheels = (extra: Record<string, unknown> = {}) =>
    testProfile(
      [
        {
          mode: 'color',
          input: 'lstick',
          action: { type: 'wheel', wheel: 'lift', part: 'balance', curve: 'linear' },
        },
        {
          mode: 'color',
          input: 'rstick',
          action: { type: 'wheel', wheel: 'gain', part: 'balance', curve: 'linear' },
        },
        {
          mode: 'color',
          input: 'rt',
          action: { type: 'wheel', wheel: 'active', part: 'master', dir: 1, curve: 'linear' },
        },
        {
          mode: 'color',
          input: 'lt',
          action: { type: 'wheel', wheel: 'active', part: 'master', dir: -1, curve: 'linear' },
        },
      ],
      { fine: { hold: 'rb', multiplier: 0.25 }, ...extra },
    );
  const sumDx = (log: LogEntry[]) => ofType(log, 'driveDelta').reduce((s, d) => s + d.dx, 0);

  it('DriveStart{wheel, part} when the input leaves the deadzone', () => {
    const { log } = play(
      engineFor(wheels(), 'color'),
      new Timeline().stick('lstick', 0.9, 0).wait(8),
    );
    expect(lines(log)).toEqual(['driveStart lift balance (lstick)']);
  });

  it('DriveDelta each tick at gain·curve(d)·baseSpeed, sub-pixel accumulated', () => {
    const tl = new Timeline().stick('lstick', 1, 0).wait(1008);
    const { log } = play(engineFor(wheels(), 'color'), tl);
    const start = must(log[0]).now;
    const expected = (300 * (tl.t - start)) / 1000;
    expect(Math.abs(sumDx(log) - expected)).toBeLessThan(1);
  });

  it('sub-pixel velocities still accumulate (no per-tick truncation loss)', () => {
    const raw = 0.12 + 0.86 * 0.1; // d = 0.1 → 30 px/s → 0.24 px per 8 ms tick
    const tl = new Timeline().stick('lstick', raw, 0).wait(2008);
    const { log } = play(engineFor(wheels(), 'color'), tl);
    expect(Math.abs(sumDx(log) - (30 * (tl.t - must(log[0]).now)) / 1000)).toBeLessThan(1);
  });

  it('RB held = fine: × multiplier', () => {
    const tl = new Timeline().press('rb').stick('lstick', 1, 0).wait(1008);
    const { log } = play(engineFor(wheels(), 'color'), tl);
    const start = must(log.find((l) => l.command.type === 'driveStart')).now;
    expect(Math.abs(sumDx(log) - (75 * (tl.t - start)) / 1000)).toBeLessThan(1);
  });

  it('DriveEnd on return to the deadzone', () => {
    const tl = new Timeline().stick('lstick', 0.9, 0).wait(100).stick('lstick', 0.1, 0).wait(16);
    expect(lines(play(engineFor(wheels(), 'color'), tl).log).at(-1)).toBe('driveEnd');
  });

  it('one cursor, one drive: other wheel inputs are ignored until the drive ends + 100 ms', () => {
    const tl = new Timeline()
      .stick('lstick', 0.9, 0)
      .wait(50)
      .stick('rstick', 0.9, 0)
      .value('rt', 0.9)
      .wait(100)
      .stick('lstick', 0, 0);
    const endAt = tl.t;
    tl.wait(200);
    const { log } = play(engineFor(wheels(), 'color'), tl);
    const starts = log.filter((l) => l.command.type === 'driveStart');
    expect(starts.map((l) => lines([l])[0])).toEqual([
      'driveStart lift balance (lstick)',
      'driveStart gain balance (rstick)',
    ]);
    expect(must(starts[1]).now - endAt).toBeGreaterThanOrEqual(100);
    // never two drives at once
    let active = 0;
    for (const l of log) {
      if (l.command.type === 'driveStart') active++;
      if (l.command.type === 'driveEnd') active--;
      expect(active).toBeLessThanOrEqual(1);
    }
  });

  it('wheel "active" targets the wheel most recently driven by a stick (default gain)', () => {
    const first = play(
      engineFor(wheels(), 'color'),
      new Timeline().value('rt', 0.9).wait(50).value('rt', 0).wait(200),
    );
    expect(lines(first.log)[0]).toBe('driveStart gain master (rt)');
    const tl = new Timeline({ start: 5000 })
      .stick('lstick', 0.9, 0)
      .wait(50)
      .stick('lstick', 0, 0)
      .wait(200)
      .value('lt', 0.9)
      .wait(100);
    const second = play(first.state, tl);
    expect(lines(second.log).filter((l) => l.startsWith('driveStart'))).toEqual([
      'driveStart lift balance (lstick)',
      'driveStart lift master (lt)',
    ]);
  });

  it('master drags are horizontal, signed by dir', () => {
    const { log } = play(engineFor(wheels(), 'color'), new Timeline().value('lt', 1).wait(500));
    const deltas = ofType(log, 'driveDelta');
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.dx < 0 && d.dy === 0)).toBe(true);
  });
});
