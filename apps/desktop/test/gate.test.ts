import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../src/main/gate';
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
    expect(evaluateGate(front({ id: 'resolve.EXE' }), cfg)).toEqual({
      open: true,
      reason: 'open',
      app: 'resolve.EXE',
    });
  });

  it('a dialog closes it', () => {
    expect(evaluateGate(front({ isDialog: true }), cfg).reason).toBe('dialog');
  });

  it('other apps, nothing in front and our own windows never match', () => {
    expect(evaluateGate(front({ id: 'explorer.exe' }), cfg).reason).toBe('notTarget');
    expect(evaluateGate(null, cfg).reason).toBe('unknown');
    expect(evaluateGate(front({ pid: 1 }), cfg).reason).toBe('self');
  });

  it('transient macOS overlays (password prompt, lock screen) close it under their own reason', () => {
    expect(evaluateGate(front({ id: 'com.apple.SecurityAgent', transient: true }), cfg)).toEqual({
      open: false,
      reason: 'transient',
      app: 'com.apple.SecurityAgent',
    });
  });

  it('an elevated Resolve is blocked (UIPI would drop our input)', () => {
    expect(evaluateGate(front({}), { ...cfg, isElevated: () => true }).reason).toBe('elevated');
    expect(evaluateGate(front({}), { ...cfg, isElevated: () => null }).open).toBe(true);
  });
});
