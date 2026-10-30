import { Menu, nativeImage, nativeTheme, Tray } from 'electron';
import type { MenuItemConstructorOptions, NativeImage } from 'electron';
import { join } from 'node:path';
import type { HostStatus } from './host';

/**
 * The tray (BRAND_KIT §8): four states by shape. Windows picks the dark- or light-taskbar set from
 * `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` and swaps on `updated`; macOS uses template
 * images (tinted by the system).
 */
export type TrayState = 'connected' | 'color' | 'paused' | 'error';

export interface TrayActions {
  togglePause(): void;
  toggleTestMode(): void;
  exportReport(): void;
  exportLog(): void;
  openUserData(): void;
  openAxSettings?: (() => void) | undefined;
  openWindow(): void;
  quit(): void;
}

export function trayState(s: HostStatus, hasError: boolean): TrayState {
  if (hasError || s.gate.reason === 'elevated' || s.gate.reason === 'noAccess') return 'error';
  if (!s.gate.open || !s.pad.connected) return 'paused';
  return s.mode === 'color' ? 'color' : 'connected';
}

const GATE_TEXT: Record<HostStatus['gate']['reason'], string> = {
  open: 'Driving DaVinci Resolve',
  notTarget: 'Waiting for DaVinci Resolve to be in front',
  dialog: 'Paused: a dialog is open in Resolve',
  self: 'Paused: a Jogstick window is in front',
  elevated: 'Blocked: Resolve runs as administrator',
  unknown: 'Waiting for DaVinci Resolve',
  paused: 'Paused',
  noAccess: 'Needs Accessibility permission',
  transient: 'Paused: a system prompt is in front',
};

export function statusLines(s: HostStatus): string[] {
  const mode = s.mode.charAt(0).toUpperCase() + s.mode.slice(1);
  const gate = !s.testMode
    ? GATE_TEXT[s.gate.reason]
    : s.gate.open
      ? 'TEST MODE: driving jogstick-harness'
      : s.gate.reason === 'notTarget' || s.gate.reason === 'unknown'
        ? 'TEST MODE: waiting for jogstick-harness to be in front'
        : `TEST MODE · ${GATE_TEXT[s.gate.reason]}`;
  return [
    `${gate}${s.gate.open ? ` · ${mode} mode` : ''}`,
    s.pad.connected ? `Controller: ${s.pad.name ?? 'connected'}` : 'No controller connected',
  ];
}

export class AppTray {
  private tray: Tray;
  private state: TrayState = 'paused';
  private status: HostStatus | null = null;
  private warnings: string[] = [];

  constructor(
    private readonly iconDir: string,
    private readonly actions: TrayActions,
  ) {
    this.tray = new Tray(this.icon('paused'));
    this.tray.setToolTip('Jogstick');
    nativeTheme.on('updated', () => this.tray.setImage(this.icon(this.state)));
  }

  private icon(state: TrayState): NativeImage {
    if (process.platform === 'darwin') {
      const img = nativeImage.createFromPath(join(this.iconDir, 'mac', `${state}Template.png`));
      img.setTemplateImage(true);
      return img;
    }
    // The taskbar follows the *system* theme, which can differ from the app theme on Windows.
    const set = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark' : 'light';
    return nativeImage.createFromPath(join(this.iconDir, 'win', set, `${state}.ico`));
  }

  update(status: HostStatus, warnings: string[]): void {
    this.status = status;
    this.warnings = warnings;
    const state = trayState(status, false);
    if (state !== this.state) {
      this.state = state;
      this.tray.setImage(this.icon(state));
    }
    this.tray.setToolTip(['Jogstick', ...statusLines(status)].join('\n'));
    this.tray.setContextMenu(this.menu());
  }

  private menu(): Menu {
    const s = this.status;
    const items: MenuItemConstructorOptions[] = [];
    if (s) for (const line of statusLines(s)) items.push({ label: line, enabled: false });
    for (const w of this.warnings) items.push({ label: `⚠ ${w}`, enabled: false });
    items.push({ type: 'separator' });
    if (s?.gate.reason === 'noAccess' && this.actions.openAxSettings)
      items.push({ label: 'Open Accessibility settings…', click: this.actions.openAxSettings });
    items.push(
      { label: s?.paused ? 'Resume' : 'Pause', click: () => this.actions.togglePause() },
      { label: 'Open Jogstick', click: () => this.actions.openWindow() },
      { type: 'separator' },
      {
        label: s?.resolveFront
          ? 'Test with harness (not while Resolve is in front)'
          : 'Test with harness (drives jogstick-harness, not Resolve)',
        type: 'checkbox',
        checked: s?.testMode ?? false,
        enabled: !s?.resolveFront || (s?.testMode ?? false),
        click: () => this.actions.toggleTestMode(),
      },
      { type: 'separator' },
      { label: 'Export test report', click: () => this.actions.exportReport() },
      { label: 'Export Console log…', click: () => this.actions.exportLog() },
      { label: 'Open user data folder', click: () => this.actions.openUserData() },
      { type: 'separator' },
      { label: 'Quit Jogstick', click: () => this.actions.quit() },
    );
    return Menu.buildFromTemplate(items);
  }

  destroy(): void {
    this.tray.destroy();
  }
}
