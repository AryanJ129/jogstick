import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import resolveDefault from '../../../packages/profiles/resolve-default.json';
import resolveKeymap from '../../../packages/profiles/resolve-keymap.json';
import { Log } from '../src/main/log';
import { OVERRIDES, SETTINGS, Store } from '../src/main/store';

const shipped = { profiles: { 'resolve-default': resolveDefault }, keymap: resolveKeymap };
let dir: string;
let log: Log;

const write = (rel: string, v: unknown) =>
  writeFileSync(join(dir, rel), typeof v === 'string' ? v : JSON.stringify(v));
const errors = () =>
  log
    .all()
    .filter((e) => e.kind === 'error')
    .map((e) => e.msg);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jogstick-store-'));
  mkdirSync(join(dir, 'profiles'));
  log = new Log();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Store', () => {
  it('no files: shipped resolve-default, no overrides', () => {
    const s = new Store(dir, shipped, log, () => true);
    expect(s.current.profile.id).toBe('resolve-default');
    expect(s.current.profileSource).toBe('shipped');
    expect(s.current.overrides).toEqual({});
    expect(errors()).toEqual([]);
  });

  it('a valid override file applies on reload', () => {
    const s = new Store(dir, shipped, log, () => true);
    write(OVERRIDES, { 'edit.pasteInsert': { win32: 'F13', darwin: 'F13' } });
    expect(s.apply(OVERRIDES)).toBe(true);
    expect(s.current.overrides['edit.pasteInsert']?.darwin).toBe('F13');
  });

  it('an invalid file is logged and the last good version stays', () => {
    const s = new Store(dir, shipped, log, () => true);
    write(OVERRIDES, { 'edit.pasteInsert': { darwin: 'F13' } });
    s.apply(OVERRIDES);
    write(OVERRIDES, '{ not json');
    expect(s.apply(OVERRIDES)).toBe(false);
    write(OVERRIDES, { 'edit.pasteInsert': { darwin: 'A+B' } });
    expect(s.apply(OVERRIDES)).toBe(false);
    write(OVERRIDES, { 'no.suchCommand': { darwin: 'F1' } });
    expect(s.apply(OVERRIDES)).toBe(false);
    expect(s.current.overrides['edit.pasteInsert']?.darwin).toBe('F13');
    expect(errors()).toHaveLength(3);
  });

  it('keys the addon cannot send are rejected', () => {
    const s = new Store(dir, shipped, log, (c) => c !== 'F13');
    write(OVERRIDES, { 'edit.pasteInsert': { darwin: 'F13' } });
    expect(s.apply(OVERRIDES)).toBe(false);
    expect(errors()[0]).toMatch(/F13 can't be sent/);
  });

  it('switching to a user profile; its id must match the file name', () => {
    const s = new Store(dir, shipped, log, () => true);
    const mine = { ...resolveDefault, id: 'my-resolve', name: 'My Resolve' };
    write('profiles/my-resolve.json', mine);
    write(SETTINGS, { activeProfile: 'my-resolve' });
    expect(s.apply(SETTINGS)).toBe(true);
    expect(s.current.profile.id).toBe('my-resolve');
    expect(s.current.profileSource).toBe('user');
    write('profiles/my-resolve.json', { ...mine, id: 'other' });
    expect(s.apply('profiles/my-resolve.json')).toBe(false);
    expect(s.current.profile.id).toBe('my-resolve');
  });

  it('an active profile that does not exist keeps the current one', () => {
    const s = new Store(dir, shipped, log, () => true);
    write(SETTINGS, { activeProfile: 'missing' });
    expect(s.apply(SETTINGS)).toBe(false);
    expect(s.current.profile.id).toBe('resolve-default');
  });

  it('a bad file at startup falls back to defaults and says so', () => {
    write(SETTINGS, { activeProfile: 'missing' });
    write(OVERRIDES, { 'edit.pasteInsert': { win32: 7 } });
    const s = new Store(dir, shipped, log, () => true);
    expect(s.current.profile.id).toBe('resolve-default');
    expect(s.current.overrides).toEqual({});
    expect(errors()).toEqual([
      expect.stringMatching(/^keymap-overrides\.json: edit\.pasteInsert\.win32: /),
      expect.stringMatching(/^profile missing: no file profiles\/missing\.json/),
    ]);
  });

  it('unrelated files are ignored', () => {
    const s = new Store(dir, shipped, log, () => true);
    write('profiles/not-active.json', '{');
    expect(s.apply('profiles/not-active.json')).toBe(false);
    expect(errors()).toEqual([]);
  });
});
