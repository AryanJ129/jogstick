import { newOwner, pressAction, releaseAction, tapAction } from './actions';
import { activateLayers, activatorFor, deactivateLayers, lookupDigital } from './layers';
import type { CompiledBinding } from './profile';
import type { ButtonInput, Ctx, GestureGroup } from './types';

export function groupOf(bindings: CompiledBinding[]): GestureGroup {
  const pick = (g: CompiledBinding['gesture']) => bindings.find((b) => b.gesture === g) ?? null;
  return { tap: pick('tap'), hold: pick('hold'), doubleTap: pick('doubleTap') };
}

/**
 * A button press, resolved now (mode + layers at this instant). The resolution is
 * stored with the held input so the release dispatches exactly what was pressed.
 */
export function pressResolved(ctx: Ctx, input: ButtonInput): void {
  const s = ctx.state;
  const act = activatorFor(ctx.profile, s.mode, input);
  if (act.layers.length > 0 || act.fine) {
    activateLayers(ctx, act.layers, act.fine);
    s.held[input] = { kind: 'layer', layers: act.layers, fine: act.fine };
    return;
  }
  const group = groupOf(lookupDigital(s, input));
  if (!group.tap && !group.hold && !group.doubleTap) {
    s.held[input] = { kind: 'consumed' };
    return;
  }
  if (group.doubleTap) {
    const pending = s.pendingTaps.findIndex((p) => p.input === input);
    if (pending !== -1) {
      // Second press inside the window: the single tap is cancelled, the double tap fires.
      s.pendingTaps.splice(pending, 1);
      tapAction(ctx, group.doubleTap, input, newOwner(s, input));
      s.held[input] = { kind: 'consumed' };
      return;
    }
  }
  if (group.hold || group.doubleTap) {
    s.held[input] = { kind: 'gesture', group, pressedAt: ctx.now, holdFired: false };
    return;
  }
  const binding = group.tap as CompiledBinding;
  const owner = newOwner(s, input);
  s.held[input] = { kind: 'action', binding, owner };
  pressAction(ctx, binding, input, owner);
}

export function releaseResolved(ctx: Ctx, input: ButtonInput): void {
  const s = ctx.state;
  const entry = s.held[input];
  s.held[input] = undefined;
  if (!entry) return;
  switch (entry.kind) {
    case 'layer':
      deactivateLayers(ctx, entry.layers, entry.fine);
      return;
    case 'action':
      releaseAction(ctx, entry.binding, entry.owner);
      return;
    case 'gesture': {
      if (entry.holdFired) return;
      const { tap, doubleTap } = entry.group;
      if (!tap) return;
      if (doubleTap) {
        s.pendingTaps.push({
          input,
          binding: tap,
          deadline: ctx.now + ctx.profile.settings.doubleTapWindowMs,
        });
        return;
      }
      tapAction(ctx, tap, input, newOwner(s, input));
      return;
    }
    case 'consumed':
      return;
  }
}

/** Hold thresholds and deferred single taps that are due at `ctx.now`. */
export function runGestureTimers(ctx: Ctx): void {
  const s = ctx.state;
  const threshold = ctx.profile.settings.holdThresholdMs;
  for (const [input, entry] of Object.entries(s.held) as [
    ButtonInput,
    (typeof s.held)[ButtonInput],
  ][]) {
    if (entry?.kind !== 'gesture' || entry.holdFired || !entry.group.hold) continue;
    if (ctx.now - entry.pressedAt >= threshold) {
      entry.holdFired = true;
      tapAction(ctx, entry.group.hold, input, newOwner(s, input));
    }
  }
  const due = s.pendingTaps.filter((p) => p.deadline <= ctx.now);
  if (due.length === 0) return;
  s.pendingTaps = s.pendingTaps.filter((p) => p.deadline > ctx.now);
  for (const p of due) tapAction(ctx, p.binding, p.input, newOwner(s, p.input));
}

export function gestureWake(ctx: Pick<Ctx, 'state' | 'profile'>): number | null {
  let wake: number | null = null;
  const consider = (t: number) => {
    if (wake === null || t < wake) wake = t;
  };
  for (const entry of Object.values(ctx.state.held))
    if (entry?.kind === 'gesture' && entry.group.hold && !entry.holdFired)
      consider(entry.pressedAt + ctx.profile.settings.holdThresholdMs);
  for (const p of ctx.state.pendingTaps) consider(p.deadline);
  return wake;
}
