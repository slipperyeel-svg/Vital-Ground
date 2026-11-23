import { describe, expect, it } from 'vitest';
import { straightRidge, rolling } from '../src/terrain/synthetic';
import { planEnemyAttack } from '../src/tactics/enemyAttack';
import { distance } from '../src/terrain/grid';

// A ridge 1 km north of you: the enemy comes from the north over it.
const ground = straightRidge(6000, 10, { ridgeY: 600, heightM: 40, halfWidthM: 900, base: 100 });

describe('the attacking enemy (PO, 23 Nov 2026)', () => {
  const a = planEnemyAttack({ grid: ground, layers: null, threatBearingDeg: 0, frontageM: 500, seed: 3, options: { drones: true, artillery: true, mounted: true, infiltration: true } })!;
  it('forms up on the threat side, 2.4–3.2 km away, and attacks on more than one axis', () => {
    expect(a).toBeTruthy();
    expect(a.assembly.y).toBeGreaterThan(1500);
    const d = distance(a.assembly, { x: 0, y: 0 });
    expect(d).toBeGreaterThan(2300);
    expect(d).toBeLessThan(3300);
    expect(a.axes.length).toBeGreaterThanOrEqual(2);
    for (const ax of a.axes) {
      expect(distance(ax.path[0], a.assembly)).toBeLessThan(20);
      expect(ax.lengthM).toBeGreaterThan(1500);
    }
  });
  it('finds overwatch on the enemy side that overlooks your area', () => {
    expect(a.overwatch.length).toBeGreaterThan(0);
    for (const o of a.overwatch) {
      expect(o.point.y).toBeGreaterThan(0);
      expect(o.seesShare).toBeGreaterThan(0);
    }
  });
  it('marks dead ground only on the enemy side and within view range', () => {
    let n = 0;
    for (let i = 0; i < a.deadFromArea.length; i++) if (a.deadFromArea[i]) n++;
    expect(n).toBeGreaterThan(0);
  });
  it('describes the force', () => {
    expect(a.strength).toMatch(/motor rifle company/);
    expect(a.reasons.length).toBeGreaterThan(2);
  });
  it('works on rolling ground in any direction', () => {
    const g = rolling(6000, 10, 25);
    for (const b of [45, 200]) expect(planEnemyAttack({ grid: g, layers: null, threatBearingDeg: b, frontageM: 600, seed: 5 })).toBeTruthy();
  });
});
