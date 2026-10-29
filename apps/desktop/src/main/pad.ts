import { BrowserWindow, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Native } from './native';

/**
 * Where PadFrames come from (BUILD_BRIEF → Processes and data flow):
 * - Windows: XInput on the addon's thread (never the Gamepad API on Windows).
 * - macOS: the Chromium Gamepad API in a hidden renderer, polled at 250 Hz.
 * - Replay: a recorded/generated frame script, for the harness e2e.
 */
export interface PadSink {
  frame(buttons: number[], axes: number[]): void;
  connected(name: string): void;
  disconnected(): void;
  error(message: string): void;
  /** Replay only: a named point in the script (the e2e driver acts on it). */
  mark?(name: string): void;
  /** Replay only: the script has finished. */
  done?(): void;
}

export interface PadSource {
  readonly kind: 'xinput' | 'gamepad' | 'replay';
  start(sink: PadSink): void;
  stop(): void;
  rumble(kind: 'pulse' | 'detent'): void;
}

const RUMBLE = {
  pulse: { low: 0.5, high: 0.5, ms: 60 },
  detent: { low: 0.3, high: 0, ms: 12 },
} as const;

export class XInputSource implements PadSource {
  readonly kind = 'xinput';
  private active: number | null = null;

  constructor(private readonly native: Native) {}

  start(sink: PadSink): void {
    this.native.padStart(
      (e) => {
        switch (e.kind) {
          case 'connected':
            if (this.active === null) {
              this.active = e.index;
              sink.connected(`Xbox controller (slot ${e.index + 1})`);
            }
            break;
          case 'disconnected':
            if (e.index === this.active) {
              this.active = null;
              sink.disconnected();
            }
            break;
          case 'frame':
            if (this.active === null) {
              this.active = e.index;
              sink.connected(`Xbox controller (slot ${e.index + 1})`);
            }
            if (e.index === this.active && e.buttons && e.axes) sink.frame(e.buttons, e.axes);
            break;
          case 'error':
            sink.error(e.message ?? 'pad thread error');
            break;
        }
      },
      { hz: 250 },
    );
  }

  stop(): void {
    this.native.padStop();
    this.active = null;
  }

  rumble(kind: 'pulse' | 'detent'): void {
    if (this.active === null) return;
    const r = RUMBLE[kind];
    this.native.padRumble(this.active, r.low, r.high, r.ms);
  }
}

/** IPC boundary: everything from the pad renderer is validated. */
export const GamepadMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('frame'),
    buttons: z.array(z.number().min(0).max(1)).length(17),
    axes: z.array(z.number().min(-1).max(1)).length(4),
  }),
  z.object({ kind: z.literal('connected'), id: z.string().max(200) }),
  z.object({ kind: z.literal('disconnected') }),
  z.object({ kind: z.literal('nonstandard'), id: z.string().max(200) }),
]);

export class GamepadSource implements PadSource {
  readonly kind = 'gamepad';
  private win: BrowserWindow | null = null;
  private onMessage: ((e: Electron.IpcMainEvent, raw: unknown) => void) | null = null;

  constructor(
    private readonly preload: string,
    private readonly load: (win: BrowserWindow, page: string) => Promise<void>,
  ) {}

  start(sink: PadSink): void {
    const win = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win = win;
    this.onMessage = (e, raw) => {
      if (e.sender !== win.webContents) return;
      const m = GamepadMessageSchema.safeParse(raw);
      if (!m.success) return sink.error('pad renderer sent an invalid message');
      const msg = m.data;
      if (msg.kind === 'frame') sink.frame(msg.buttons, msg.axes);
      else if (msg.kind === 'connected') sink.connected(msg.id);
      else if (msg.kind === 'disconnected') sink.disconnected();
      else sink.error(`controller "${msg.id}" has no standard mapping; it can't be used`);
    };
    ipcMain.on('pad:message', this.onMessage);
    win.webContents.on('render-process-gone', (_e, d) =>
      sink.error(`pad renderer gone: ${d.reason}`),
    );
    void this.load(win, 'pad');
  }

  stop(): void {
    if (this.onMessage) ipcMain.off('pad:message', this.onMessage);
    this.onMessage = null;
    this.win?.destroy();
    this.win = null;
  }

  rumble(kind: 'pulse' | 'detent'): void {
    this.win?.webContents.send('pad:rumble', RUMBLE[kind]);
  }
}

export const ReplayScriptSchema = z.object({
  steps: z.array(
    z.union([
      z.object({
        at: z.number().nonnegative(),
        buttons: z.array(z.number().min(0).max(1)).length(17),
        axes: z.array(z.number().min(-1).max(1)).length(4),
      }),
      z.object({ at: z.number().nonnegative(), mark: z.string() }),
    ]),
  ),
});
export type ReplayScript = z.infer<typeof ReplayScriptSchema>;

/** Plays a frame script on wall-clock time from `start()`; frames at 4 ms resolution. */
export class ReplaySource implements PadSource {
  readonly kind = 'replay';
  private timers: ReturnType<typeof setTimeout>[] = [];
  readonly rumbles: string[] = [];

  constructor(private readonly script: ReplayScript) {}

  static fromFile(path: string): ReplaySource {
    return new ReplaySource(ReplayScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8'))));
  }

  start(sink: PadSink): void {
    sink.connected('replay');
    let last = 0;
    for (const s of this.script.steps) {
      last = Math.max(last, s.at);
      this.timers.push(
        setTimeout(() => {
          if ('mark' in s) sink.mark?.(s.mark);
          else sink.frame(s.buttons, s.axes);
        }, s.at),
      );
    }
    this.timers.push(setTimeout(() => sink.done?.(), last + 1));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  rumble(kind: 'pulse' | 'detent'): void {
    this.rumbles.push(kind);
  }
}

export function preloadPath(): string {
  return join(import.meta.dirname, '../preload/index.cjs');
}
