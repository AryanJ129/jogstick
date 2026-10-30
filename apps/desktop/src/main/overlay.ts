import { BrowserWindow, screen } from 'electron';
import type { OverlayCorner } from '@jogstick/engine';
import type { CommandEcho, HostStatus } from './host';

/**
 * The overlay label (BUILD_BRIEF → Overlay, BRAND_KIT §3.2): click-through, never focusable,
 * always on top, on the display Resolve is on. Yellow (`live`) is only the active mode/layer;
 * pauses are `warning` + pause bars, errors `danger` + a cross. Shown only while Resolve is in
 * front; it never draws over other apps.
 */
export interface OverlayView {
  visible: boolean;
  tone: 'live' | 'warning' | 'danger';
  icon: 'lamp' | 'pause' | 'cross';
  parts: string[];
  /** Stays up (a state the user must notice) instead of fading after 1.5 s. */
  sticky: boolean;
  /** Flash on a mode switch. */
  flash: boolean;
}

export const HIDDEN: OverlayView = {
  visible: false,
  tone: 'live',
  icon: 'lamp',
  parts: [],
  sticky: false,
  flash: false,
};

export function overlayView(s: HostStatus, prevMode: string | null): OverlayView {
  switch (s.gate.reason) {
    case 'open': {
      if (!s.pad.connected)
        return {
          visible: true,
          tone: 'danger',
          icon: 'cross',
          parts: ['NO CONTROLLER'],
          sticky: true,
          flash: false,
        };
      const parts = s.testMode ? ['TEST', s.mode.toUpperCase()] : [s.mode.toUpperCase()];
      const layer = s.layers.at(-1);
      if (layer) parts.push(layer.toUpperCase());
      if (s.fine) parts.push('FINE');
      return {
        visible: true,
        tone: 'live',
        icon: 'lamp',
        parts,
        sticky: false,
        flash: prevMode !== null && prevMode !== s.mode,
      };
    }
    case 'dialog':
      return {
        visible: true,
        tone: 'warning',
        icon: 'pause',
        parts: ['PAUSED', 'DIALOG'],
        sticky: true,
        flash: false,
      };
    case 'elevated':
      return {
        visible: true,
        tone: 'danger',
        icon: 'cross',
        parts: ['BLOCKED', 'ADMIN'],
        sticky: true,
        flash: false,
      };
    default:
      return HIDDEN;
  }
}

/** Test mode: one output, e.g. `TEST · edit.blade · Cmd+B`; fades like the mode label. */
export function echoView(e: CommandEcho): OverlayView {
  return {
    visible: true,
    tone: 'live',
    icon: 'lamp',
    parts: ['TEST', e.what, e.keys],
    sticky: false,
    flash: false,
  };
}

// Room for a test-mode echo (`TEST · edit.rippleDelete · Shift+Backspace`); the window is
// transparent and click-through, and the chip hugs the chosen corner.
const WIDTH = 480;
const HEIGHT = 46;
const MARGIN = 16;

export class Overlay {
  private win: BrowserWindow | null = null;
  private last: string | null = null;
  enabled = true;
  corner: OverlayCorner = 'topRight';

  constructor(
    private readonly preload: string,
    private readonly load: (win: BrowserWindow, page: string) => Promise<void>,
  ) {}

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void this.load(win, 'overlay');
    this.win = win;
    return win;
  }

  /** `bounds` = the frontmost window ([x, y, w, h]; physical pixels on Windows, points on macOS). */
  /** `force`: send even if unchanged (test-mode echoes repeat, e.g. jog arrows, and must not fade). */
  show(view: OverlayView, bounds: number[] | undefined, force = false): void {
    if (!this.enabled || !view.visible) {
      this.hide();
      return;
    }
    const win = this.window();
    const key = JSON.stringify([view, this.corner]);
    this.place(win, bounds);
    if (key !== this.last || view.flash || force) {
      this.last = key;
      const send = () => win.webContents.send('overlay:view', { ...view, corner: this.corner });
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
      else send();
    }
    if (!win.isVisible()) win.showInactive();
  }

  hide(): void {
    this.last = null;
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }

  private place(win: BrowserWindow, bounds: number[] | undefined): void {
    let display = screen.getPrimaryDisplay();
    if (bounds && bounds.length === 4) {
      const [x, y, width, height] = bounds as [number, number, number, number];
      const rect = { x, y, width, height };
      const dip = process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
      display = screen.getDisplayMatching(dip);
    }
    const a = display.workArea;
    const right = this.corner === 'topRight' || this.corner === 'bottomRight';
    const bottom = this.corner === 'bottomLeft' || this.corner === 'bottomRight';
    win.setBounds({
      x: Math.round(right ? a.x + a.width - WIDTH - MARGIN : a.x + MARGIN),
      y: Math.round(bottom ? a.y + a.height - HEIGHT - MARGIN : a.y + MARGIN),
      width: WIDTH,
      height: HEIGHT,
    });
  }
}
