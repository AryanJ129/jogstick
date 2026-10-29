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
  return { n, calls, setFront };
}

class FakePad implements PadSource {
  readonly kind = 'replay';
  sink: PadSink | null = null;
  rumbles: string[] = [];
  start(sink: PadSink) {
    this.sink = sink;
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
  log = new Log();
  fake = fakeNative();
  pad = new FakePad();
  const store = new Store(
    dir,
    { profiles: { 'resolve-default': resolveDefault }, keymap: resolveKeymap },
    log,
    () => true,
  );
  host = new Host(
    { native: fake.n, log, os: 'darwin', pad, now: () => performance.now() },
    store.current,
  );
  host.start();
});
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

  it('a mode switch (View+Menu chord) buzzes the pad and changes mode', () => {
    fake.setFront({});
    press(VIEW, MENU);
    vi.advanceTimersByTime(100);
    expect(host.status().mode).toBe('color');
    expect(pad.rumbles).toEqual(['pulse']);
    release(VIEW, MENU);
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
