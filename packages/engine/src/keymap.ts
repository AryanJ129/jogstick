import { parseCombo } from './profile';
import type { ParsedCombo } from './profile';
import type { Keymap, KeymapOverrides, Profile } from './schema';

export type Os = 'win32' | 'darwin';

export interface Resolved {
  combo: ParsedCombo | null;
  source: 'override' | 'default' | 'unbound';
  /** The combo string as written, for logs. */
  text: string | null;
}

/**
 * Command id → combo for `os`: user override → shipped default → unbound
 * (ARCHITECTURE.md → Remapping (b)). An override of `null` unbinds the command.
 */
export function resolveCommand(
  id: string,
  os: Os,
  keymap: Keymap,
  overrides: KeymapOverrides = {},
): Resolved {
  const o = overrides[id];
  if (o && o[os] !== undefined) {
    const text = o[os] ?? null;
    return { combo: text ? parseCombo(text) : null, source: text ? 'override' : 'unbound', text };
  }
  const text = keymap[id]?.[os] ?? null;
  return { combo: text ? parseCombo(text) : null, source: text ? 'default' : 'unbound', text };
}

export interface KeymapIssue {
  /** JSON path for the Console, e.g. `bindings.12.action.id`. */
  path: string;
  message: string;
}

/**
 * Semantic checks zod can't do: every command a profile binds exists in the keymap,
 * every override names a known command, and every combo parses to keys this build can
 * send (`isKnownCode` comes from the native addon).
 */
export function checkKeymap(
  profile: Profile,
  keymap: Keymap,
  overrides: KeymapOverrides,
  isKnownCode: (code: string) => boolean,
): KeymapIssue[] {
  const issues: KeymapIssue[] = [];
  const checkCombo = (path: string, text: string | null | undefined) => {
    if (!text) return;
    try {
      const c = parseCombo(text);
      if (c.code !== null && !isKnownCode(c.code))
        issues.push({ path, message: `key ${c.code} can't be sent by this build` });
    } catch (e) {
      issues.push({ path, message: (e as Error).message });
    }
  };
  profile.bindings.forEach((b, i) => {
    const a = b.action;
    if (a.type === 'command' && !(a.id in keymap))
      issues.push({ path: `bindings.${i}.action.id`, message: `unknown command ${a.id}` });
    if (a.type === 'key') checkCombo(`bindings.${i}.action.combo`, a.combo);
  });
  for (const [id, o] of Object.entries(overrides)) {
    if (!(id in keymap)) issues.push({ path: id, message: `unknown command ${id}` });
    checkCombo(`${id}.win32`, o.win32);
    checkCombo(`${id}.darwin`, o.darwin);
  }
  return issues;
}

/** Commands bound in `profile` that resolve to nothing on `os` (the Setup checklist). */
export function unboundCommands(
  profile: Profile,
  os: Os,
  keymap: Keymap,
  overrides: KeymapOverrides,
): string[] {
  const ids = new Set<string>();
  for (const b of profile.bindings)
    if (
      b.action.type === 'command' &&
      resolveCommand(b.action.id, os, keymap, overrides).combo === null
    )
      ids.add(b.action.id);
  return [...ids].sort();
}
