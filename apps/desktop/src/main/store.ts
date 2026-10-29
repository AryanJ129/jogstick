import {
  checkKeymap,
  compileProfile,
  HostSettingsSchema,
  KeymapOverridesSchema,
  parseKeymap,
  parseProfile,
} from '@jogstick/engine';
import type { HostSettings, Keymap, KeymapOverrides, Profile } from '@jogstick/engine';
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import type { Log } from './log';

/**
 * `<userData>` files (ARCHITECTURE.md → Remapping (c)): settings.json, profiles/<id>.json,
 * keymap-overrides.json. Watched (200 ms debounce), validated with zod plus semantic checks; a bad
 * file is logged and the last good version stays active. Nothing is applied partially. Shipped
 * profiles come from the app bundle and are never written; Jogstick never writes these files.
 */
export interface Config {
  settings: HostSettings;
  profile: Profile;
  profileSource: 'shipped' | 'user';
  keymap: Keymap;
  overrides: KeymapOverrides;
}

export interface Shipped {
  profiles: Record<string, unknown>;
  keymap: unknown;
}

export const SETTINGS = 'settings.json';
export const OVERRIDES = 'keymap-overrides.json';
export const PROFILES = 'profiles';

const DEBOUNCE_MS = 200;

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

function describe(e: unknown): string {
  if (e && typeof e === 'object' && 'issues' in e && Array.isArray(e.issues))
    return (e.issues as { path: PropertyKey[]; message: string }[])
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
  return e instanceof Error ? e.message : String(e);
}

export class Store {
  private config: Config;
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listener: ((c: Config, file: string) => void) | null = null;

  constructor(
    readonly dir: string,
    private readonly shipped: Shipped,
    private readonly log: Log,
    private readonly isKnownCode: (code: string) => boolean,
  ) {
    const keymap = parseKeymap(shipped.keymap);
    const settings = this.readSettings();
    const overrides = this.readOverrides();
    const builtIn = this.shippedProfile('resolve-default');
    if (!builtIn) throw new Error('the app bundle has no resolve-default profile');
    const fallback = {
      settings: HostSettingsSchema.parse({}),
      profile: builtIn,
      profileSource: 'shipped' as const,
      keymap,
      overrides: {},
    };
    let config: Config = fallback;
    if (!settings.ok) this.reject(SETTINGS, settings.error);
    if (!overrides.ok) this.reject(OVERRIDES, overrides.error);
    const s = settings.ok ? settings.value : fallback.settings;
    const p = this.readProfile(s.activeProfile);
    if (p.ok) {
      const candidate = { ...fallback, settings: s, ...p.value };
      config = this.check(candidate, SETTINGS) ? candidate : fallback;
    } else this.log.add('error', `profile ${s.activeProfile}: ${p.error}; using resolve-default`);
    if (overrides.ok) {
      const candidate = { ...config, overrides: overrides.value };
      if (this.check(candidate, OVERRIDES)) config = candidate;
    }
    this.config = config;
  }

  get current(): Config {
    return this.config;
  }

  /** Watch `dir`; `onChange` gets the new config after every valid change. */
  start(onChange: (c: Config, file: string) => void): void {
    this.listener = onChange;
    mkdirSync(join(this.dir, PROFILES), { recursive: true });
    this.watcher = watch(this.dir, { recursive: true }, (_event, name) => {
      if (name) this.schedule(name.split(sep).join('/'));
    });
    this.watcher.on('error', (e) => this.log.add('error', `watching ${this.dir}: ${describe(e)}`));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private schedule(name: string): void {
    const prev = this.timers.get(name);
    if (prev) clearTimeout(prev);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        this.apply(name);
      }, DEBOUNCE_MS),
    );
  }

  /** Re-read one changed file (path relative to `dir`, `/`-separated). Returns whether it applied. */
  apply(name: string): boolean {
    const c = this.config;
    let candidate: Config;
    if (name === SETTINGS) {
      const s = this.readSettings();
      if (!s.ok) return this.reject(name, s.error);
      if (s.value.activeProfile === c.settings.activeProfile)
        candidate = { ...c, settings: s.value };
      else {
        const p = this.readProfile(s.value.activeProfile);
        if (!p.ok) return this.reject(name, `profile ${s.value.activeProfile}: ${p.error}`);
        candidate = { ...c, settings: s.value, ...p.value };
      }
    } else if (name === OVERRIDES) {
      const o = this.readOverrides();
      if (!o.ok) return this.reject(name, o.error);
      candidate = { ...c, overrides: o.value };
    } else if (name === `${PROFILES}/${c.settings.activeProfile}.json`) {
      const p = this.readProfile(c.settings.activeProfile);
      if (!p.ok) return this.reject(name, p.error);
      candidate = { ...c, ...p.value };
    } else return false;
    if (!this.check(candidate, name)) return false;
    this.config = candidate;
    this.log.add('store', `reloaded ${name}`);
    this.listener?.(candidate, name);
    return true;
  }

  private reject(name: string, error: string): false {
    this.log.add('error', `${name}: ${error} (keeping the last good version)`);
    return false;
  }

  private check(c: Config, name: string): boolean {
    // The host compiles the profile when it applies it; a throw there must reject here, before the
    // store commits, or the store and the host would disagree.
    try {
      compileProfile(c.profile);
    } catch (e) {
      return this.reject(name, `profile doesn't compile: ${String(e)}`);
    }
    const os = process.platform === 'win32' ? 'win32' : 'darwin';
    const issues = checkKeymap(c.profile, c.keymap, c.overrides, this.isKnownCode, os);
    if (issues.length === 0) return true;
    return this.reject(name, issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  }

  private readJson(rel: string): Read<unknown> | null {
    const path = join(this.dir, rel);
    if (!existsSync(path)) return null;
    try {
      return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  }

  private readSettings(): Read<HostSettings> {
    const raw = this.readJson(SETTINGS);
    if (raw === null) return { ok: true, value: HostSettingsSchema.parse({}) };
    if (!raw.ok) return raw;
    const r = HostSettingsSchema.safeParse(raw.value);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: describe(r.error) };
  }

  private readOverrides(): Read<KeymapOverrides> {
    const raw = this.readJson(OVERRIDES);
    if (raw === null) return { ok: true, value: {} };
    if (!raw.ok) return raw;
    const r = KeymapOverridesSchema.safeParse(raw.value);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: describe(r.error) };
  }

  private shippedProfile(id: string): Profile | null {
    const raw = this.shipped.profiles[id];
    return raw === undefined ? null : parseProfile(raw);
  }

  /** A user profile in `profiles/<id>.json` wins over a shipped one with the same id. */
  private readProfile(id: string): Read<{ profile: Profile; profileSource: 'shipped' | 'user' }> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, error: 'not a valid profile id' };
    const raw = this.readJson(`${PROFILES}/${id}.json`);
    if (raw === null) {
      const shipped = this.shippedProfile(id);
      return shipped
        ? { ok: true, value: { profile: shipped, profileSource: 'shipped' } }
        : { ok: false, error: `no file ${PROFILES}/${id}.json and no shipped profile` };
    }
    if (!raw.ok) return raw;
    try {
      const profile = parseProfile(raw.value);
      if (profile.id !== id)
        return { ok: false, error: `its "id" is "${profile.id}", expected "${id}"` };
      return { ok: true, value: { profile, profileSource: 'user' } };
    } catch (e) {
      return { ok: false, error: describe(e) };
    }
  }
}
