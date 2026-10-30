import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import resolveDefault from '../../../packages/profiles/resolve-default.json';
import resolveKeymap from '../../../packages/profiles/resolve-keymap.json';
import { Host } from '../src/main/host';
import { Log } from '../src/main/log';
import type { FrontmostInfo, Native } from '../src/main/native';
import type { PadSink, PadSource } from '../src/main/pad';
import { Store } from '../src/main/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Standard-mapping button indices.
const [A, B, LB, VIEW, MENU, R3] = [0, 1, 4, 8, 9, 11] as const;

function fakeNative() {
  const calls: string[] = [];
  let frontCb: ((f: FrontmostInfo | null) => void) | null = null;
  let front: FrontmostInfo | null = null;
  const n = {
    nativeVersion: () => 'fake',
    isKnownCode: () => true,
    keyDown: (c: string, m: string[]) => calls.push(`down ${[...m, c].join('+')}`),
    keyUp: (c: string, m: string[]) => calls.push(`up ${[...m, c].join('+')}`),
    modifierChanged: (m: string[]) => calls.push(`mods ${m.join('+') || '-'}`),
    mouseMoveRel: (dx: number, dy: number) => calls.push(`move ${dx},${dy}`),
    mouseMoveTo: () => undefined,
    mouseButton: (b: string, d: boolean) => calls.push(`mouse ${b} ${d ? 'down' : 'up'}`),
    scroll: () => undefined,
    cursorPosition: () => [0, 0],
    releaseAll: () => calls.push('releaseAll'),
    releaseLeftovers: () => [],
    heldState: () => ({ keys: [], mods: [], buttons: [] }),
    osHeldState: () => ({ keys: [], mods: [], buttons: [] }),
    frontmostApp: () => front,
    onFrontmostChanged: (cb: (f: FrontmostInfo | null) => void) => {
      frontCb = cb;
    },
    offFrontmostChanged: () => undefined,
    isProcessElevated: () => null,
    isProcessRunning: () => false,
    axIsTrusted: () => true,
    openAxSettings: () => undefined,
    padStart: () => undefined,
    padStop: () => undefined,
    padRumble: () => undefined,
    padList: () => [],
  } satisfies Native;
  const setFront = (f: Partial<FrontmostInfo> | null) => {
    front = f && {
      id: 'com.blackmagic-design.DaVinciResolve',
      name: 'DaVinci Resolve',
      pid: 4242,
      isDialog: false,
      transient: false,
      ...f,
    };
    frontCb?.(front);
  };
  /** The foreground changes but the 25 ms watcher hasn't reported it yet. */
  const setFrontUnreported = (f: Partial<FrontmostInfo>) => {
    front = { ...(front as FrontmostInfo), ...f };
  };
  return { n, calls, setFront, setFrontUnreported };
}

class FakePad implements PadSource {
  readonly kind = 'replay';
  sink: PadSink | null = null;
  rumbles: string[] = [];
  starts = 0;
  start(sink: PadSink) {
    this.sink = sink;
    this.starts++;
    sink.connected('fake pad');
  }
  stop() {}
  rumble(kind: 'pulse' | 'detent') {
    this.rumbles.push(kind);
  }
}

let dir: string;
let log: Log;
let host: Host;
let fake: ReturnType<typeof fakeNative>;
let pad: FakePad;
const buttons = new Array<number>(17).fill(0);
const axes = [0, 0, 0, 0];

function sink(): PadSink {
  if (!pad.sink) throw new Error('pad not started');
  return pad.sink;
}
function press(...idx: number[]) {
  for (const i of idx) buttons[i] = 1;
  sink().frame([...buttons], [...axes]);
}
function release(...idx: number[]) {
  for (const i of idx) buttons[i] = 0;
  sink().frame([...buttons], [...axes]);
}
function tap(i: number) {
  press(i);
  vi.advanceTimersByTime(20);
  release(i);
  vi.advanceTimersByTime(100);
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  buttons.fill(0);
  axes.fill(0);
  dir = mkdtempSync(join(tmpdir(), 'jogstick-host-'));
  makeHost('darwin');
});

function makeHost(os: 'darwin' | 'win32') {
  log = new Log();
  fake = fakeNative();
  pad = new FakePad();
  const store = new Store(
    dir,
    { profiles: { 'resolve-default': resolveDefault }, keymap: resolveKeymap },
    log,
    () => true,
  );
  host = new Host({ native: fake.n, log, os, pad, now: () => performance.now() }, store.current);
  host.start();
}
afterEach(() => {
  host.stop('test');
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const injected = () => fake.calls.filter((c) => c !== 'releaseAll');

describe('Host', () => {
  it('nothing is injected while another app is in front', () => {
    fake.setFront({ id: 'com.apple.finder', name: 'Finder' });
    tap(A);
    expect(injected()).toEqual([]);
  });

  it('A in Edit mode sends ⌘B through the queue with 16 ms spacing', () => {
    fake.setFront({});
    expect(host.status().gate.open).toBe(true);
    press(A);
    expect(fake.calls).toEqual(['mods Cmd']);
    vi.advanceTimersByTime(16);
    expect(fake.calls).toEqual(['mods Cmd', 'down Cmd+KeyB', 'up Cmd+KeyB']);
    vi.advanceTimersByTime(16);
    expect(fake.calls.at(-1)).toBe('mods -');
  });

  it('a dialog closes the gate: releaseAll, and presses are ignored', () => {
    fake.setFront({});
    press(R3);
    expect(fake.calls).toEqual(['mouse left down']);
    fake.setFront({ isDialog: true });
    expect(host.status().gate.reason).toBe('dialog');
    expect(fake.calls).toEqual(['mouse left down', 'releaseAll']);
    release(R3);
    tap(A);
    expect(fake.calls).toEqual(['mouse left down', 'releaseAll']);
  });

  it('a button held through gate re-open does nothing until it is pressed again', () => {
    fake.setFront({});
    fake.setFront({ id: 'com.apple.finder' });
    press(A);
    fake.setFront({});
    release(A);
    vi.advanceTimersByTime(100);
    expect(injected()).toEqual([]);
  });

  it('an unbound command logs and sends nothing; an override binds it after reload', () => {
    fake.setFront({});
    press(LB);
    tap(B);
    release(LB);
    expect(injected()).toEqual([]);
    expect(log.all().some((e) => e.msg === 'command edit.pasteInsert has no shortcut')).toBe(true);
    host.applyConfig({
      ...host.currentConfig,
      overrides: { 'edit.pasteInsert': { darwin: 'F13' } },
    });
    press(LB);
    tap(B);
    release(LB);
    expect(injected()).toEqual(['down F13', 'up F13']);
  });

  it('jogging sends plain arrows with no modifier events', () => {
    fake.setFront({});
    axes[0] = 0.6;
    sink().frame([...buttons], [...axes]);
    vi.advanceTimersByTime(1000);
    axes[0] = 0;
    sink().frame([...buttons], [...axes]);
    vi.advanceTimersByTime(50);
    const c = injected();
    expect(c.length).toBeGreaterThan(4);
    expect(new Set(c)).toEqual(new Set(['down ArrowRight', 'up ArrowRight']));
  });

  it('controller disconnect releases everything', () => {
    fake.setFront({});
    press(R3);
    sink().disconnected();
    expect(fake.calls).toEqual(['mouse left down', 'releaseAll']);
    expect(host.status().pad.connected).toBe(false);
  });

  it('the pad buzzes once on connect, and again on a mode switch (View+Menu chord)', () => {
    expect(pad.rumbles).toEqual(['pulse']);
    fake.setFront({});
    press(VIEW, MENU);
    vi.advanceTimersByTime(100);
    expect(host.status().mode).toBe('color');
    expect(pad.rumbles).toEqual(['pulse', 'pulse']);
    release(VIEW, MENU);
  });

  it('releaseAll lets go at the OS level even when the engine state is broken', () => {
    fake.setFront({});
    press(R3);
    // What an engine exception mid-step can leave behind: a state that throws again.
    (host as unknown as { engine: object }).engine = {};
    expect(() => host.releaseAll('test')).not.toThrow();
    expect(fake.calls).toEqual(['mouse left down', 'releaseAll']);
    expect(log.all().some((e) => e.msg.includes('engine state rebuilt'))).toBe(true);
    // The rebuilt engine waits for a fresh press: R3 is still held, so letting go does nothing.
    release(R3);
    vi.advanceTimersByTime(50);
    expect(injected()).toEqual(['mouse left down']);
    tap(A);
    vi.advanceTimersByTime(50);
    expect(injected()).toContain('down Cmd+KeyB');
  });

  it('a reload with a button held does not fire it again', () => {
    fake.setFront({});
    press(A);
    vi.advanceTimersByTime(50);
    const before = injected().length;
    host.applyConfig({ ...host.currentConfig });
    sink().frame([...buttons], [...axes]); // A still down
    vi.advanceTimersByTime(50);
    release(A);
    vi.advanceTimersByTime(50);
    expect(injected().length).toBe(before);
    tap(A);
    vi.advanceTimersByTime(50);
    expect(injected().filter((c) => c === 'down Cmd+KeyB')).toHaveLength(2);
  });

  it('a dead pad source shows as disconnected and restarts with backoff', () => {
    expect(pad.starts).toBe(1);
    sink().error('pad thread panic: test', true);
    expect(host.status().pad.connected).toBe(false);
    vi.advanceTimersByTime(999);
    expect(pad.starts).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pad.starts).toBe(2);
    expect(host.status().pad.connected).toBe(true);
  });

  it('Windows: a dialog the watcher has not reported yet still stops a combo in flight', () => {
    host.stop('test');
    makeHost('win32');
    fake.setFront({ id: 'Resolve.exe', name: 'Resolve' });
    expect(host.status().gate.open).toBe(true);
    press(A);
    expect(fake.calls).toEqual(['mods Ctrl']);
    fake.setFrontUnreported({ isDialog: true });
    vi.advanceTimersByTime(16);
    expect(fake.calls.filter((c) => c.startsWith('down'))).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(host.status().gate.reason).toBe('dialog');
    expect(fake.calls).toContain('releaseAll');
  });

  describe('test with harness', () => {
    const harness = { id: 'dev.jogstick.harness', name: 'jogstick-harness' };

    it('is off by default: the harness in front gets nothing', () => {
      fake.setFront(harness);
      expect(host.status().testMode).toBe(false);
      tap(A);
      expect(injected()).toEqual([]);
    });

    it('on: the harness drives like Resolve, and each command is echoed with its keys', () => {
      const echoes: string[] = [];
      host.onCommandEcho((e) => echoes.push(`${e.what} → ${e.keys}`));
      fake.setFront(harness);
      expect(host.setTestMode(true)).toBe(true);
      expect(host.status().gate).toMatchObject({ open: true, app: 'dev.jogstick.harness' });
      tap(A);
      expect(injected()).toEqual(['mods Cmd', 'down Cmd+KeyB', 'up Cmd+KeyB', 'mods -']);
      expect(echoes).toEqual(['edit.splitClip → Cmd+B']);
    });

    it('is refused while Resolve is in front', () => {
      fake.setFront({});
      expect(host.status().resolveFront).toBe(true);
      expect(host.setTestMode(true)).toBe(false);
      expect(host.status().testMode).toBe(false);
    });

    it('switches itself off the moment Resolve comes to the front; Resolve then works as usual', () => {
      const echoes: string[] = [];
      host.onCommandEcho((e) => echoes.push(e.what));
      fake.setFront(harness);
      host.setTestMode(true);
      fake.setFront({});
      expect(host.status().testMode).toBe(false);
      expect(host.status().gate).toMatchObject({ open: true, reason: 'open' });
      tap(A);
      expect(injected()).toContain('down Cmd+KeyB');
      expect(echoes).toEqual([]);
      // and the harness no longer counts
      fake.setFront(harness);
      expect(host.status().gate.reason).toBe('notTarget');
    });

    it('turning it off closes the gate on the harness and releases', () => {
      fake.setFront(harness);
      host.setTestMode(true);
      press(R3);
      host.setTestMode(false);
      expect(host.status().gate).toMatchObject({ open: false, reason: 'notTarget' });
      expect(fake.calls).toEqual(['mouse left down', 'releaseAll']);
      release(R3);
    });
  });

  it('an injection error triggers releaseAll', () => {
    fake.setFront({});
    fake.n.modifierChanged = () => {
      throw new Error('boom');
    };
    press(A);
    expect(fake.calls).toEqual(['releaseAll']);
    expect(log.all().some((e) => e.kind === 'error' && e.msg.includes('boom'))).toBe(true);
  });
});
