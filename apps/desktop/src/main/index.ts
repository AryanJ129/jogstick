import { unboundCommands } from '@jogstick/engine';
import { app, BrowserWindow, dialog, Notification, powerMonitor, screen, shell } from 'electron';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { release as osRelease, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import resolveDefault from '../../../../packages/profiles/resolve-default.json';
import resolveKeymap from '../../../../packages/profiles/resolve-keymap.json';
import { Host } from './host';
import { Log } from './log';
import { loadNative, nativeDir, packaged } from './native';
import type { Native } from './native';
import { echoView, Overlay, overlayView } from './overlay';
import { GamepadSource, preloadPath, ReplaySource, XInputSource } from './pad';
import type { PadSource } from './pad';
import { loadFailureFiles, ReportCollector, reportFiles, reportName, zip } from './report';
import { Store } from './store';
import { AppTray } from './tray';

/**
 * Phase 3: a tray app. The input host runs from launch; the editor window (Phase 4) opens from the
 * tray. Environment, for the harness e2e only (logged loudly when set):
 *   JOGSTICK_E2E_SCRIPT  replay this frame script instead of a real pad, then exit
 *   JOGSTICK_GATE_APP    an extra app id the gate accepts (the harness bundle id / exe)
 *   JOGSTICK_USER_DATA   use this folder as <userData>
 *   JOGSTICK_E2E_TEST_MODE  turn on "Test with harness" at start (the e2e's way to the harness)
 *   JOGSTICK_E2E_NATIVE_FAIL  load this file as the native module (a broken one: the failure report)
 * A packaged build ignores all of them: a replayed script would type into the gated app.
 */
const devEnv = (name: string) => (packaged ? undefined : process.env[name]);
const E2E_SCRIPT = devEnv('JOGSTICK_E2E_SCRIPT');
const GATE_APP = devEnv('JOGSTICK_GATE_APP');
const USER_DATA = devEnv('JOGSTICK_USER_DATA');
const E2E_TEST_MODE = devEnv('JOGSTICK_E2E_TEST_MODE') === '1';
const E2E_NATIVE_FAIL = devEnv('JOGSTICK_E2E_NATIVE_FAIL');

const log = new Log(2000, Date.now, E2E_SCRIPT !== undefined);
const collector = new ReportCollector(log);
const os = process.platform === 'win32' ? 'win32' : 'darwin';

if (USER_DATA) app.setPath('userData', USER_DATA);
// Jogstick stores no secrets and makes no network requests; without this, Chromium creates an
// "Electron Safe Storage" keychain item at launch and macOS may show a keychain prompt for it.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain');

let native: Native | null = null;
let host: Host | null = null;
let padSource: PadSource | null = null;
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
  return packaged
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

// A throw inside an uncaughtException handler kills the process, so the release is guarded too
// (and Host.releaseAll lets go at the OS level before anything else can fail).
function emergencyRelease(reason: string): void {
  try {
    host?.releaseAll(reason);
  } catch (e) {
    try {
      native?.releaseAll();
    } catch {
      // Nothing else left to try (an addon call that panics already releases on its own).
    }
    log.add('error', `releaseAll after ${reason}: ${String(e)}`);
  }
}
process.on('uncaughtException', (e) => {
  log.add('error', `uncaught: ${e.stack ?? e.message}`);
  emergencyRelease('uncaught exception');
});
process.on('unhandledRejection', (e) => {
  log.add('error', `unhandled rejection: ${String(e)}`);
  emergencyRelease('unhandled rejection');
});

// No window of ours ever navigates or opens another one.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
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
    overlay.show(view, s.gate.app !== null ? s.bounds : undefined);
  }
  prevMode = s.mode;
}

function consoleHeader(): string[] {
  const s = host?.status();
  const c = host?.currentConfig;
  return [
    `Jogstick ${app.getVersion()} · ${process.platform} ${process.getSystemVersion()} · ${process.arch}`,
    `Electron ${process.versions.electron} · native ${native?.nativeVersion() ?? 'not loaded'}`,
    `profile ${c?.profile.id ?? '?'} (${c?.profileSource ?? '?'}) · comboSpacingMs ${c?.profile.settings.comboSpacingMs ?? '?'}`,
    `overrides: ${c ? Object.keys(c.overrides).join(', ') || 'none' : '?'}`,
    `gate ${s ? `${s.gate.reason} ${s.gate.app ?? ''}` : '?'} · pad ${s?.pad.name ?? 'none'}`,
    `warnings: ${[...warnings.values()].join(' | ') || 'none'}`,
  ];
}

/**
 * Beside the app (the unzipped folder on Windows, the folder holding Jogstick.app on macOS), so a
 * tester finds it next to Jogstick.exe. Falls back to Downloads, then Desktop, when that folder
 * isn't writable (Program Files, a translocated macOS app, a dev build).
 */
function reportDirs(): string[] {
  // The e2e (dev only) keeps its reports in its own throwaway <userData>, never in Downloads.
  if (E2E_SCRIPT || E2E_NATIVE_FAIL) return [app.getPath('userData')];
  // A portable .exe (electron-builder) runs from a temp folder deleted at quit; it names its own.
  const portable = process.env['PORTABLE_EXECUTABLE_DIR'];
  const beside = !packaged
    ? null
    : portable
      ? portable
      : os === 'darwin'
        ? dirname(resolve(process.execPath, '..', '..', '..'))
        : dirname(process.execPath);
  return [beside, app.getPath('downloads'), app.getPath('desktop')].filter(
    (d): d is string => d !== null,
  );
}

/** The report zip, from the live state (the tray action and the e2e driver both use it). */
function buildReport(h: Host, n: Native, at: Date): { name: string; data: Buffer } {
  const s = h.status();
  const c = h.currentConfig;
  const resolveProcess = os === 'win32' ? 'Resolve.exe' : 'Resolve';
  const tryOr = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  const primary = screen.getPrimaryDisplay().id;
  const files = reportFiles({
    console: log.format(consoleHeader()),
    system: {
      jogstick: app.getVersion(),
      packaged,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        native: n.nativeVersion(),
      },
      os: {
        platform: process.platform,
        version: process.getSystemVersion(),
        kernel: osRelease(),
        arch: process.arch,
        locale: app.getLocale(),
      },
      displays: screen.getAllDisplays().map((d) => ({
        size: [d.size.width, d.size.height],
        scaleFactor: d.scaleFactor,
        primary: d.id === primary,
      })),
      resolve: {
        process: resolveProcess,
        running: tryOr(() => n.isProcessRunning(resolveProcess), null),
        inFront: s.resolveFront,
        lastSeenInFront: h.diagnostics.lastResolve,
      },
      jogstickElevated: h.diagnostics.jogstickElevated,
      accessibility: os === 'darwin' ? tryOr(() => n.axIsTrusted(false), null) : 'n/a',
      gate: s.gate,
      paused: s.paused,
      testMode: s.testMode,
      warnings: [...warnings.values()],
    },
    controller: {
      connected: s.pad.connected,
      name: s.pad.name,
      source: padSource?.kind ?? null,
      xinputSlots: os === 'win32' ? tryOr(() => n.padList(), null) : 'n/a',
      mode: s.mode,
      layers: s.layers,
    },
    profile: { source: c.profileSource, ...c.profile },
    overrides: c.overrides,
    settings: c.settings,
    keymap: {
      os,
      unboundCommands: unboundCommands(c.profile, os, c.keymap, c.overrides),
      overridden: Object.keys(c.overrides),
    },
    gateEvents: collector.gateEvents,
    errors: collector.errors,
    redact: { home: app.getPath('home'), user: tryOr(() => userInfo().username, '') },
    createdAt: at,
  });
  return { name: reportName(at), data: zip(files, at) };
}

async function exportReport(): Promise<void> {
  if (!host || !native) return;
  let report: { name: string; data: Buffer };
  try {
    report = buildReport(host, native, new Date());
  } catch (e) {
    log.add('error', `test report: ${String(e)}`);
    void dialog.showMessageBox({
      type: 'error',
      message: 'Jogstick could not build the test report.',
      detail: String(e),
    });
    return;
  }
  const path = saveReport(report.name, report.data);
  if (!path) {
    void dialog.showMessageBox({
      type: 'error',
      message: 'Jogstick could not save the test report.',
      detail: `Tried: ${reportDirs().join(', ')}`,
    });
    return;
  }
  const r = await dialog.showMessageBox({
    type: 'info',
    message: 'Test report saved',
    detail: `${path}\n\nSend this .zip file back. It holds Jogstick's own log and settings only: no personal files, and nothing was sent anywhere.`,
    buttons: [SHOW_IN_FOLDER, 'OK'],
    defaultId: 0,
  });
  if (r.response === 0) shell.showItemInFolder(path);
}

const SHOW_IN_FOLDER = os === 'darwin' ? 'Show in Finder' : 'Show in folder';

/** Write a report zip in the first writable folder of reportDirs(); never overwrites. */
function saveReport(name: string, data: Buffer): string | null {
  for (const dir of reportDirs()) {
    let path = join(dir, name);
    try {
      // Never overwrite an earlier report (two clicks in the same second): -2, -3, …
      for (let i = 2; ; i++) {
        try {
          writeFileSync(path, data, { flag: 'wx' });
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 99) throw e;
          path = join(dir, name.replace(/\.zip$/, `-${i}.zip`));
        }
      }
    } catch (e) {
      log.add('warn', `test report: can't write in ${dir} (${String(e)}); trying the next folder`);
      continue;
    }
    log.add('app', `test report saved: ${path}`);
    return path;
  }
  log.add('error', 'test report: no folder could be written');
  return null;
}

/**
 * The native module didn't load, so Jogstick can't run. Never quit silently: save a report with
 * what can be collected without it, show the exact error and where the report is, then exit 1.
 */
async function reportLoadFailure(e: unknown): Promise<void> {
  const err = e instanceof Error ? e : new Error(String(e));
  const at = new Date();
  const dir = nativeDir();
  let nativeFiles: Record<string, number> | null;
  try {
    nativeFiles = Object.fromEntries(
      readdirSync(dir).map((f) => [f, statSync(join(dir, f)).size] as const),
    );
  } catch {
    nativeFiles = null; // the folder is missing (or unreadable): the report says so
  }
  let path: string | null = null;
  try {
    const files = loadFailureFiles({
      console: log.format(consoleHeader()),
      system: {
        jogstick: app.getVersion(),
        packaged,
        versions: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          modules: process.versions.modules,
        },
        os: {
          platform: process.platform,
          version: process.getSystemVersion(),
          kernel: osRelease(),
          arch: process.arch,
          locale: app.getLocale(),
        },
        appPath: process.execPath,
      },
      error: {
        message: err.message,
        code: (err as NodeJS.ErrnoException).code,
        stack: err.stack,
      },
      nativeFiles,
      nativeDir: dir,
      redact: { home: app.getPath('home'), user: safeUser() },
      createdAt: at,
    });
    path = saveReport(reportName(at), zip(files, at));
  } catch (re) {
    log.add('error', `load-failure report: ${String(re)}`);
  }
  const detail = [
    err.message,
    '',
    path
      ? `A report was saved here:\n${path}\n\nPlease send that .zip file to whoever gave you Jogstick. It holds the error and version details only: no personal files, and nothing was sent anywhere.`
      : `Jogstick could not save a report (tried ${reportDirs().join(', ')}). Please send a screenshot of this message instead.`,
  ].join('\n');
  if (E2E_NATIVE_FAIL) {
    // The e2e driver checks the report and the dialog text; a dialog would block it.
    console.log(`E2E-LOADFAIL ${JSON.stringify({ report: path, message: err.message, detail })}`);
    app.exit(1);
    return;
  }
  if (os === 'darwin') app.focus({ steal: true });
  const r = await dialog.showMessageBox({
    type: 'error',
    message: 'Jogstick could not load its input module, so it can’t start.',
    detail,
    buttons: path ? [SHOW_IN_FOLDER, 'Quit'] : ['Quit'],
    defaultId: 0,
  });
  if (path && r.response === 0) shell.showItemInFolder(path);
  app.exit(1);
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

async function exportLog(): Promise<void> {
  const header = consoleHeader();
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
    native = E2E_NATIVE_FAIL ? loadNative(E2E_NATIVE_FAIL) : loadNative();
    log.add('app', `native ${native.nativeVersion()}`);
  } catch (e) {
    log.add('error', `loading the native addon failed: ${String(e)}`);
    void reportLoadFailure(e);
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
  padSource = pad;
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
    toggleTestMode: () => {
      if (!h.setTestMode(!h.status().testMode))
        void dialog.showMessageBox({
          type: 'info',
          message: 'Test with harness is off while DaVinci Resolve is in front.',
          detail:
            'Switch to another app first. Test mode also turns itself off whenever Resolve comes to the front.',
        });
      refreshUi();
    },
    exportReport: () => void exportReport(),
    exportLog: () => void exportLog(),
    openUserData: () => void shell.openPath(store.dir),
    openAxSettings: os === 'darwin' ? () => n.openAxSettings() : undefined,
    openWindow: openEditor,
    quit: () => app.quit(),
  });

  h.onStatus(() => refreshUi());
  h.onCommandEcho((e) => overlay?.show(echoView(e), h.status().bounds, true));
  h.onTestModeForcedOff = () => {
    if (Notification.isSupported())
      new Notification({
        title: 'Jogstick: Test with harness is off',
        body: 'DaVinci Resolve came to the front, so the controller drives Resolve again.',
      }).show();
  };

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
  if (E2E_SCRIPT && E2E_TEST_MODE) h.setTestMode(true);
  checkWarnings();
  setInterval(checkWarnings, 10_000);
  refreshUi();
}

/** E2E: script marks go to stdout for the driver (`releaseAll` also runs it here); exit when done. */
function runE2e(h: Host, n: Native, pad: ReplaySource): void {
  log.add('warn', `E2E MODE: replaying ${E2E_SCRIPT}`);
  h.onCommandEcho((e) => console.log(`E2E-ECHO ${e.what} ${e.keys}`));
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
          // macOS's session key state catches up only after the window server has taken the
          // posted events, so it is polled (5 ms steps, at most 200 ms) and the wait reported.
          const held = n.heldState();
          const t0 = Date.now();
          const settle = () => {
            const osHeld = n.osHeldState();
            const clear = osHeld.keys.length + osHeld.mods.length + osHeld.buttons.length === 0;
            if (clear || Date.now() - t0 >= 200)
              console.log(
                `E2E-RELEASED ${JSON.stringify({ held, osHeld, settledMs: Date.now() - t0 })}`,
              );
            else setTimeout(settle, 5);
          };
          settle();
        }
      },
      done: () => {
        const finish = () => {
          if (h.queueBusy) return void setTimeout(finish, 50);
          setTimeout(() => {
            // The real test report, for the driver to open and check.
            try {
              const r = buildReport(h, n, new Date());
              const path = join(app.getPath('userData'), r.name);
              writeFileSync(path, r.data);
              console.log(`E2E-REPORT ${path}`);
            } catch (e) {
              console.log(`E2E-REPORT-ERROR ${String(e)}`);
            }
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
