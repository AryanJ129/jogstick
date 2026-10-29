import { describe, expect, it } from 'vitest';
import { applyCurve, decideLock, processStick, processTrigger, zoneOf } from '../src/axes';

const S = { deadzone: 0.12, outerDeadzone: 0.98 };

describe('§1 deadzone + curve', () => {
  it('radial deadzone: anything with magnitude ≤ 0.12 is zero, measured radially', () => {
    expect(processStick(0.1, 0.05, S)).toEqual({ n: 0, x: 0, y: 0 });
    expect(processStick(0.12, 0, S).n).toBe(0);
    // 0.09 on each axis is inside per-axis 0.12 but radially 0.127 > 0.12: live.
    expect(processStick(0.09, 0.09, S).n).toBeGreaterThan(0);
  });

  it('outer deadzone: magnitude ≥ 0.98 is full deflection', () => {
    expect(processStick(0.98, 0, S).n).toBe(1);
    expect(processStick(1, 0, S).n).toBe(1);
    expect(processStick(0.99, 0, S).x).toBeCloseTo(1, 10);
  });

  it('normalize: (mag − inner) / (outer − inner)', () => {
    expect(processStick(0.55, 0, S).n).toBeCloseTo(0.5, 10);
  });

  it('curve: linear, quad, cubic, sCurve and custom points', () => {
    expect(applyCurve('linear', 0.5)).toBe(0.5);
    expect(applyCurve('quad', 0.5)).toBe(0.25);
    expect(applyCurve('cubic', 0.5)).toBe(0.125);
    expect(applyCurve('sCurve', 0.25)).toBeCloseTo(0.15625, 10);
    expect(applyCurve('sCurve', 0.5)).toBe(0.5);
    expect(applyCurve([0, 0.2, 1], 0.25)).toBeCloseTo(0.1, 10);
    expect(applyCurve([0, 0.2, 1], 0.75)).toBeCloseTo(0.6, 10);
    expect(applyCurve('quad', 2)).toBe(1);
    expect(applyCurve('quad', -1)).toBe(0);
  });

  it('curve is applied to the magnitude and the direction is reconstructed via atan2', () => {
    const v = processStick(0.55 / Math.SQRT2, 0.55 / Math.SQRT2, S, 'quad');
    expect(v.n).toBeCloseTo(0.5, 10);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(0.25, 10);
    expect(Math.atan2(v.y, v.x)).toBeCloseTo(Math.PI / 4, 10);
    const w = processStick(-0.3, 0.6, S, 'cubic');
    expect(Math.atan2(w.y, w.x)).toBeCloseTo(Math.atan2(0.6, -0.3), 10);
  });

  it('triggers: scalar deadzone 0.08, normalized', () => {
    expect(processTrigger(0.05, 0.08)).toBe(0);
    expect(processTrigger(0.08, 0.08)).toBe(0);
    expect(processTrigger(0.54, 0.08)).toBeCloseTo(0.5, 10);
    expect(processTrigger(1, 0.08)).toBe(1);
  });
});

describe('§2 axis lock decision', () => {
  it('locks to the dominant axis once |a| ≥ ratio·|b|', () => {
    expect(decideLock(0.6, 0.4, 1.5, 0)).toBe('x');
    expect(decideLock(0.2, -0.5, 1.5, 0)).toBe('y');
  });
  it('waits while neither axis dominates, then picks the larger after 40 ms', () => {
    expect(decideLock(0.5, 0.45, 1.5, 39)).toBeNull();
    expect(decideLock(0.5, 0.45, 1.5, 40)).toBe('x');
    expect(decideLock(0.45, -0.5, 1.5, 40)).toBe('y');
  });
});

describe('§9 shuttle zones', () => {
  it('zone = number of thresholds reached; 0 below the first or inside the trigger deadzone', () => {
    const zones = [0.15, 0.45, 0.75];
    expect(zoneOf(0.05, zones, 0.08)).toBe(0);
    expect(zoneOf(0.1, zones, 0.08)).toBe(0);
    expect(zoneOf(0.15, zones, 0.08)).toBe(1);
    expect(zoneOf(0.5, zones, 0.08)).toBe(2);
    expect(zoneOf(1, zones, 0.08)).toBe(3);
  });
});
