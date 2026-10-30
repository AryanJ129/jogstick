import { app } from 'electron';
import { existsSync } from 'node:fs';
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

/**
 * The packaged layout (scripts/package-app.ts) is detected by its files, not `app.isPackaged`
 * (which only looks at the executable's name).
 */
export const packaged =
  existsSync(join(process.resourcesPath, 'native', 'index.js')) ||
  // The app itself, in case the native folder is what's missing (that's the failure to report).
  existsSync(join(process.resourcesPath, 'app', 'package.json'));

/** Packaged: `resources/native` (napi loader + `.node` side by side). Dev: the workspace package. */
export function nativeDir(): string {
  return packaged
    ? join(process.resourcesPath, 'native')
    : join(app.getAppPath(), '..', '..', 'packages', 'native');
}

/** `path` (dev e2e only): load this file instead, to exercise the load-failure report. */
export function loadNative(path = join(nativeDir(), 'index.js')): Native {
  const require = createRequire(import.meta.url);
  return require(path) as Native;
}
