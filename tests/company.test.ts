import { describe, expect, it } from 'vitest';
import { straightRidge } from '../src/terrain/synthetic';
import { placeEnemyCompany, COMPANY } from '../src/tactics/companyDefence';
import { bearingVector, type Point } from '../src/terrain/grid';

// A 4 km box at 10 m: a broad ridge running east–west 1 km north of the start.
const ground = straightRidge(4000, 10, { ridgeY: 1000, heightM: 40, halfWidthM: 900, base: 100 });
for (let i = 0; i < ground.data.length; i++) {
  // Some gentle folds along the ridge, so not every position is equal.
  const c = i % ground.width;
  ground.data[i] += 4 * Math.sin(c / 25);
}

const along = (p: Point, bearing: number) => {
  const u = bearingVector(bearing);
  return { f: p.x * u.x + p.y * u.y, l: p.x * u.y - p.y * u.x };
};

describe('enemy company defence', () => {
  const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: true, dummies: true, dispersed: false, droneConcealment: false, isrFires: true } })!;

  it('has two platoons forward and one in depth, at doctrinal spacing', () => {
    expect(L).not.toBeNull();
    expect(L.advanceBearingDeg).toBe(0);
    const fwd = L.platoons.filter((p) => p.role === 'forward');
    const depth = L.platoons.filter((p) => p.role === 'depth');
    expect(fwd).toHaveLength(2);
    expect(depth).toHaveLength(1);
    const a = along(fwd[0].centre, 0), b = along(fwd[1].centre, 0), d = along(depth[0].centre, 0);
    const sep = Math.abs(a.l - b.l);
    expect(sep).toBeGreaterThanOrEqual(COMPANY.forwardSpacingM[0]);
    expect(sep).toBeLessThanOrEqual(COMPANY.forwardSpacingM[1]);
    const behind = d.f - (a.f + b.f) / 2;
    expect(behind).toBeGreaterThanOrEqual(COMPANY.depthBehindM[0]);
    expect(behind).toBeLessThanOrEqual(COMPANY.depthBehindM[1]);
    // Depth platoon sits between the forward two.
    expect(d.l).toBeGreaterThanOrEqual(Math.min(a.l, b.l) - 100);
    expect(d.l).toBeLessThanOrEqual(Math.max(a.l, b.l) + 100);
  });

  it('puts three sections in each platoon, spaced apart, and leaves a gap', () => {
    for (const p of L.platoons) {
      const s = p.positions.filter((x) => x.kind === 'section');
      expect(s.length).toBeGreaterThanOrEqual(2);
      expect(s.length).toBeLessThanOrEqual(3);
    }
    expect(L.gaps).toHaveLength(1);
    expect(L.gaps[0].widthM).toBeGreaterThan(150);
    expect(L.hq).not.toBeNull();
  });

  it('includes the optional elements when asked', () => {
    expect(L.mines).not.toBeNull();
    expect(L.mines!.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(L.dummies.length).toBeGreaterThan(0);
    expect(L.reasons.join(' ')).toMatch(/drone surveillance/);
  });

  it('uses small dispersed teams when asked', () => {
    const D = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { dispersed: true, mines: false, dummies: false, droneConcealment: false, isrFires: false } })!;
    const teams = D.platoons[0].positions.filter((x) => x.kind === 'team');
    expect(teams.length).toBeGreaterThan(3);
    expect(teams[0].men).toBeLessThanOrEqual(4);
    expect(D.mines).toBeNull();
  });

  it('chooses the optional elements the same way for the same seed', () => {
    const a = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], seed: 7 })!;
    const b = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], seed: 7 })!;
    expect(a.options).toEqual(b.options);
  });

  it('runs all four directions in reasonable time', () => {
    const t = performance.now();
    placeEnemyCompany({ grid: ground, layers: null, seed: 1 });
    const ms = performance.now() - t;
    console.log(`company defence, 4 directions, 4 km at 10 m: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(30000);
  }, 60000);
});

describe('dummy positions', () => {
  it('sit within the enemy area, not out in front of it', () => {
    const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { dummies: true, mines: false, dispersed: false, droneConcealment: false, isrFires: false } })!;
    const front = Math.min(...L.platoons.filter((p) => p.role === 'forward').flatMap((p) => p.positions.map((x) => x.point.y)));
    for (const d of L.dummies) expect(d.point.y).toBeGreaterThanOrEqual(front - 310);
  });
});

describe('mutual support and interlocking arcs', () => {
  it('reports interlocking arcs and which positions support each other', () => {
    const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: false, dummies: false, dispersed: false, droneConcealment: false, isrFires: false } })!;
    expect(L.interlock).toBeGreaterThan(0.3);
    expect(L.support.length).toBeGreaterThanOrEqual(6);
    // Most positions should be supported by at least one other.
    const supported = L.support.filter((s) => s.supportedBy.length > 0).length;
    expect(supported / L.support.length).toBeGreaterThan(0.6);
    expect(L.reasons.join(' ')).toMatch(/Interlocking arcs: \d+%/);
    expect(L.reasons.join(' ')).toMatch(/Mutual support: \d+ of \d+/);
  });
});

describe('any of the 16 compass points', () => {
  it('names the 16 points', async () => {
    const { compass16 } = await import('../src/tactics/companyDefence');
    expect(compass16(0)).toBe('north');
    expect(compass16(22.5)).toBe('north-north-east');
    expect(compass16(67.5)).toBe('east-north-east');
    expect(compass16(337.5)).toBe('north-north-west');
    expect(compass16(359)).toBe('north');
  });
  it('places a company across a diagonal advance', () => {
    const L2 = placeEnemyCompany({ grid: ground, layers: null, bearings: [22.5], options: { mines: false, dummies: false, dispersed: false, droneConcealment: false, isrFires: false } });
    expect(L2).not.toBeNull();
    expect(L2!.advanceBearingDeg).toBe(22.5);
    // Every forward position lies ahead along the advance.
    for (const p of L2!.platoons.filter((q) => q.role === 'forward').flatMap((q) => q.positions)) expect(along(p.point, 22.5).f).toBeGreaterThan(300);
    expect(L2!.reasons[0]).toMatch(/on 0400 mils/);
  });
});

describe('minefields as APP-6 outlines (PO, 23 Nov 2026)', () => {
  it('splits mined ground into separate fields, each outlined, and drops scraps', async () => {
    const { minefieldOutlines } = await import('../src/tactics/companyDefence');
    const W = 50, H = 50, cell = 10;
    const m = new Uint8Array(W * H);
    for (let r = 5; r < 10; r++) for (let c = 5; c < 20; c++) m[r * W + c] = 1; // 150 x 50 m
    for (let r = 30; r < 36; r++) for (let c = 30; c < 40; c++) m[r * W + c] = 1; // 100 x 60 m, far away
    m[45 * W + 2] = 1; // a single cell: a scrap
    const o = minefieldOutlines(m, W, H, cell);
    expect(o.length).toBe(2);
    const xs = o[0].map((p) => p.x), ys = o[0].map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(150);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(50);
  });
});
