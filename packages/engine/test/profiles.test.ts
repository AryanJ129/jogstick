import { describe, expect, it } from 'vitest';
import { compileProfile, parseCombo } from '../src/profile';
import { parseKeymap, parseProfile, profileJsonSchema } from '../src/schema';
import resolveDefault from '../../profiles/resolve-default.json';
import resolveKeymap from '../../profiles/resolve-keymap.json';
import { testProfile } from './helpers';

describe('resolve-default + resolve-keymap', () => {
  const profile = parseProfile(resolveDefault);
  const keymap = parseKeymap(resolveKeymap);

  it('the shipped profile validates and compiles', () => {
    expect(profile.id).toBe('resolve-default');
    expect(compileProfile(resolveDefault).bindings.length).toBe(profile.bindings.length);
  });

  it('every command the profile uses is in the keymap (and every jog/shuttle command too)', () => {
    const used = new Set(
      profile.bindings.flatMap((b) => (b.action.type === 'command' ? [b.action.id] : [])),
    );
    for (const id of [
      'nav.stepFrameForward',
      'nav.stepFrameBackward',
      'nav.stepSecondForward',
      'nav.stepSecondBackward',
      'transport.playReverse',
      'transport.stop',
      'transport.playForward',
    ])
      used.add(id);
    const missing = [...used].filter((id) => !(id in keymap));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(40);
  });

  it('every non-null default parses on both OSes; unknown defaults stay null and unverified', () => {
    const entries = Object.entries(keymap);
    expect(entries.length).toBeGreaterThan(40);
    for (const [, e] of entries) {
      if (e.darwin !== null) expect(() => parseCombo(e.darwin as string)).not.toThrow();
      if (e.win32 !== null) expect(() => parseCombo(e.win32 as string)).not.toThrow();
      expect(e.verified).toBe(false);
    }
    const nulls = entries
      .filter(([, e]) => e.darwin === null || e.win32 === null)
      .map(([id]) => id);
    expect(nulls.sort()).toEqual(['color.nextNode', 'color.prevNode', 'edit.pasteInsert']);
  });

  it('no Cmd on Windows, no Ctrl standing in for Cmd on macOS', () => {
    for (const e of Object.values(keymap)) {
      if (e.win32) expect(parseCombo(e.win32).mods).not.toContain('Cmd');
      if (e.darwin) expect(parseCombo(e.darwin).mods).not.toContain('Ctrl');
    }
  });

  it('generates a JSON Schema for profile files', () => {
    const schema = profileJsonSchema();
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties as object)).toEqual(
      expect.arrayContaining(['version', 'modes', 'layers', 'fine', 'bindings', 'settings']),
    );
  });
});

describe('schema rules', () => {
  const bad =
    (bindings: unknown[], extra: Record<string, unknown> = {}) =>
    () =>
      parseProfile(testProfile(bindings as never, extra as never));

  it('settings get defaults, including axisLockRatio and hapticDetents', () => {
    const p = parseProfile(testProfile([]));
    expect(p.settings).toMatchObject({
      deadzone: 0.12,
      axisLockRatio: 1.5,
      hapticDetents: true,
      chordWindowMs: 60,
    });
  });

  it('rejects a jog on a button, a shuttle on a stick, a digital action on an axis without dir', () => {
    expect(
      bad([{ mode: 'edit', input: 'a', action: { type: 'jog', rate: { min: 1, max: 2 } } }]),
    ).toThrow(/stick axis/);
    expect(
      bad([
        {
          mode: 'edit',
          input: 'lstick.x',
          action: { type: 'shuttle', dir: 'forward', zones: [0.2] },
        },
      ]),
    ).toThrow(/lt or rt/);
    expect(
      bad([{ mode: 'edit', input: 'lstick.y', action: { type: 'command', id: 'view.zoomIn' } }]),
    ).toThrow(/dir/);
    expect(
      bad([{ mode: 'edit', input: 'lstick', action: { type: 'command', id: 'view.zoomIn' } }]),
    ).toThrow(/2-D stick/);
  });

  it('rejects unknown modes and layers, and gestures on analog inputs', () => {
    expect(bad([{ mode: 'nope', input: 'a', action: { type: 'none' } }])).toThrow(/unknown mode/);
    expect(bad([{ mode: 'edit', input: 'a', layer: 'ghost', action: { type: 'none' } }])).toThrow(
      /unknown layer/,
    );
    expect(
      bad([
        {
          mode: 'edit',
          input: 'lstick.x',
          gesture: 'hold',
          action: { type: 'jog', rate: { min: 1, max: 2 } },
        },
      ]),
    ).toThrow(/gestures/);
    expect(bad([], { layers: [{ id: 'l', hold: 'lb', modes: ['zzz'] }] })).toThrow(/unknown mode/);
  });

  it('rejects unknown properties (typos) and invalid command ids', () => {
    expect(bad([{ mode: 'edit', input: 'a', action: { type: 'command', id: 'nodot' } }])).toThrow();
    expect(bad([{ mode: 'edit', input: 'a', acton: { type: 'none' } }])).toThrow();
  });
});

describe('parseCombo', () => {
  it('parses modifiers, letters, digits, punctuation aliases and W3C codes', () => {
    expect(parseCombo('Mod+B')).toEqual({ code: 'KeyB', mods: ['Mod'] });
    expect(parseCombo('Mod+Shift+[')).toEqual({ code: 'BracketLeft', mods: ['Shift', 'Mod'] });
    expect(parseCombo('Alt+Mod+G')).toEqual({ code: 'KeyG', mods: ['Alt', 'Mod'] });
    expect(parseCombo('Cmd+-')).toEqual({ code: 'Minus', mods: ['Cmd'] });
    expect(parseCombo('Ctrl+=')).toEqual({ code: 'Equal', mods: ['Ctrl'] });
    expect(parseCombo('Shift+Backspace')).toEqual({ code: 'Backspace', mods: ['Shift'] });
    expect(parseCombo('F13')).toEqual({ code: 'F13', mods: [] });
    expect(parseCombo('7')).toEqual({ code: 'Digit7', mods: [] });
    expect(parseCombo('Option+Left')).toEqual({ code: 'ArrowLeft', mods: ['Alt'] });
    expect(parseCombo('Shift')).toEqual({ code: null, mods: ['Shift'] });
  });

  it('rejects unknown keys and two non-modifier keys', () => {
    expect(() => parseCombo('Mod+Foo')).toThrow(/unknown key/);
    expect(() => parseCombo('A+B')).toThrow(/more than one/);
    expect(() => parseCombo('  ')).toThrow(/empty/);
  });
});
