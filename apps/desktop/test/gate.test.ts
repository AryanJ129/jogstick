import { describe, expect, it } from 'vitest';
import { CLOSED, evaluateGate } from '../src/main/gate';
import type { FrontmostInfo } from '../src/main/native';

const front = (o: Partial<FrontmostInfo>): FrontmostInfo => ({
  id: 'Resolve.exe',
  name: 'Resolve',
  pid: 100,
  isDialog: false,
  transient: false,
  ...o,
});
const cfg = { appMatch: ['Resolve.exe'], selfPid: 1 };

describe('evaluateGate', () => {
  it('opens for Resolve main window (exe match is case-insensitive)', () => {
    expect(evaluateGate(front({ id: 'resolve.EXE' }), CLOSED, cfg)).toEqual({
      open: true,
      reason: 'open',
      app: 'resolve.EXE',
    });
  });

  it('a dialog closes it', () => {
    expect(evaluateGate(front({ isDialog: true }), CLOSED, cfg).reason).toBe('dialog');
  });

  it('other apps, nothing in front and our own windows never match', () => {
    expect(evaluateGate(front({ id: 'explorer.exe' }), CLOSED, cfg).reason).toBe('notTarget');
    expect(evaluateGate(null, CLOSED, cfg).reason).toBe('unknown');
    expect(evaluateGate(front({ pid: 1 }), CLOSED, cfg).reason).toBe('self');
  });

  it('transient macOS overlays keep the previous state', () => {
    const open = evaluateGate(front({}), CLOSED, cfg);
    expect(
      evaluateGate(front({ id: 'com.apple.UserNotificationCenter', transient: true }), open, cfg),
    ).toBe(open);
  });

  it('an elevated Resolve is blocked (UIPI would drop our input)', () => {
    expect(evaluateGate(front({}), CLOSED, { ...cfg, isElevated: () => true }).reason).toBe(
      'elevated',
    );
    expect(evaluateGate(front({}), CLOSED, { ...cfg, isElevated: () => null }).open).toBe(true);
  });
});
