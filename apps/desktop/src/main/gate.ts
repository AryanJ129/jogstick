import type { FrontmostInfo } from './native';

/**
 * The gate (engine semantics 14): inject only while Resolve's main window is frontmost and no
 * modal dialog is up. Pure; the host feeds it every frontmost change.
 */
export type GateReason =
  | 'open'
  | 'notTarget'
  | 'dialog'
  | 'self'
  | 'elevated'
  | 'unknown'
  | 'paused'
  | 'noAccess'
  | 'transient';

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
  /** Jogstick itself runs elevated: UIPI only blocks input to a higher level, so nothing is blocked. */
  selfElevated?: boolean;
}

export const CLOSED: GateState = { open: false, reason: 'unknown', app: null };

export function evaluateGate(front: FrontmostInfo | null, cfg: GateConfig): GateState {
  if (front === null) return { open: false, reason: 'unknown', app: null };
  const app = front.id;
  // Screen saver, login window, password prompts (SecurityAgent), notification banners: they take
  // focus for a moment. The gate closes anyway (keys must never land in a password field) but under
  // its own reason, so the host can tell it from leaving Resolve; it re-opens when Resolve is back.
  if (front.transient) return { open: false, reason: 'transient', app };
  if (front.pid === cfg.selfPid) return { open: false, reason: 'self', app };
  const match = cfg.appMatch.some((m) => m.toLowerCase() === app.toLowerCase());
  if (!match) return { open: false, reason: 'notTarget', app };
  if (front.isDialog) return { open: false, reason: 'dialog', app };
  if (!cfg.selfElevated && cfg.isElevated?.(front.pid) === true)
    return { open: false, reason: 'elevated', app };
  return { open: true, reason: 'open', app };
}

export function sameGate(a: GateState, b: GateState): boolean {
  return a.open === b.open && a.reason === b.reason && a.app === b.app;
}
