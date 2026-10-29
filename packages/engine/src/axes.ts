import type { Curve, Settings } from './schema';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Map a normalized deflection 0..1 through a response curve. */
export function applyCurve(curve: Curve, n: number): number {
  const x = clamp01(n);
  if (Array.isArray(curve)) {
    // Piecewise-linear through evenly spaced control points from x=0 to x=1.
    const segments = curve.length - 1;
    const pos = x * segments;
    const i = Math.min(Math.floor(pos), segments - 1);
    const a = curve[i] ?? 0;
    const b = curve[i + 1] ?? a;
    return a + (b - a) * (pos - i);
  }
  switch (curve) {
    case 'linear':
      return x;
    case 'quad':
      return x * x;
    case 'cubic':
      return x * x * x;
    case 'sCurve':
      return x * x * (3 - 2 * x);
  }
}

export interface StickVector {
  /** Normalized deflection after deadzones, before the curve (0..1). */
  n: number;
  x: number;
  y: number;
}

/**
 * Radial deadzone → outer deadzone → normalize → curve → direction via atan2.
 * Returns the curved vector; `n` is the pre-curve normalized magnitude.
 */
export function processStick(
  x: number,
  y: number,
  settings: Pick<Settings, 'deadzone' | 'outerDeadzone'>,
  curve: Curve = 'linear',
): StickVector {
  const mag = Math.hypot(x, y);
  if (mag <= settings.deadzone) return { n: 0, x: 0, y: 0 };
  const n = clamp01((mag - settings.deadzone) / (settings.outerDeadzone - settings.deadzone));
  const c = applyCurve(curve, n);
  const theta = Math.atan2(y, x);
  return { n, x: c * Math.cos(theta), y: c * Math.sin(theta) };
}

/** Scalar trigger deadzone, normalized to 0..1. */
export function processTrigger(v: number, triggerDeadzone: number): number {
  if (v <= triggerDeadzone) return 0;
  return clamp01((v - triggerDeadzone) / (1 - triggerDeadzone));
}

const EPS = 1e-9;

/** Split an accumulator into whole pixels to emit now and the carried sub-pixel remainder. */
export function takeWhole(acc: number): [whole: number, rest: number] {
  // Without EPS, 125 × 2.4 px sums to 299.9999… and a pixel is lost to float drift.
  const whole = Math.trunc(acc + Math.sign(acc) * EPS);
  return [whole, acc - whole];
}

/** Axis-lock wait before falling back to the larger axis. */
export const AXIS_LOCK_FALLBACK_MS = 40;

/**
 * Decide which axis a stick locks to. Locks immediately when one axis dominates by
 * `ratio`, otherwise to the larger axis once `AXIS_LOCK_FALLBACK_MS` has passed.
 */
export function decideLock(
  ax: number,
  ay: number,
  ratio: number,
  elapsedMs: number,
): 'x' | 'y' | null {
  const a = Math.abs(ax);
  const b = Math.abs(ay);
  // EPS absorbs float error so an exact ratio (0.6 vs 1.5·0.4) counts as reached.
  if (a > 0 && a >= ratio * b - EPS) return 'x';
  if (b > 0 && b >= ratio * a - EPS) return 'y';
  if (elapsedMs >= AXIS_LOCK_FALLBACK_MS) return a >= b ? 'x' : 'y';
  return null;
}

/** Shuttle zone for a raw trigger value: the number of thresholds reached (0 = below the first). */
export function zoneOf(raw: number, zones: number[], triggerDeadzone: number): number {
  if (raw <= triggerDeadzone) return 0;
  let z = 0;
  for (const t of zones) if (raw >= t) z++;
  return z;
}
