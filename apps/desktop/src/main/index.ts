import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import resolveDefault from '../../../../packages/profiles/resolve-default.json';
import resolveKeymap from '../../../../packages/profiles/resolve-keymap.json';
import { Host } from './host';
import { Log } from './log';
import { loadNative } from './native';
import type { Native } from './native';
import { Overlay, overlayView } from './overlay';
import { GamepadSource, preloadPath, ReplaySource, XInputSource } from './pad';
import type { PadSource } from './pad';
import { Store } from './store';
import { AppTray } from './tray';

/**
 * Phase 3: a tray app. The input host runs from launch; the editor window (Phase 4) opens from the
 * tray. Environment, for the harness e2e only (logged loudly when set):
 *   JOGSTICK_E2E_SCRIPT  replay this frame script instead of a real pad, then exit
 *   JOGSTICK_GATE_APP    an extra app id the gate accepts (the harness bundle id / exe)
 *   JOGSTICK_USER_DATA   use this folder as <userData>
 */
const E2E_SCRIPT = process.env['JOGSTICK_E2E_SCRIPT'];
const GATE_APP = process.env['JOGSTICK_GATE_APP'];
const USER_DATA = process.env['JOGSTICK_USER_DATA'];

const log = new Log(2000, Date.now, E2E_SCRIPT !== undefined);
const os = process.platform === 'win32' ? 'win32' : 'darwin';

if (USER_DATA) app.setPath('userData', USER_DATA);

let native: Native | null = null;
let host: Host | null = null;
let tray: AppTray | null = null;
let overlay: Overlay | null = null;
let editor: BrowserWindow | null = null;
let quitting = false;
const warnings = new Map<string, string>();

function loadPage(win: BrowserWindow, page: string): Promise<void> {
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return dev
    ? win.loadURL(`${dev}/${page}.html`)
    : win.loadFile(join(import.meta.dirname, `../renderer/${page}.html`));
}

function resourceDir(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), '..', '..', 'brand', name);
}

function openEditor(): void {
  if (editor && !editor.isDestroyed()) {
    editor.show();
    editor.focus();
    return;
  }
  editor = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#1a1a1a',
    webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: true },
  });
  editor.once('ready-to-show', () => editor?.show());
  void loadPage(editor, 'index');
}

// --- safety: anything unexpected releases everything first --------------------

process.on('uncaughtException', (e) => {
  log.add('error', `uncaught: ${e.stack ?? e.message}`);
  host?.releaseAll('uncaught exception');
});
process.on('unhandledRejection', (e) => {
  log.add('error', `unhandled rejection: ${String(e)}`);
  host?.releaseAll('unhandled rejection');
});

function watchPower(): void {
  const release = (reason: string) => () => host?.releaseAll(reason);
  powerMonitor.on('suspend', release('system sleep'));
  powerMonitor.on('lock-screen', release('screen locked'));
  powerMonitor.on('shutdown', release('shutdown'));
  // macOS fast user switching.
  powerMonitor.on('user-did-resign-active', release('user switched'));
}

// --- warnings ------------------------------------------------------------------

const STEAM = os === 'win32' ? 'steam.exe' : 'steam_osx';

function checkWarnings(): void {
  if (!native) return;
  const steam = native.isProcessRunning(STEAM);
  if (steam && !warnings.has('steam')) {
    warnings.set('steam', 'Steam is running: its Desktop Layout may also send keys (see Console)');
    log.add(
      'warn',
      'Steam is running. Steam Input can turn an Xbox controller into keyboard/mouse input outside games ' +
        '(Desktop Layout), which would double every press. In Steam → Settings → Controller, set ' +
        '"Desktop Layout" to none or disable Steam Input for Xbox controllers, or quit Steam while editing.',
    );
  } else if (!steam && warnings.delete('steam')) log.add('app', 'Steam is no longer running');
  if (host) {
    if (host.status().gate.reason === 'elevated') {
      if (!warnings.has('elevated')) {
        warnings.set('elevated', 'Resolve runs as administrator: restart it normally');
        log.add(
          'warn',
          'Resolve runs elevated (as administrator); Windows blocks input from normal apps to it.',
        );
      }
    } else warnings.delete('elevated');
  }
  refreshUi();
}

// --- UI ------------------------------------------------------------------------

let prevMode: string | null = null;

function refreshUi(): void {
  if (!host) return;
  const s = host.status();
  tray?.update(s, [...warnings.values()]);
  if (overlay) {
    const view = overlayView(s, prevMode);
    const front = s.gate.app !== null && native ? safeFront(native) : null;
    overlay.show(view, front?.bounds);
  }
  prevMode = s.mode;
}

function safeFront(n: Native) {
  try {
    return n.frontmostApp();
  } catch (e) {
    log.add('error', `frontmostApp: ${String(e)}`);
    return null;
  }
}

async function exportLog(): Promise<void> {
  const s = host?.status();
  const c = host?.currentConfig;
  const header = [
    `Jogstick ${app.getVersion()} · ${process.platform} ${process.getSystemVersion()} · ${process.arch}`,
    `Electron ${process.versions.electron} · native ${native?.nativeVersion() ?? 'not loaded'}`,
    `profile ${c?.profile.id ?? '?'} (${c?.profileSource ?? '?'}) · comboSpacingMs ${c?.profile.settings.comboSpacingMs ?? '?'}`,
    `overrides: ${c ? Object.keys(c.overrides).join(', ') || 'none' : '?'}`,
    `gate ${s ? `${s.gate.reason} ${s.gate.app ?? ''}` : '?'} · pad ${s?.pad.name ?? 'none'}`,
    `warnings: ${[...warnings.values()].join(' | ') || 'none'}`,
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const r = await dialog.showSaveDialog({
    title: 'Export Console log',
    defaultPath: join(app.getPath('downloads'), `jogstick-console-${stamp}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return;
  writeFileSync(r.filePath, log.format(header), 'utf8');
  log.add('app', `Console log exported to ${r.filePath}`);
  shell.showItemInFolder(r.filePath);
}

// --- startup -------------------------------------------------------------------

function pickPad(n: Native): PadSource {
  if (E2E_SCRIPT) return ReplaySource.fromFile(E2E_SCRIPT);
  return os === 'win32' ? new XInputSource(n) : new GamepadSource(preloadPath(), loadPage);
}

function main(): void {
  if (!app.requestSingleInstanceLock()) {
    // Two hosts would inject every press twice.
    app.quit();
    return;
  }
  if (process.platform === 'darwin') app.dock?.hide();
  log.add('app', `Jogstick ${app.getVersion()} starting (${process.platform} ${process.arch})`);
  if (GATE_APP) log.add('warn', `JOGSTICK_GATE_APP set: the gate also accepts ${GATE_APP}`);

  try {
    native = loadNative();
    log.add('app', `native ${native.nativeVersion()}`);
  } catch (e) {
    log.add('error', `loading the native addon failed: ${String(e)}`);
    void dialog.showMessageBox({
      type: 'error',
      message: 'Jogstick could not load its input module.',
      detail: String(e),
    });
    app.quit();
    return;
  }
  const n = native;

  const store = new Store(
    app.getPath('userData'),
    { profiles: { 'resolve-default': resolveDefault }, keymap: resolveKeymap },
    log,
    (code) => n.isKnownCode(code),
  );
  const config = store.current;
  log.add(
    'app',
    `profile ${config.profile.id} (${config.profileSource}), comboSpacingMs ${config.profile.settings.comboSpacingMs}, userData ${store.dir}`,
  );

  const pad = pickPad(n);
  const h = new Host(
    { native: n, log, os, pad, extraGateApps: GATE_APP ? [GATE_APP] : [] },
    config,
  );
  host = h;

  overlay = new Overlay(preloadPath(), loadPage);
  overlay.enabled = config.settings.overlay.enabled;
  overlay.corner = config.settings.overlay.corner;

  tray = new AppTray(resourceDir('tray'), {
    togglePause: () => h.setPaused(!h.status().paused),
    exportLog: () => void exportLog(),
    openUserData: () => void shell.openPath(store.dir),
    openAxSettings: os === 'darwin' ? () => n.openAxSettings() : undefined,
    openWindow: openEditor,
    quit: () => app.quit(),
  });

  h.onStatus(() => refreshUi());

  if (os === 'darwin') {
    const trusted = n.axIsTrusted(!E2E_SCRIPT);
    h.setAccess(trusted);
    if (!trusted) {
      const poll = setInterval(() => {
        if (n.axIsTrusted(false)) {
          clearInterval(poll);
          h.setAccess(true);
        }
      }, 2000);
    }
  }

  store.start((c) => {
    h.applyConfig(c);
    if (overlay) {
      overlay.enabled = c.settings.overlay.enabled;
      overlay.corner = c.settings.overlay.corner;
    }
    refreshUi();
  });
  watchPower();

  if (E2E_SCRIPT && pad instanceof ReplaySource) runE2e(h, n, pad);
  h.start();
  checkWarnings();
  setInterval(checkWarnings, 10_000);
  refreshUi();
}

/** E2E: script marks go to stdout for the driver (`releaseAll` also runs it here); exit when done. */
function runE2e(h: Host, n: Native, pad: ReplaySource): void {
  log.add('warn', `E2E MODE: replaying ${E2E_SCRIPT}`);
  const start = pad.start.bind(pad);
  pad.start = (sink) =>
    start({
      ...sink,
      mark: (name) => {
        console.log(`E2E-MARK ${name}`);
        if (name === 'releaseAll') {
          console.log(
            `E2E-HELD ${JSON.stringify({ held: n.heldState(), osHeld: n.osHeldState() })}`,
          );
          h.releaseAll('e2e mark');
          console.log(
            `E2E-RELEASED ${JSON.stringify({ held: n.heldState(), osHeld: n.osHeldState() })}`,
          );
        }
      },
      done: () => {
        const finish = () => {
          if (h.queueBusy) return void setTimeout(finish, 50);
          setTimeout(() => {
            const result = { held: n.heldState(), osHeld: n.osHeldState(), rumbles: pad.rumbles };
            console.log(`E2E-DONE ${JSON.stringify(result)}`);
            app.quit();
          }, 300);
        };
        finish();
      },
    });
}

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  host?.stop('quit');
  overlay?.destroy();
  tray?.destroy();
});

// A tray app: closing the editor window doesn't quit.
app.on('window-all-closed', () => undefined);

void app.whenReady().then(main);
