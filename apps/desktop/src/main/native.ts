import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The addon surface the host uses (`packages/native/index.d.ts`, loaded at runtime, never bundled). */
export interface FrontmostInfo {
  id: string;
  name: string;
  pid: number;
  bounds?: number[];
  isDialog: boolean;
  transient: boolean;
}

export interface HeldState {
  keys: string[];
  mods: string[];
  buttons: string[];
}

export interface PadEvent {
  kind: 'frame' | 'connected' | 'disconnected' | 'error';
  index: number;
  buttons?: number[];
  axes?: number[];
  packet?: number;
  message?: string;
}

export interface Native {
  nativeVersion(): string;
  isKnownCode(code: string): boolean;
  keyDown(code: string, mods: string[]): void;
  keyUp(code: string, mods: string[]): void;
  modifierChanged(mods: string[]): void;
  mouseMoveRel(dx: number, dy: number): void;
  mouseMoveTo(x: number, y: number): void;
  mouseButton(btn: string, down: boolean): void;
  scroll(dx: number, dy: number, units: string): void;
  cursorPosition(): number[];
  releaseAll(): void;
  releaseLeftovers(): string[];
  heldState(): HeldState;
  osHeldState(): HeldState;
  frontmostApp(): FrontmostInfo | null;
  onFrontmostChanged(cb: (front: FrontmostInfo | null) => void, intervalMs?: number): void;
  offFrontmostChanged(): void;
  isProcessElevated(pid: number): boolean | null;
  isProcessRunning(name: string): boolean;
  axIsTrusted(prompt: boolean): boolean;
  openAxSettings(): void;
  padStart(cb: (e: PadEvent) => void, opts?: { hz?: number }): void;
  padStop(): void;
  padRumble(index: number, low: number, high: number, ms: number): void;
  padList(): number[];
}

/** Packaged: `resources/native/index.js` (napi loader + `.node` side by side). Dev: the workspace package. */
export function loadNative(): Native {
  const require = createRequire(import.meta.url);
  const path = app.isPackaged
    ? join(process.resourcesPath, 'native', 'index.js')
    : join(app.getAppPath(), '..', '..', 'packages', 'native', 'index.js');
  return require(path) as Native;
}
