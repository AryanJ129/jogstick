import { describe, expect, it } from 'vitest';
import { ComboWriter, OutputQueue } from '../src/main/queue';
import type { Clock, Op, Sink } from '../src/main/queue';

function rig(canInject = () => true) {
  const events: string[] = [];
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const clock: Clock = {
    setTimeout: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  const at = (s: string) => events.push(`${now} ${s}`);
  const sink: Sink = {
    modifierChanged: (m) => at(`mods ${m.join('+') || '-'}`),
    keyDown: (c, m) => at(`down ${[...m, c].join('+')}`),
    keyUp: (c, m) => at(`up ${[...m, c].join('+')}`),
    mouseButton: (b, d) => at(`mouse ${b} ${d ? 'down' : 'up'}`),
    mouseMoveRel: (dx, dy) => at(`move ${dx},${dy}`),
    scroll: (dx, dy) => at(`scroll ${dx},${dy}`),
  };
  const errors: unknown[] = [];
  const dropped: Op[] = [];
  const q = new OutputQueue(sink, clock, {
    canInject,
    onDropped: (op) => dropped.push(op),
    onError: (e) => errors.push(e),
  });
  return { q, events, advance, errors, dropped };
}

describe('ComboWriter + OutputQueue', () => {
  it('a modified combo: mods → 16 ms → down/up → 16 ms → mods back', () => {
    const { q, events, advance } = rig();
    const w = new ComboWriter(16);
    q.push(w.tap('KeyB', ['Cmd']));
    advance(100);
    expect(events).toEqual(['0 mods Cmd', '16 down Cmd+KeyB', '16 up Cmd+KeyB', '32 mods -']);
  });

  it('plain keys (jog arrows) skip the spacing but keep their place behind a combo', () => {
    const { q, events, advance } = rig();
    const w = new ComboWriter(16);
    q.push(w.tap('KeyB', ['Cmd']));
    q.push(w.tap('ArrowRight', []));
    q.push(w.tap('ArrowRight', []));
    expect(events).toEqual(['0 mods Cmd']);
    advance(100);
    expect(events.slice(3)).toEqual([
      '32 mods -',
      '32 down ArrowRight',
      '32 up ArrowRight',
      '32 down ArrowRight',
      '32 up ArrowRight',
    ]);
  });

  it('nothing interleaves with a combo in flight (a second combo waits its turn)', () => {
    const { q, events, advance } = rig();
    const w = new ComboWriter(16);
    q.push(w.tap('KeyV', ['Cmd']));
    advance(8);
    q.push(w.tap('Space', []));
    advance(100);
    expect(events).toEqual([
      '0 mods Cmd',
      '16 down Cmd+KeyV',
      '16 up Cmd+KeyV',
      '32 mods -',
      '32 down Space',
      '32 up Space',
    ]);
  });

  it('standalone modifiers become the base every later key carries', () => {
    const { q, events, advance } = rig();
    const w = new ComboWriter(16);
    q.push(w.modifier('Shift', true));
    q.push(w.tap('KeyZ', []));
    q.push(w.tap('KeyZ', ['Cmd']));
    q.push(w.modifier('Shift', false));
    advance(100);
    expect(events).toEqual([
      '0 mods Shift',
      '0 down Shift+KeyZ',
      '0 up Shift+KeyZ',
      '0 mods Shift+Cmd',
      '16 down Shift+Cmd+KeyZ',
      '16 up Shift+Cmd+KeyZ',
      '32 mods Shift',
      '32 mods -',
    ]);
  });

  it('a held combo lets its modifiers go right after the press', () => {
    const { q, events, advance } = rig();
    const w = new ComboWriter(16);
    q.push(w.down('KeyK', ['Shift']));
    q.push(w.up('KeyK'));
    advance(100);
    expect(events).toEqual(['0 mods Shift', '16 down Shift+KeyK', '32 mods -', '32 up KeyK']);
  });

  it('spacing 0 sends the combo in one go', () => {
    const { q, events } = rig();
    const w = new ComboWriter(0);
    q.push(w.tap('KeyB', ['Ctrl']));
    expect(events).toEqual(['0 mods Ctrl', '0 down Ctrl+KeyB', '0 up Ctrl+KeyB', '0 mods -']);
  });

  it('clear() drops pending entries, including the rest of an in-flight combo', () => {
    const { q, events, advance } = rig();
    const w = new ComboWriter(16);
    q.push(w.tap('KeyB', ['Cmd']));
    q.push(w.tap('ArrowRight', []));
    q.clear();
    advance(100);
    expect(events).toEqual(['0 mods Cmd']);
    expect(q.busy).toBe(false);
  });

  it('with the gate closed, presses are dropped but releases still go out', () => {
    let open = true;
    const { q, events, dropped } = rig(() => open);
    const w = new ComboWriter(0);
    q.push(w.down('KeyK', []));
    q.push([{ op: 'button', btn: 'left', down: true }]);
    open = false;
    q.push(w.up('KeyK'));
    q.push([{ op: 'button', btn: 'left', down: false }]);
    q.push(w.tap('KeyB', ['Cmd']));
    q.push([{ op: 'move', dx: 5, dy: 0 }]);
    expect(events).toEqual(['0 down KeyK', '0 mouse left down', '0 up KeyK', '0 mouse left up']);
    // The tap's key-up is dropped too: its key never went down (an up carries modifiers on macOS).
    expect(dropped.map((d) => d.op)).toEqual(['mods', 'keyDown', 'keyUp', 'move']);
  });

  it('a sink error clears the queue and reports it (the host then runs releaseAll)', () => {
    const { q, errors, events } = rig();
    const w = new ComboWriter(0);
    const bad: Sink = {
      modifierChanged: () => undefined,
      keyDown: () => {
        throw new Error('SendInput sent 0/1 events');
      },
      keyUp: () => events.push('up'),
      mouseButton: () => undefined,
      mouseMoveRel: () => undefined,
      scroll: () => undefined,
    };
    const q2 = new OutputQueue(
      bad,
      { setTimeout: () => 0, clearTimeout: () => undefined },
      {
        canInject: () => true,
        onError: (e) => errors.push(e),
      },
    );
    q2.push([...w.tap('KeyA', []), ...w.tap('KeyB', [])]);
    expect(errors).toHaveLength(1);
    expect(events).toEqual([]);
    expect(q2.length).toBe(0);
    void q;
  });
});
