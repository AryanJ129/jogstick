import { applyCurve, processStick, processTrigger, takeWhole } from './axes';
import type { CompiledBinding } from './profile';
import type { AnalogInput, Ctx, StickState, WheelName } from './types';

/** After a drive ends, other wheel inputs stay ignored this long. */
export const DRIVE_COOLDOWN_MS = 100;

export interface DriveCandidate {
  input: AnalogInput;
  binding: CompiledBinding;
  engagedAt: number;
  /** Raw stick x/y, or raw trigger value in x. */
  x: number;
  y: number;
}

function velocity(ctx: Ctx, c: DriveCandidate): { vx: number; vy: number } {
  const a = c.binding.action;
  if (a.type !== 'wheel') return { vx: 0, vy: 0 };
  const s = ctx.profile.settings;
  const fine = ctx.state.fine ? (ctx.profile.source.fine?.multiplier ?? 1) : 1;
  const speed = a.gain * s.wheelBaseSpeed * fine;
  if (a.part === 'master') {
    const v = applyCurve(a.curve, processTrigger(c.x, s.triggerDeadzone));
    return { vx: (a.dir ?? 1) * v * speed, vy: 0 };
  }
  const p = processStick(c.x, c.y, s, a.curve);
  return { vx: p.x * speed, vy: p.y * speed };
}

export function driveEnd(ctx: Ctx): void {
  const d = ctx.state.drive;
  if (!d.active) return;
  ctx.out.push({ type: 'driveEnd' });
  d.active = null;
  d.cooldownUntil = ctx.now + DRIVE_COOLDOWN_MS;
}

/**
 * One cursor, one drive: the first wheel input to leave the deadzone owns the cursor;
 * others are ignored until it ends + DRIVE_COOLDOWN_MS.
 */
export function driveUpdate(ctx: Ctx, candidates: DriveCandidate[]): void {
  const d = ctx.state.drive;
  if (d.active) {
    const active = d.active;
    const c = candidates.find((x) => x.input === active.input);
    if (!c) {
      driveEnd(ctx);
      return;
    }
    const { vx, vy } = velocity(ctx, c);
    const dt = (ctx.now - active.lastAt) / 1000;
    active.lastAt = ctx.now;
    const [dx, restX] = takeWhole(active.accX + vx * dt);
    const [dy, restY] = takeWhole(active.accY + vy * dt);
    active.accX = restX;
    active.accY = restY;
    if (dx !== 0 || dy !== 0) ctx.out.push({ type: 'driveDelta', dx, dy });
    return;
  }
  if (ctx.now < d.cooldownUntil || candidates.length === 0) return;
  const first = [...candidates].sort((a, b) => a.engagedAt - b.engagedAt)[0] as DriveCandidate;
  const a = first.binding.action;
  if (a.type !== 'wheel') return;
  const wheel: WheelName = a.wheel === 'active' ? d.activeWheel : a.wheel;
  if (a.part === 'balance' && a.wheel !== 'active') d.activeWheel = a.wheel;
  d.active = {
    input: first.input,
    binding: first.binding,
    wheel,
    accX: 0,
    accY: 0,
    lastAt: ctx.now,
  };
  ctx.out.push({ type: 'driveStart', input: first.input, wheel, part: a.part });
}

/** Stick → relative mouse movement with sub-pixel accumulation. */
export function mouseUpdate(
  ctx: Ctx,
  stick: StickState,
  b: CompiledBinding,
  x: number,
  y: number,
): void {
  const a = b.action;
  if (a.type !== 'mouseMove') return;
  const m = stick.mouse;
  if (m.lastAt === null) {
    m.lastAt = ctx.now;
    return;
  }
  const p = processStick(x, y, ctx.profile.settings, a.curve);
  const dt = (ctx.now - m.lastAt) / 1000;
  m.lastAt = ctx.now;
  const [dx, restX] = takeWhole(m.accX + p.x * a.speed * dt);
  const [dy, restY] = takeWhole(m.accY + p.y * a.speed * dt);
  m.accX = restX;
  m.accY = restY;
  if (dx !== 0 || dy !== 0) ctx.out.push({ type: 'mouseMove', dx, dy });
}

export function mouseStop(stick: StickState): void {
  stick.mouse = { accX: 0, accY: 0, lastAt: null };
}
