import { crc32, deflateRawSync } from 'node:zlib';
import type { Log, LogEntry } from './log';

/**
 * "Export test report" (tray): one zip a tester sends back. Built only from what Jogstick already
 * knows — its Console, versions, the controller, the active profile/overrides, gate events and
 * errors. No files of the user's are read, nothing goes over the network, and the home folder
 * (which holds the user name) is replaced with `~` everywhere.
 */
export interface ReportFile {
  name: string;
  data: string;
}

export interface ReportInput {
  /** The Console as text (Log.format with a header). */
  console: string;
  system: Record<string, unknown>;
  controller: Record<string, unknown>;
  profile: unknown;
  overrides: unknown;
  settings: unknown;
  keymap: Record<string, unknown>;
  gateEvents: readonly LogEntry[];
  errors: readonly LogEntry[];
  /** Strings to remove from every file: the home folder, the user name. */
  redact: { home: string; user: string };
  createdAt: Date;
}

const README = `Jogstick test report

What's inside (nothing else is collected, and nothing was sent anywhere):
  console.txt           the Console: the last 2000 events (controller input, commands, gate, errors)
  system.json           Jogstick, Electron and OS versions; whether Resolve was running / in front
  controller.json       the controller Jogstick sees and how it reads it
  profile.json          the active profile (button layout)
  keymap-overrides.json your shortcut overrides (empty if you have none)
  settings.json         Jogstick's settings
  keymap.json           commands with no shortcut on this OS
  gate-events.txt       every time Jogstick started or stopped driving Resolve, and why
  errors.txt            every warning and error since Jogstick started

Your home folder and user name are replaced with ~ and <user>.
`;

function lines(entries: readonly LogEntry[]): string {
  if (entries.length === 0) return '(none)\n';
  return (
    entries.map((e) => `${new Date(e.at).toISOString()} ${e.kind.padEnd(7)} ${e.msg}`).join('\n') +
    '\n'
  );
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the home folder (either slash style, any case, and as JSON writes it: `C:\\Users\\Ann`)
 * with `~`, and the user name with `<user>`.
 */
export function redactor(home: string, user: string): (text: string) => string {
  const back = home.replace(/\//g, '\\');
  const variants = [home, home.replace(/\\/g, '/'), back, back.replace(/\\/g, '\\\\')];
  const homes = [...new Set(variants)]
    .filter((h) => h.length > 1)
    .sort((a, b) => b.length - a.length);
  const homeRe = homes.length ? new RegExp(homes.map(escapeRegExp).join('|'), 'gi') : null;
  // Only a whole word (Unicode-aware: "José"), and only a name long enough not to eat ordinary words.
  const userRe =
    user.length >= 3
      ? new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(user)}(?![\\p{L}\\p{N}_])`, 'giu')
      : null;
  return (text) => {
    let out = homeRe ? text.replace(homeRe, '~') : text;
    // Any other profile folder: 8.3 short names (C:\Users\RUNNER~1, common in %TEMP%), another
    // account, JSON-escaped backslashes, macOS /Users/<name>.
    out = out
      .replace(/[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\\/\s"']+/gi, '~')
      .replace(/(?<![\w.~])\/Users\/[^/\s"']+/g, '~');
    if (userRe) out = out.replace(userRe, '<user>');
    return out;
  };
}

export function reportFiles(r: ReportInput): ReportFile[] {
  const clean = redactor(r.redact.home, r.redact.user);
  const files: ReportFile[] = [
    { name: 'README.txt', data: README },
    { name: 'console.txt', data: r.console },
    { name: 'system.json', data: json({ createdAt: r.createdAt.toISOString(), ...r.system }) },
    { name: 'controller.json', data: json(r.controller) },
    { name: 'profile.json', data: json(r.profile) },
    { name: 'keymap-overrides.json', data: json(r.overrides) },
    { name: 'settings.json', data: json(r.settings) },
    { name: 'keymap.json', data: json(r.keymap) },
    { name: 'gate-events.txt', data: lines(r.gateEvents) },
    { name: 'errors.txt', data: lines(r.errors) },
  ];
  return files.map((f) => ({ name: f.name, data: clean(f.data) }));
}

/** `jogstick-report-2026-10-30-142501.zip` (local time, so it sorts and never collides in a session). */
export function reportName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `jogstick-report-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

/** Keeps gate events and warnings/errors since start-up: the Console's 2000 lines roll over fast. */
export class ReportCollector {
  readonly gateEvents: LogEntry[] = [];
  readonly errors: LogEntry[] = [];

  constructor(
    log: Log,
    private readonly capacity = 1000,
  ) {
    for (const e of log.all()) this.add(e);
    log.onEntry((e) => this.add(e));
  }

  private add(e: LogEntry): void {
    const list =
      e.kind === 'gate'
        ? this.gateEvents
        : e.kind === 'error' || e.kind === 'warn'
          ? this.errors
          : null;
    if (!list) return;
    list.push(e);
    if (list.length > this.capacity) list.splice(0, list.length - this.capacity);
  }
}

// --- zip (PKZIP 2.0: deflate, UTF-8 names; no dependency) ---------------------------------------

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(files: readonly ReportFile[], at: Date): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const body = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs = 0
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
