import { applyCurve, zoneOf } from './axes';
import { commandDown, commandTap, commandUp } from './actions';
import type { CompiledBinding } from './profile';
import type { Ctx, StickId, TriggerId } from './types';

export const CMD = {
  stepFrameForward: 'nav.stepFrameForward',
  stepFrameBackward: 'nav.stepFrameBackward',
  stepSecondForward: 'nav.stepSecondForward',
  stepSecondBackward: 'nav.stepSecondBackward',
  playReverse: 'transport.playReverse',
  stop: 'transport.stop',
  playForward: 'transport.playForward',
} as const;

export const FAST_EDGE = 0.98;
export const FAST_EDGE_HZ = 6;
export const DETENT_MAX_FPS = 8;
export const SHUTTLE_DEBOUNCE_MS = 80;

const JOG_OWNER = 'jog';
const SHUTTLE_OWNER = 'shuttle';

// --- jog ---------------------------------------------------------------------

function jogStep(ctx: Ctx, b: CompiledBinding, d: number, sign: number): void {
  const a = b.action;
  if (a.type !== 'jog') return;
  const edge = a.fastAtEdge && d >= FAST_EDGE;
  if (edge) {
    commandTap(ctx, sign > 0 ? CMD.stepSecondForward : CMD.stepSecondBackward, JOG_OWNER);
    return;
  }
  commandTap(ctx, sign > 0 ? CMD.stepFrameForward : CMD.stepFrameBackward, JOG_OWNER);
  if (ctx.profile.settings.hapticDetents && jogRate(b, d) <= DETENT_MAX_FPS)
    ctx.out.push({ type: 'haptic', kind: 'detent' });
}

/** Frames per second for a normalized deflection: r = min + (max − min)·curve(d). */
export function jogRate(b: CompiledBinding, d: number): number {
  const a = b.action;
  if (a.type !== 'jog') return 0;
  return a.rate.min + (a.rate.max - a.rate.min) * applyCurve(a.rate.curve, d);
}

function jogInterval(b: CompiledBinding, d: number): number {
  const a = b.action;
  if (a.type === 'jog' && a.fastAtEdge && d >= FAST_EDGE) return 1000 / FAST_EDGE_HZ;
  return 1000 / jogRate(b, d);
}

export function jogStop(ctx: Ctx): void {
  ctx.state.jog.active = false;
  ctx.state.jog.stick = null;
  ctx.state.jog.acc = 0;
}

/** One tick of a jog binding. `v` is the (axis-locked) normalized axis value, −1..1. */
export function jogUpdate(ctx: Ctx, stick: StickId, b: CompiledBinding, v: number): void {
  const jog = ctx.state.jog;
  const d = Math.abs(v);
  if (d === 0) {
    if (jog.active && jog.stick === stick) jogStop(ctx);
    jog.suppressed = false;
    return;
  }
  if (jog.suppressed) return;
  const sign = Math.sign(v);
  if (!jog.active) {
    if (ctx.state.shuttle.owner !== null) endShuttle(ctx, true, true);
    jog.active = true;
    jog.stick = stick;
    jog.acc = 0;
    jog.lastAt = ctx.now;
    jogStep(ctx, b, d, sign);
    return;
  }
  jog.acc += ctx.now - jog.lastAt;
  jog.lastAt = ctx.now;
  const interval = jogInterval(b, d);
  while (jog.acc >= interval) {
    jog.acc -= interval;
    jogStep(ctx, b, d, sign);
  }
}

// --- shuttle -----------------------------------------------------------------

function releaseHolds(ctx: Ctx): void {
  const sh = ctx.state.shuttle;
  for (const id of [...sh.holds].reverse()) commandUp(ctx, id, SHUTTLE_OWNER);
  sh.holds = [];
}

/** Stop the shuttle. `sendStop` taps K; `suppress` ignores the trigger until it returns below zone 1. */
export function endShuttle(ctx: Ctx, sendStop: boolean, suppress: boolean): void {
  const sh = ctx.state.shuttle;
  const owner = sh.owner;
  releaseHolds(ctx);
  if (sendStop) commandTap(ctx, CMD.stop, SHUTTLE_OWNER);
  if (owner !== null && suppress) sh.suppressed[owner] = true;
  sh.owner = null;
  sh.binding = null;
  sh.zone = 0;
}

function applyZone(ctx: Ctx, b: CompiledBinding, zone: number): void {
  const a = b.action;
  if (a.type !== 'shuttle') return;
  const sh = ctx.state.shuttle;
  const play = a.dir === 'forward' ? CMD.playForward : CMD.playReverse;
  releaseHolds(ctx);
  if (a.slowZone && zone === 1) {
    // K held + L held = slow forward; K held + J held = slow reverse. K goes down first.
    commandDown(ctx, CMD.stop, SHUTTLE_OWNER);
    commandDown(ctx, play, SHUTTLE_OWNER);
    sh.holds = [CMD.stop, play];
  } else {
    commandTap(ctx, CMD.stop, SHUTTLE_OWNER);
    const presses = a.slowZone ? zone - 1 : zone;
    for (let i = 0; i < presses; i++) commandTap(ctx, play, SHUTTLE_OWNER);
  }
  sh.zone = zone;
}

/** One tick of a trigger's shuttle. `b` is null when the trigger has no shuttle binding (or is released). */
export function shuttleUpdate(
  ctx: Ctx,
  trig: TriggerId,
  b: CompiledBinding | null,
  raw: number,
): void {
  const sh = ctx.state.shuttle;
  const a = b?.action;
  const zone =
    b && a?.type === 'shuttle' ? zoneOf(raw, a.zones, ctx.profile.settings.triggerDeadzone) : 0;
  if (sh.suppressed[trig]) {
    if (zone === 0) sh.suppressed[trig] = false;
    sh.candidate[trig] = null;
    return;
  }
  const isOwner = sh.owner === trig;
  const current = isOwner ? sh.zone : 0;
  if (zone === current) {
    sh.candidate[trig] = null;
    return;
  }
  if (zone === 0) {
    // Releasing below the first zone stops immediately (not debounced).
    sh.candidate[trig] = null;
    if (isOwner) endShuttle(ctx, true, false);
    return;
  }
  const cand = sh.candidate[trig];
  if (!cand || cand.zone !== zone) {
    sh.candidate[trig] = { zone, since: ctx.now };
    return;
  }
  if (ctx.now - cand.since < SHUTTLE_DEBOUNCE_MS) return;
  sh.candidate[trig] = null;
  const binding = b as CompiledBinding;
  if (!isOwner) {
    // The later-pulled trigger wins; the other is treated as released.
    if (sh.owner !== null) endShuttle(ctx, false, true);
    if (ctx.state.jog.active) {
      jogStop(ctx);
      ctx.state.jog.suppressed = true;
    }
    sh.owner = trig;
    sh.binding = binding;
  }
  applyZone(ctx, binding, zone);
}
