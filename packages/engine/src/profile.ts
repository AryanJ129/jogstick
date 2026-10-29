import { parseProfile } from './schema';
import type { Action, ButtonInput, InputId, Profile, Settings } from './schema';
import type { Mod } from './types';

export interface ParsedCombo {
  /** W3C KeyboardEvent.code, or null for a bare-modifier combo ("Shift"). */
  code: string | null;
  mods: Mod[];
}

/** Actions with combos parsed at load: `parsed` for `key`, `parsedSteps` for `keySeq`. */
export type CompiledAction = Action & {
  parsed?: ParsedCombo;
  parsedSteps?: (ParsedCombo | { delayMs: number })[];
};

export interface CompiledBinding {
  index: number;
  mode: string;
  input: InputId;
  layer: string | null;
  gesture: 'tap' | 'hold' | 'doubleTap';
  dir: 1 | -1 | null;
  action: CompiledAction;
}

export interface CompiledChord {
  index: number;
  mode: string | null;
  inputs: ButtonInput[];
  /** null = the profile's mode switch (cycles to the next mode). */
  binding: CompiledBinding | null;
}

export interface CompiledProfile {
  source: Profile;
  settings: Settings;
  modes: string[];
  bindings: CompiledBinding[];
  chords: CompiledChord[];
  byKey: Map<string, CompiledBinding[]>;
}

export const MOD_ORDER: readonly Mod[] = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Cmd'];

const MOD_ALIASES: Record<string, Mod> = {
  mod: 'Mod',
  cmd: 'Cmd',
  command: 'Cmd',
  meta: 'Cmd',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
};

const KEY_ALIASES: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '=': 'Equal',
  '-': 'Minus',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  Esc: 'Escape',
  Del: 'Delete',
  Return: 'Enter',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  PgUp: 'PageUp',
  PgDn: 'PageDown',
};

const KNOWN_CODES = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'BracketLeft',
  'BracketRight',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Equal',
  'Minus',
  'Semicolon',
  'Quote',
  'Backquote',
  'CapsLock',
  'NumpadEnter',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
]);

function keyCode(token: string): string | null {
  if (/^[A-Za-z]$/.test(token)) return `Key${token.toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  const alias = KEY_ALIASES[token];
  if (alias !== undefined) return alias;
  if (/^Key[A-Z]$/.test(token) || /^Digit[0-9]$/.test(token) || /^Numpad[0-9]$/.test(token))
    return token;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(token)) return token;
  if (KNOWN_CODES.has(token)) return token;
  return null;
}

export function canonicalMods(mods: Iterable<Mod>): Mod[] {
  const set = new Set(mods);
  return MOD_ORDER.filter((m) => set.has(m));
}

/** Parse "Mod+Shift+[" style combos into a W3C code plus abstract modifiers. Throws on unknown keys. */
export function parseCombo(combo: string): ParsedCombo {
  const tokens: string[] = [];
  let rest = combo.trim();
  // A trailing "+" key ("Mod++") is not supported; "+" is only a separator.
  while (rest.length > 0) {
    const i = rest.indexOf('+', 1);
    if (i === -1) {
      tokens.push(rest);
      break;
    }
    tokens.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  const mods: Mod[] = [];
  let code: string | null = null;
  for (const raw of tokens) {
    const token = raw.trim();
    const mod = MOD_ALIASES[token.toLowerCase()];
    if (mod !== undefined) {
      mods.push(mod);
      continue;
    }
    if (code !== null) throw new Error(`combo "${combo}" has more than one non-modifier key`);
    code = keyCode(token);
    if (code === null) throw new Error(`combo "${combo}": unknown key "${token}"`);
  }
  if (code === null && mods.length === 0) throw new Error(`combo "${combo}" is empty`);
  return { code, mods: canonicalMods(mods) };
}

function compileAction(action: Action): CompiledAction {
  if (action.type === 'key') return { ...action, parsed: parseCombo(action.combo) };
  if (action.type === 'keySeq')
    return {
      ...action,
      parsedSteps: action.steps.map((s) =>
        'combo' in s ? parseCombo(s.combo) : { delayMs: s.delayMs },
      ),
    };
  return action;
}

export function bindingKey(mode: string, layer: string | null, input: InputId): string {
  return `${mode}|${layer ?? ''}|${input}`;
}

/** Validate a raw profile and precompute lookups. */
export function compileProfile(raw: unknown): CompiledProfile {
  const source = parseProfile(raw);
  const bindings: CompiledBinding[] = source.bindings.map((b, index) => ({
    index,
    mode: b.mode,
    input: b.input,
    layer: b.layer ?? null,
    gesture: b.gesture,
    dir: b.dir ?? null,
    action: compileAction(b.action),
  }));
  const byKey = new Map<string, CompiledBinding[]>();
  for (const b of bindings) {
    const key = bindingKey(b.mode, b.layer, b.input);
    const list = byKey.get(key);
    if (list) list.push(b);
    else byKey.set(key, [b]);
  }
  const chords: CompiledChord[] = [];
  if (source.modeSwitch)
    chords.push({ index: 0, mode: null, inputs: source.modeSwitch.chord, binding: null });
  source.chords.forEach((c, i) => {
    const input = c.inputs[0] as ButtonInput;
    chords.push({
      index: chords.length,
      mode: c.mode ?? null,
      inputs: c.inputs,
      binding: {
        index: -1 - i,
        mode: c.mode ?? '*',
        input,
        layer: null,
        gesture: 'tap',
        dir: null,
        action: compileAction(c.action),
      },
    });
  });
  return { source, settings: source.settings, modes: source.modes, bindings, chords, byKey };
}
