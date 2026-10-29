import { bindingKey } from './profile';
import type { CompiledBinding, CompiledProfile } from './profile';
import type { InputId } from './schema';
import type { ButtonInput, Ctx, EngineState, StickId } from './types';

const ANALOG = new Set(['jog', 'shuttle', 'wheel', 'mouseMove']);
export const isAnalogBinding = (b: CompiledBinding): boolean => ANALOG.has(b.action.type);

function emitLayers(ctx: Ctx): void {
  ctx.out.push({ type: 'layerChanged', layers: [...ctx.state.layerStack], fine: ctx.state.fine });
}

const inMode = (modes: string[] | undefined, mode: string): boolean =>
  modes === undefined || modes.includes(mode);

/** Layers (and the fine modifier) that `input` activates in the current mode. */
export function activatorFor(
  profile: CompiledProfile,
  mode: string,
  input: ButtonInput,
): { layers: string[]; fine: boolean } {
  const layers = profile.source.layers
    .filter((l) => l.hold === input && inMode(l.modes, mode))
    .map((l) => l.id);
  const f = profile.source.fine;
  const fine = f !== undefined && f.hold === input && inMode(f.modes, mode);
  return { layers, fine };
}

export function activateLayers(ctx: Ctx, layers: string[], fine: boolean): void {
  const s = ctx.state;
  for (const id of layers) {
    s.layerStack = s.layerStack.filter((l) => l !== id);
    s.layerStack.push(id);
  }
  if (fine) s.fine = true;
  emitLayers(ctx);
}

export function deactivateLayers(ctx: Ctx, layers: string[], fine: boolean): void {
  const s = ctx.state;
  s.layerStack = s.layerStack.filter((l) => !layers.includes(l) || s.latched.includes(l));
  if (fine) s.fine = false;
  emitLayers(ctx);
}

/** `layerToggle`: latch a layer on, or unlatch it. */
export function toggleLayer(ctx: Ctx, id: string): void {
  const s = ctx.state;
  if (s.latched.includes(id)) {
    s.latched = s.latched.filter((l) => l !== id);
    s.layerStack = s.layerStack.filter((l) => l !== id);
  } else {
    s.latched.push(id);
    s.layerStack = s.layerStack.filter((l) => l !== id);
    s.layerStack.push(id);
  }
  emitLayers(ctx);
}

export function clearLayers(ctx: Ctx): void {
  const s = ctx.state;
  if (s.layerStack.length === 0 && !s.fine) return;
  s.layerStack = [];
  s.latched = [];
  s.fine = false;
  emitLayers(ctx);
}

/** Lookup order: most recently activated layer → … → base. */
function layerOrder(state: EngineState): (string | null)[] {
  return [...[...state.layerStack].reverse(), null];
}

function bindingsAt(state: EngineState, layer: string | null, input: InputId): CompiledBinding[] {
  return state.profile.byKey.get(bindingKey(state.mode, layer, input)) ?? [];
}

/** Digital bindings for a button in the first layer (newest first) that binds it. */
export function lookupDigital(state: EngineState, input: ButtonInput): CompiledBinding[] {
  for (const layer of layerOrder(state)) {
    const found = bindingsAt(state, layer, input).filter((b) => !isAnalogBinding(b));
    if (found.length > 0) return found;
  }
  return [];
}

/** Analog binding (shuttle / wheel master) for a trigger. */
export function lookupTrigger(state: EngineState, input: 'lt' | 'rt'): CompiledBinding | null {
  for (const layer of layerOrder(state)) {
    const found = bindingsAt(state, layer, input).find(isAnalogBinding);
    if (found) return found;
  }
  return null;
}

/** Stick bindings: the 2-D binding plus per-axis bindings, all from the same (newest) layer. */
export function lookupStick(
  state: EngineState,
  stick: StickId,
): { vec: CompiledBinding | null; x: CompiledBinding[]; y: CompiledBinding[] } {
  for (const layer of layerOrder(state)) {
    const vec = bindingsAt(state, layer, stick)[0] ?? null;
    const x = bindingsAt(state, layer, `${stick}.x`);
    const y = bindingsAt(state, layer, `${stick}.y`);
    if (vec || x.length > 0 || y.length > 0) return { vec, x, y };
  }
  return { vec: null, x: [], y: [] };
}
