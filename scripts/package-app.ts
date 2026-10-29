// Assembles a runnable Jogstick from Electron's own distribution, with no packager dependency:
//
//   pnpm -F @jogstick/native build && pnpm -F @jogstick/desktop build
//   pnpm package:app [--version 0.1.0-rc.1]
//
// Windows → dist/Jogstick-<version>-windows-x64/ (Jogstick.exe + resources/) and the zip is made
//           by CI (Compress-Archive). macOS → dist/Jogstick.app, ad-hoc signed: a local smoke test
//           of the packaged paths only (the macOS Preview build is Phase 6).
//
// Layout (what main/native.ts and main/index.ts expect when app.isPackaged):
//   resources/app/         package.json + out/ (main, preload, renderer)
//   resources/native/      index.js (napi loader) + jogstick-native.<platform>.node
//   resources/tray/        brand/tray (mac templates, win dark/light)
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const vi = args.indexOf('--version');
const desktop = createRequire(import.meta.url)(join(root, 'apps/desktop/package.json')) as {
  version: string;
};
const version = vi >= 0 ? (args[vi + 1] ?? desktop.version) : desktop.version;
const electronBin = createRequire(import.meta.url)('electron') as string;
const dist = join(root, 'dist');

function need(path: string, hint: string): string {
  if (!existsSync(path)) throw new Error(`missing ${path} (${hint})`);
  return path;
}

const out = need(join(root, 'apps/desktop/out/main/index.js'), 'pnpm -F @jogstick/desktop build');
const nativeDir = join(root, 'packages/native');
const addon = readdirSync(nativeDir).find((f) => f.endsWith('.node'));
if (!addon) throw new Error('no .node in packages/native (pnpm -F @jogstick/native build)');

function fillResources(resources: string): void {
  rmSync(join(resources, 'default_app.asar'), { force: true });
  const app = join(resources, 'app');
  mkdirSync(app, { recursive: true });
  cpSync(dirname(dirname(out)), join(app, 'out'), { recursive: true });
  const pkg = {
    name: 'jogstick',
    productName: 'Jogstick',
    version,
    type: 'module',
    main: 'out/main/index.js',
  };
  writeFileSync(join(app, 'package.json'), JSON.stringify(pkg, null, 2));
  const native = join(resources, 'native');
  mkdirSync(native, { recursive: true });
  cpSync(join(nativeDir, 'index.js'), join(native, 'index.js'));
  cpSync(join(nativeDir, addon as string), join(native, addon as string));
  cpSync(join(root, 'brand/tray'), join(resources, 'tray'), { recursive: true });
}

if (process.platform === 'win32') {
  const name = `Jogstick-${version}-windows-x64`;
  const target = join(dist, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(dirname(electronBin), target, { recursive: true });
  renameSync(join(target, 'electron.exe'), join(target, 'Jogstick.exe'));
  fillResources(join(target, 'resources'));
  cpSync(join(root, 'LICENSE'), join(target, 'LICENSE.txt'));
  cpSync(join(target, 'LICENSE'), join(target, 'LICENSE.electron.txt'));
  rmSync(join(target, 'LICENSE'), { force: true });
  console.log(target);
} else if (process.platform === 'darwin') {
  // electronBin = …/Electron.app/Contents/MacOS/Electron
  const electronApp = dirname(dirname(dirname(electronBin)));
  const target = join(dist, 'Jogstick.app');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  cpSync(electronApp, target, { recursive: true, verbatimSymlinks: true });
  fillResources(join(target, 'Contents/Resources'));
  const plist = join(target, 'Contents/Info.plist');
  const set = (key: string, type: string, value: string) => {
    // PlistBuddy's Set fails only when the key is absent; then Add it (Add's own errors throw).
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], {
        stdio: 'pipe',
      });
    } catch {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]);
    }
  };
  set('CFBundleIdentifier', 'string', 'dev.jogstick.app');
  set('CFBundleName', 'string', 'Jogstick');
  set('CFBundleDisplayName', 'string', 'Jogstick');
  set('CFBundleShortVersionString', 'string', version);
  set('LSUIElement', 'bool', 'true');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', target]);
  console.log(target);
} else throw new Error(`no packaging for ${process.platform}`);
