import type { FrontmostInfo } from './native';

/**
 * The gate (engine semantics 14): inject only while Resolve's main window is frontmost and no
 * modal dialog is up. Pure; the host feeds it every frontmost change.
 */
export type GateReason =
  'open' | 'notTarget' | 'dialog' | 'self' | 'elevated' | 'unknown' | 'paused' | 'noAccess';

export interface GateState {
  open: boolean;
  reason: GateReason;
  /** The frontmost app's id, for the Console and tray. */
  app: string | null;
}

export interface GateConfig {
  /** `appMatch[os]` from the profile: Windows exe names, macOS bundle ids. */
  appMatch: string[];
  /** Our own process: never a match, whatever the config says. */
  selfPid: number;
  /** Windows: `isProcessElevated(pid)`; null = unknown. */
  isElevated?: (pid: number) => boolean | null;
}

export const CLOSED: GateState = { open: false, reason: 'unknown', app: null };

export function evaluateGate(
  front: FrontmostInfo | null,
  prev: GateState,
  cfg: GateConfig,
): GateState {
  if (front === null) return { open: false, reason: 'unknown', app: null };
  // Screen saver, login window, notification banners: they take focus for a moment; keep the gate
  // as it was (it re-evaluates when the real app comes back).
  if (front.transient) return prev;
  const app = front.id;
  if (front.pid === cfg.selfPid) return { open: false, reason: 'self', app };
  const match = cfg.appMatch.some((m) => m.toLowerCase() === app.toLowerCase());
  if (!match) return { open: false, reason: 'notTarget', app };
  if (front.isDialog) return { open: false, reason: 'dialog', app };
  if (cfg.isElevated?.(front.pid) === true) return { open: false, reason: 'elevated', app };
  return { open: true, reason: 'open', app };
}

export function sameGate(a: GateState, b: GateState): boolean {
  return a.open === b.open && a.reason === b.reason && a.app === b.app;
}
