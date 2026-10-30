import { describe, expect, it } from 'vitest';
import { checkKeymap, resolveCommand, unboundCommands } from '../src/keymap';
import {
  HostSettingsSchema,
  KeymapOverridesSchema,
  parseKeymap,
  parseProfile,
} from '../src/schema';
import resolveDefault from '../../profiles/resolve-default.json';
import resolveKeymap from '../../profiles/resolve-keymap.json';

const profile = parseProfile(resolveDefault);
const keymap = parseKeymap(resolveKeymap);
const known = () => true;

describe('resolveCommand', () => {
  it('uses the shipped default when there is no override', () => {
    const r = resolveCommand('edit.paste', 'win32', keymap);
    expect(r.source).toBe('default');
    expect(r.text).toBe(keymap['edit.paste']?.win32);
    expect(r.text).toBe('Ctrl+V');
  });

  it('an override for this OS wins; the other OS keeps its default', () => {
    const o = KeymapOverridesSchema.parse({ 'edit.paste': { win32: 'F13' } });
    expect(resolveCommand('edit.paste', 'win32', keymap, o)).toEqual({
      combo: { code: 'F13', mods: [] },
      source: 'override',
      text: 'F13',
    });
    expect(resolveCommand('edit.paste', 'darwin', keymap, o).source).toBe('default');
  });

  it('an override of null unbinds the command', () => {
    const o = KeymapOverridesSchema.parse({ 'edit.paste': { win32: null } });
    expect(resolveCommand('edit.paste', 'win32', keymap, o)).toEqual({
      combo: null,
      source: 'unbound',
      text: null,
    });
  });

  it('an unknown command is unbound', () => {
    expect(resolveCommand('nope.nothing', 'darwin', keymap).source).toBe('unbound');
  });
});

describe('checkKeymap', () => {
  it('the shipped profile + keymap are clean', () => {
    expect(checkKeymap(profile, keymap, {}, known)).toEqual([]);
  });

  it('reports unknown override ids, bad combos and keys the build cannot send', () => {
    const o = KeymapOverridesSchema.parse({
      'nope.nothing': { win32: 'F1' },
      'edit.paste': { win32: 'A+B', darwin: 'F24' },
    });
    const issues = checkKeymap(profile, keymap, o, (c) => c !== 'F24');
    expect(issues.map((i) => i.path).sort()).toEqual([
      'edit.paste.darwin',
      'edit.paste.win32',
      'nope.nothing',
    ]);
  });

  it('Windows rules: no Win key, no lone Alt (on macOS both are fine)', () => {
    const o = KeymapOverridesSchema.parse({
      'edit.paste': { win32: 'Cmd+V', darwin: 'Cmd+V' },
      'edit.copy': { win32: 'Alt', darwin: 'Alt' },
      'edit.cut': { win32: 'Alt+X' },
    });
    const issues = checkKeymap(profile, keymap, o, known);
    expect(issues.map((i) => i.path).sort()).toEqual(['edit.copy.win32', 'edit.paste.win32']);
    expect(checkKeymap(profile, keymap, {}, known, 'win32')).toEqual([]);
  });
});

describe('unboundCommands', () => {
  it('lists bound commands with no shortcut on that OS', () => {
    const o = KeymapOverridesSchema.parse({ 'edit.paste': { darwin: null } });
    expect(unboundCommands(profile, 'darwin', keymap, o)).toContain('edit.paste');
    expect(unboundCommands(profile, 'win32', keymap, o)).not.toContain('edit.paste');
  });
});

describe('host schemas', () => {
  it('settings default from an empty object', () => {
    expect(HostSettingsSchema.parse({})).toEqual({
      activeProfile: 'resolve-default',
      overlay: { enabled: true, corner: 'topRight' },
    });
  });

  it('rejects unknown keys and bad command ids', () => {
    expect(() => HostSettingsSchema.parse({ typo: 1 })).toThrow();
    expect(() => KeymapOverridesSchema.parse({ 'Bad Id': { win32: 'F1' } })).toThrow();
    expect(() => KeymapOverridesSchema.parse({ 'edit.x': { linux: 'F1' } })).toThrow();
  });
});
