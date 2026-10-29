import { canonicalMods } from './profile';
import type { CompiledBinding, ParsedCombo } from './profile';
import { toggleLayer } from './layers';
import type { ButtonInput, Ctx, EngineState, Holder, Mod, MouseBtn } from './types';

export function newOwner(state: EngineState, input: string): string {
  state.seq += 1;
  return `${input}#${state.seq}`;
}

/** Modifiers held by standalone bare-modifier bindings. */
export function standaloneMods(state: EngineState): Mod[] {
  return state.mods.map((h) => h.key);
}

function acquire<K>(list: Holder<K>[], key: K, owner: string): boolean {
  const h = list.find((x) => x.key === key);
  if (h) {
    h.owners.push(owner);
    return false;
  }
  list.push({ key, owners: [owner] });
  return true;
}

function release<K>(list: Holder<K>[], key: K, owner: string): boolean {
  const i = list.findIndex((x) => x.key === key);
  const h = list[i];
  if (!h) return false;
  const j = h.owners.indexOf(owner);
  if (j === -1) return false;
  h.owners.splice(j, 1);
  if (h.owners.length > 0) return false;
  list.splice(i, 1);
  return true;
}

// --- keys --------------------------------------------------------------------

export function keyDown(ctx: Ctx, combo: ParsedCombo, owner: string): void {
  if (combo.code === null) {
    for (const mod of combo.mods) modDown(ctx, mod, owner);
    return;
  }
  if (acquire(ctx.state.keys, combo.code, owner))
    ctx.out.push({
      type: 'keyDown',
      code: combo.code,
      mods: canonicalMods([...combo.mods, ...standaloneMods(ctx.state)]),
      owner,
    });
}

export function keyUp(ctx: Ctx, combo: ParsedCombo, owner: string): void {
  if (combo.code === null) {
    for (const mod of [...combo.mods].reverse()) modUp(ctx, mod, owner);
    return;
  }
  if (release(ctx.state.keys, combo.code, owner))
    ctx.out.push({ type: 'keyUp', code: combo.code, owner });
}

export function keyTap(ctx: Ctx, combo: ParsedCombo, owner: string): void {
  // A key another binding is holding down can't be tapped without releasing it; skip.
  if (combo.code !== null && ctx.state.keys.some((h) => h.key === combo.code)) return;
  keyDown(ctx, combo, owner);
  keyUp(ctx, combo, owner);
}

function modDown(ctx: Ctx, mod: Mod, owner: string): void {
  if (acquire(ctx.state.mods, mod, owner)) ctx.out.push({ type: 'modifierDown', mod, owner });
}

function modUp(ctx: Ctx, mod: Mod, owner: string): void {
  if (release(ctx.state.mods, mod, owner)) ctx.out.push({ type: 'modifierUp', mod, owner });
}

// --- Resolve commands --------------------------------------------------------

export function commandTap(ctx: Ctx, id: string, owner: string): void {
  ctx.out.push({ type: 'command', id, phase: 'tap', mods: standaloneMods(ctx.state), owner });
}

export function commandDown(ctx: Ctx, id: string, owner: string): void {
  if (acquire(ctx.state.cmdHolds, id, owner))
    ctx.out.push({ type: 'command', id, phase: 'down', mods: standaloneMods(ctx.state), owner });
}

export function commandUp(ctx: Ctx, id: string, owner: string): void {
  if (release(ctx.state.cmdHolds, id, owner))
    ctx.out.push({ type: 'command', id, phase: 'up', mods: [], owner });
}

// --- mouse buttons -----------------------------------------------------------

function mouseDown(ctx: Ctx, button: MouseBtn, owner: string): void {
  if (acquire(ctx.state.mouse, button, owner))
    ctx.out.push({ type: 'mouseButton', button, down: true });
}

function mouseUp(ctx: Ctx, button: MouseBtn, owner: string): void {
  if (release(ctx.state.mouse, button, owner))
    ctx.out.push({ type: 'mouseButton', button, down: false });
}

// --- binding dispatch --------------------------------------------------------

function isBareModifier(b: CompiledBinding): boolean {
  return b.action.type === 'key' && b.action.parsed?.code === null;
}

/** Press of a binding resolved at press time; the matching release goes through releaseAction. */
export function pressAction(
  ctx: Ctx,
  b: CompiledBinding,
  input: ButtonInput | null,
  owner: string,
): void {
  const a = b.action;
  switch (a.type) {
    case 'command':
      if (a.hold) commandDown(ctx, a.id, owner);
      else commandTap(ctx, a.id, owner);
      if (a.repeat && !a.hold)
        ctx.state.repeats.push({
          owner,
          binding: b,
          nextAt: ctx.now + a.repeat.delayMs,
          intervalMs: a.repeat.intervalMs,
        });
      return;
    case 'key': {
      const combo = a.parsed as ParsedCombo;
      if (a.hold || isBareModifier(b)) keyDown(ctx, combo, owner);
      else keyTap(ctx, combo, owner);
      if (a.repeat && !a.hold && combo.code !== null)
        ctx.state.repeats.push({
          owner,
          binding: b,
          nextAt: ctx.now + a.repeat.delayMs,
          intervalMs: a.repeat.intervalMs,
        });
      return;
    }
    case 'mouseButton':
      mouseDown(ctx, a.button, owner);
      return;
    default:
      tapAction(ctx, b, input, owner);
  }
}

export function releaseAction(ctx: Ctx, b: CompiledBinding, owner: string): void {
  const a = b.action;
  ctx.state.repeats = ctx.state.repeats.filter((r) => r.owner !== owner);
  switch (a.type) {
    case 'command':
      if (a.hold) commandUp(ctx, a.id, owner);
      return;
    case 'key':
      if (a.hold || isBareModifier(b)) keyUp(ctx, a.parsed as ParsedCombo, owner);
      return;
    case 'mouseButton':
      mouseUp(ctx, a.button, owner);
      return;
    default:
      return;
  }
}

/** Fire a binding as a complete tap (gesture results, chord taps, macros). */
export function tapAction(
  ctx: Ctx,
  b: CompiledBinding,
  input: ButtonInput | null,
  owner: string,
): void {
  const a = b.action;
  switch (a.type) {
    case 'command':
      commandTap(ctx, a.id, owner);
      return;
    case 'key':
      keyTap(ctx, a.parsed as ParsedCombo, owner);
      return;
    case 'mouseButton':
      mouseDown(ctx, a.button, owner);
      mouseUp(ctx, a.button, owner);
      return;
    case 'scroll':
      ctx.out.push({ type: 'scroll', dx: a.dx, dy: a.dy, units: a.units });
      return;
    case 'keySeq':
      // Pressing a macro's input again cancels the running copy and restarts it.
      ctx.state.seqs = ctx.state.seqs.filter((s) => input === null || s.input !== input);
      ctx.state.seqs.push({ owner, input, steps: a.parsedSteps ?? [], index: 0, nextAt: ctx.now });
      runSeqs(ctx);
      return;
    case 'modeSet':
      ctx.switchMode(a.mode);
      return;
    case 'layerToggle':
      toggleLayer(ctx, a.layer);
      return;
    default:
      return;
  }
}

export function runRepeats(ctx: Ctx): void {
  for (const r of ctx.state.repeats) {
    while (r.nextAt <= ctx.now) {
      const a = r.binding.action;
      if (a.type === 'command') commandTap(ctx, a.id, r.owner);
      else if (a.type === 'key') keyTap(ctx, a.parsed as ParsedCombo, r.owner);
      r.nextAt += r.intervalMs;
    }
  }
}

export function runSeqs(ctx: Ctx): void {
  for (const s of ctx.state.seqs) {
    while (s.index < s.steps.length && s.nextAt <= ctx.now) {
      const stepDef = s.steps[s.index] as ParsedCombo | { delayMs: number };
      s.index += 1;
      if ('delayMs' in stepDef) s.nextAt += stepDef.delayMs;
      else keyTap(ctx, stepDef, s.owner);
    }
  }
  ctx.state.seqs = ctx.state.seqs.filter((s) => s.index < s.steps.length);
}

/** Release every key, command hold, mouse button and modifier: mouse buttons → keys → modifiers. */
export function releaseOutputs(ctx: Ctx): void {
  const s = ctx.state;
  for (const h of [...s.mouse].reverse())
    ctx.out.push({ type: 'mouseButton', button: h.key, down: false });
  for (const h of [...s.cmdHolds].reverse())
    ctx.out.push({
      type: 'command',
      id: h.key,
      phase: 'up',
      mods: [],
      owner: h.owners[0] ?? 'releaseAll',
    });
  for (const h of [...s.keys].reverse())
    ctx.out.push({ type: 'keyUp', code: h.key, owner: h.owners[0] ?? 'releaseAll' });
  for (const h of [...s.mods].reverse())
    ctx.out.push({ type: 'modifierUp', mod: h.key, owner: h.owners[0] ?? 'releaseAll' });
  s.mouse = [];
  s.cmdHolds = [];
  s.keys = [];
  s.mods = [];
}
