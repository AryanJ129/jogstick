import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Log } from '../src/main/log';
import {
  loadErrorCauses,
  loadFailureFiles,
  redactor,
  ReportCollector,
  reportFiles,
  reportName,
  zip,
} from '../src/main/report';
import type { ReportInput } from '../src/main/report';

/** Read a zip back through its central directory (what unzip/Explorer do), checking each CRC. */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(at)).toBe(0x04034b50);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const data = inflateRawSync(buf.subarray(start, start + size));
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString('utf8'));
    p += 46 + nameLen;
  }
  return out;
}

const home = process.platform === 'win32' ? 'C:\\Users\\Tester' : '/Users/tester';

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    console: `header\n2026 store reloaded ${home}/Library/Application Support/Jogstick/settings.json\n`,
    system: { jogstick: '0.1.0-rc.1', userData: `${home}/AppData/Roaming/Jogstick` },
    controller: { connected: true, name: 'Xbox controller (slot 1)' },
    profile: { id: 'resolve-default' },
    overrides: { 'edit.pasteInsert': { win32: 'F13' } },
    settings: { activeProfile: 'resolve-default' },
    keymap: { unbound: ['edit.pasteInsert'] },
    gateEvents: [{ at: 0, kind: 'gate', msg: 'open (open, Resolve.exe)' }],
    errors: [],
    redact: { home, user: 'tester' },
    createdAt: new Date(2026, 9, 30, 14, 25, 1),
    ...over,
  };
}

describe('test report', () => {
  it('zips every part, readable with matching CRCs', () => {
    const files = reportFiles(input());
    const back = unzip(zip(files, new Date(2026, 9, 30, 14, 25, 1)));
    expect([...back.keys()]).toEqual([
      'README.txt',
      'console.txt',
      'system.json',
      'controller.json',
      'profile.json',
      'keymap-overrides.json',
      'settings.json',
      'keymap.json',
      'gate-events.txt',
      'errors.txt',
    ]);
    expect(JSON.parse(back.get('keymap-overrides.json') ?? '')).toEqual({
      'edit.pasteInsert': { win32: 'F13' },
    });
    expect(back.get('gate-events.txt')).toContain('open (open, Resolve.exe)');
    expect(back.get('errors.txt')).toBe('(none)\n');
  });

  it('the system unzip tool accepts it', () => {
    let has = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      has = false;
    }
    if (!has) return; // Windows runners: the central-directory read above is the check there.
    const dir = mkdtempSync(join(tmpdir(), 'jogstick-report-'));
    try {
      const path = join(dir, 'r.zip');
      writeFileSync(path, zip(reportFiles(input()), new Date()));
      const out = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
      expect(out).toContain('No errors detected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no home folder or user name survives, in any file', () => {
    const files = reportFiles(input());
    for (const f of files) {
      expect(f.data.toLowerCase()).not.toContain('tester');
    }
    const sys = files.find((f) => f.name === 'system.json')?.data ?? '';
    expect(sys).toContain('~/AppData/Roaming/Jogstick');
  });

  it('redaction handles both slash styles and case, and leaves short names alone', () => {
    const r = redactor('C:\\Users\\Ann', 'Ann');
    expect(r('C:\\Users\\Ann\\x and c:/users/ann/y')).toBe('~\\x and ~/y');
    // Inside a .json file backslashes are escaped; the home folder must still go, even when the
    // user name rule can't help (a name under 3 letters, or a folder named differently).
    const json = JSON.stringify({ p: 'C:\\Users\\Al\\AppData' });
    expect(redactor('C:\\Users\\Al', 'Al')(json)).toBe(JSON.stringify({ p: '~\\AppData' }));
    expect(redactor('C:\\Users\\Ann', 'someoneelse')(JSON.stringify(['C:\\Users\\Ann']))).toBe(
      '["~"]',
    );
    const short = redactor('/Users/al', 'al');
    expect(short('/Users/al/x final')).toBe('~/x final');
  });

  it('redaction also catches 8.3 short names, other profiles and non-ASCII names', () => {
    const r = redactor('C:\\Users\\Christopher', 'Christopher');
    expect(r('temp C:\\Users\\CHRIST~1\\AppData\\Local\\Temp\\x')).toBe(
      'temp ~\\AppData\\Local\\Temp\\x',
    );
    expect(r(JSON.stringify('D:\\Users\\Other\\y'))).toBe(JSON.stringify('~\\y'));
    expect(redactor('/Users/jose', 'José')('user José here, /Users/maria/x')).toBe(
      'user <user> here, ~/x',
    );
  });

  it('the collector keeps gate events and errors after the Console rolls over', () => {
    const log = new Log(5);
    const c = new ReportCollector(log, 3);
    log.add('gate', 'open');
    for (let i = 0; i < 10; i++) log.add('frame', `f${i}`);
    log.add('warn', 'w1');
    log.add('error', 'e1');
    expect(log.all().some((e) => e.msg === 'open')).toBe(false);
    expect(c.gateEvents.map((e) => e.msg)).toEqual(['open']);
    expect(c.errors.map((e) => e.msg)).toEqual(['w1', 'e1']);
  });

  it('a native load failure still makes a report: the exact error, the module folder, versions', () => {
    const files = loadFailureFiles({
      console: 'start\nerror loading the native addon failed\n',
      system: { jogstick: '0.1.0-rc.2', os: { platform: 'win32' } },
      error: {
        message: `\\\\?\\${home}\\Jogstick\\resources\\native\\jogstick-native.win32-x64-msvc.node is not a valid Win32 application.`,
        code: 'ERR_DLOPEN_FAILED',
        stack: 'Error: …\n    at Module._extensions..node',
      },
      nativeFiles: { 'index.js': 37534, 'jogstick-native.win32-x64-msvc.node': 0 },
      nativeDir: `${home}/Jogstick/resources/native`,
      redact: { home, user: 'tester' },
      createdAt: new Date(2026, 9, 30, 9, 0, 0),
    });
    const back = unzip(zip(files, new Date()));
    expect([...back.keys()]).toEqual([
      'README.txt',
      'load-error.txt',
      'system.json',
      'console.txt',
    ]);
    const err = back.get('load-error.txt') ?? '';
    expect(err).toContain('is not a valid Win32 application.');
    expect(err).toContain('code: ERR_DLOPEN_FAILED');
    expect(err).toContain('jogstick-native.win32-x64-msvc.node  0 bytes');
    expect(JSON.parse(back.get('system.json') ?? '{}').jogstick).toBe('0.1.0-rc.2');
    for (const text of back.values()) expect(text.toLowerCase()).not.toContain('tester');

    const missing = loadFailureFiles({
      console: '',
      system: {},
      error: { message: 'Cannot find module' },
      nativeFiles: null,
      nativeDir: '/x',
      redact: { home, user: 'tester' },
      createdAt: new Date(),
    });
    expect(missing.find((f) => f.name === 'load-error.txt')?.data).toContain(
      '(the folder does not exist or cannot be read)',
    );
  });

  it("the exact load error is napi's cause chain, in attempt order, not its generic message", () => {
    // packages/native/index.js: createLoadErrorChain(loadErrors) links each error to the one before.
    const chain = [
      'first: not a valid Win32 application',
      'second: Cannot find module x',
    ].reduce<Error | null>((prev, msg) => {
      const e = new Error(msg);
      e.cause = prev;
      return e;
    }, null);
    const top = new Error('Cannot find native binding. npm has a bug related to optional deps');
    top.cause = chain;
    expect(loadErrorCauses(top)).toEqual([
      'first: not a valid Win32 application',
      'second: Cannot find module x',
    ]);
    expect(loadErrorCauses(new Error('plain'))).toEqual([]);
    const files = loadFailureFiles({
      console: '',
      system: {},
      error: { message: top.message, causes: loadErrorCauses(top) },
      nativeFiles: {},
      nativeDir: '/x',
      redact: { home, user: 'tester' },
      createdAt: new Date(),
    });
    expect(files.find((f) => f.name === 'load-error.txt')?.data).toContain(
      '  - first: not a valid Win32 application\n  - second: Cannot find module x',
    );
  });

  it('names the file by local date and time', () => {
    expect(reportName(new Date(2026, 9, 30, 14, 25, 1))).toBe(
      'jogstick-report-2026-10-30-142501.zip',
    );
  });
});
