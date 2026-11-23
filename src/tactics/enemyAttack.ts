/**
 * The attacking enemy, for defensive problems (PO, 23 Nov 2026: platoon defence
 * first, then enabling actions, then company). The reverse of the enemy company
 * generator: here the enemy comes to you.
 *
 * Russian doctrine with the lessons of Ukraine (first figures, PO to confirm):
 * - recce and drones find the position first; artillery and mortars then fall
 *   on whatever was seen;
 * - small dismounted assault groups (8–12 men) close on foot, using dead
 *   ground, rather than a massed mounted assault;
 * - a small infiltration team works round a flank through cover;
 * - BMPs (or ATGM teams) give fire support from overwatch 1–2.5 km away,
 *   where they can see the position;
 * - where the going allows, a mounted axis along the best route for vehicles.
 *
 * Everything is computed from the ground: what can be seen from your area,
 * the least-cost approaches (cheap in dead ground for the dismounted groups),
 * and the viewpoints that overlook you. Nothing is guessed (core principle 1).
 */
import { bearingVector, cellToPoint, distance, pointToCell, type Grid, type Mask, type Point } from '../terrain/grid';
import { lineOfSight, viewshed, type Obstacles } from '../terrain/viewshed';
import { slope as slopeOf } from '../terrain/slope';
import { COVER, type FeatureLayers } from '../features/layers';
import { costDistance, slopeOnlyGoing } from './approach';
import { analysisGrids } from './sectionDefence';

export interface AttackOptions {
  /** Enemy drones watch the area before the attack. */
  drones: boolean;
  /** Artillery and mortars fire on what is seen. */
  artillery: boolean;
  /** BMPs give fire support from overwatch, and may use a mounted axis. */
  mounted: boolean;
  /** A small team tries to work round a flank through cover. */
  infiltration: boolean;
}

export const ATTACK = {
  /** Chance of each option when not set (first figures, PO to tune). */
  chance: { drones: 0.8, artillery: 0.7, mounted: 0.6, infiltration: 0.7 } as Record<keyof AttackOptions, number>,
  /** The enemy forms up this far from your area. */
  assemblyM: [2400, 3200] as const,
  /** Overwatch (fire support) positions: this far from your area, within this angle of the threat. */
  overwatchM: [900, 2500] as const,
  overwatchHalfAngleDeg: 60,
  /** Our men in the area: dug in, eye at 1.2 m; an attacker moving crouched shows 1.5 m. */
  ourEyeM: 1.2,
  attackerM: 1.5,
  /** A dug-in position shows 0.5 m; a BMP's sight is about 2.5 m up. */
  positionShowsM: 0.5,
  overwatchEyeM: 2.5,
  /** How far we look out from the area. */
  viewRangeM: 2000,
  /** Dismounted cost multiplier in ground seen from the area (main groups, infiltration). */
  seenPenalty: { main: 2.5, infiltration: 10 },
  /**
   * Near your area, ground more than this far beyond either flank of it (in
   * the neighbouring platoons' areas) costs this much more to cross.
   */
  flankMarginM: 300,
  flankDepthM: 1200,
  widePenalty: 6,
  /** Dismounted pace across country, km/h; mounted pace, km/h. */
  footKmh: 2.5,
  mountedKmh: 12,
};

export interface AttackAxis {
  name: string;
  kind: 'mounted' | 'dismounted' | 'infiltration';
  /** Who moves on it. */
  group: string;
  path: Point[];
  lengthM: number;
  /** Share of the axis within the view range that can be seen from your area. */
  seenShare: number;
  /** Closest the axis comes to the centre of your area while still in dead ground (metres). */
  lastDeadM: number;
  /** Where that is. */
  lastDead: Point;
}

export interface Overwatch {
  point: Point;
  label: string;
  /** Share of your area it overlooks. */
  seesShare: number;
  distanceM: number;
}

export interface EnemyAttack {
  /** Bearing from your area towards the enemy. */
  threatBearingDeg: number;
  centre: Point;
  /** Your area: frontage across the threat, metres. */
  frontageM: number;
  assembly: Point;
  axes: AttackAxis[];
  overwatch: Overwatch[];
  options: AttackOptions;
  /** "A reinforced motor rifle company: …" */
  strength: string;
  /** Ground within the view range, on the enemy's side, that no one in your area can see. */
  deadFromArea: Mask;
  /** Ground seen from your area. */
  seenFromArea: Mask;
  maskWidth: number;
  maskHeight: number;
  maskCellM: number;
  reasons: string[];
}

export interface AttackInput {
  grid: Grid;
  layers: FeatureLayers | null;
  obstacles?: Obstacles | null;
  /** Bearing from your area towards the enemy (the threat). */
  threatBearingDeg: number;
  /** Your platoon area: centre and frontage. */
  centre?: Point;
  frontageM: number;
  options?: Partial<AttackOptions>;
  seed?: number;
  /** A union viewshed of the area already worked out (it does not depend on the threat). */
  seen?: Mask;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points spread over your area (a square of side `frontageM`), from which it looks out. */
export function areaSamples(centre: Point, frontageM: number): Point[] {
  const out: Point[] = [];
  const h = frontageM / 2;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) out.push({ x: centre.x - h + (i * frontageM) / 4, y: centre.y - h + (j * frontageM) / 4 });
  return out;
}

/** What can be seen from anywhere in your area (dug in, looking for a crouching man). */
export function seenFromArea(cg: Grid, centre: Point, frontageM: number, obstacles?: Obstacles): Mask {
  const seen = new Uint8Array(cg.width * cg.height);
  for (const p of areaSamples(centre, frontageM)) {
    const vs = viewshed(cg, p, { obsHeightM: ATTACK.ourEyeM, targetHeightM: ATTACK.attackerM, maxRangeM: ATTACK.viewRangeM, obstacles });
    for (let i = 0; i < seen.length; i++) if (vs[i]) seen[i] = 1;
  }
  return seen;
}

/** The analysis grid (10 m) used for the attack, as for the enemy company. */
export const attackGrids = (input: Pick<AttackInput, 'grid' | 'layers' | 'obstacles'>) =>
  analysisGrids({ grid: input.grid, layers: input.layers, obstacles: input.obstacles }, 10);

export function planEnemyAttack(input: AttackInput): EnemyAttack | null {
  const random = rng((input.seed ?? 1) ^ 0xa77ac);
  const base = attackGrids(input);
  const cg = base.cg;
  const lay = base.layers;
  const obstacles = base.obstacles;
  const W = cg.width, H = cg.height, N = W * H;
  const going = lay ? lay.going : slopeOnlyGoing(slopeOf(cg));
  const centre = input.centre ?? { x: 0, y: 0 };
  const u = bearingVector(input.threatBearingDeg);
  const half = (W * cg.cellM) / 2;
  const inBox = (p: Point, m = 200) => Math.abs(p.x) <= half - m && Math.abs(p.y) <= half - m;
  const cellOf = (p: Point) => {
    const c = pointToCell(cg, p);
    return c.col >= 0 && c.row >= 0 && c.col < W && c.row < H ? c.row * W + c.col : -1;
  };
  const opt = (k: keyof AttackOptions) => input.options?.[k] ?? random() < ATTACK.chance[k];
  const options: AttackOptions = { drones: opt('drones'), artillery: opt('artillery'), mounted: opt('mounted'), infiltration: opt('infiltration') };
  const reasons: string[] = [];

  const seen = input.seen ?? seenFromArea(cg, centre, input.frontageM, obstacles);
  // Dead ground: on the enemy's side of the area, within the view range, seen from nowhere in it.
  const dead = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (seen[i]) continue;
    const q = cellToPoint(cg, i % W, Math.floor(i / W));
    const d = distance(q, centre);
    const f = (q.x - centre.x) * u.x + (q.y - centre.y) * u.y;
    if (d <= ATTACK.viewRangeM && f > input.frontageM / 2) dead[i] = 1;
  }

  // ---- Assembly area: on the threat side, out of your sight, on good going ----
  let assembly: Point | null = null, bestA = Infinity;
  for (let a = -40; a <= 40; a += 10)
    for (const r of [ATTACK.assemblyM[0], (ATTACK.assemblyM[0] + ATTACK.assemblyM[1]) / 2, ATTACK.assemblyM[1]]) {
      const b = bearingVector(input.threatBearingDeg + a);
      const p = { x: centre.x + b.x * r, y: centre.y + b.y * r };
      if (!inBox(p, 250)) continue;
      const i = cellOf(p);
      if (i < 0 || !Number.isFinite(going[i])) continue;
      const score = going[i] + (seen[i] ? 5 : 0) + Math.abs(a) / 40 + random() * 0.5;
      if (score < bestA) [bestA, assembly] = [score, p];
    }
  if (!assembly) return null;
  const s0 = cellOf(assembly);

  // ---- Axes ----
  const routeTo = (cost: Float32Array, target: Point): Point[] | null => {
    const { cost: cd, prev } = costDistance(cg, cost, [s0]);
    const e = cellOf(target);
    if (e < 0 || !Number.isFinite(cd[e])) return null;
    const cells: number[] = [];
    for (let i = e; i >= 0; i = prev[i]) cells.push(i);
    if (cells[cells.length - 1] !== s0) return null;
    cells.reverse();
    return cells.map((i) => cellToPoint(cg, i % W, Math.floor(i / W)));
  };
  // The attack comes at your platoon: ground well out to either side belongs to the
  // platoons and companies there, so the assault groups keep off it near your area.
  const vv = { x: u.y, y: -u.x };
  const wide = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const q = cellToPoint(cg, i % W, Math.floor(i / W));
    const l = Math.abs((q.x - centre.x) * vv.x + (q.y - centre.y) * vv.y);
    const f = (q.x - centre.x) * u.x + (q.y - centre.y) * u.y;
    if (l > input.frontageM / 2 + ATTACK.flankMarginM && f < ATTACK.flankDepthM) wide[i] = 1;
  }
  const weighted = (k: number, mountedOnly = false) => {
    const c = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let g = going[i];
      if (mountedOnly && lay && (lay.cover[i] === COVER.wood || lay.cover[i] === COVER.building)) g = Infinity;
      if (wide[i]) g *= ATTACK.widePenalty;
      c[i] = seen[i] ? g * k : g;
    }
    return c;
  };
  const facts = (path: Point[]) => {
    let len = 0, inRange = 0, seenLen = 0, lastDeadM = Infinity, lastDead = path[0];
    for (let k = 1; k < path.length; k++) {
      const d = distance(path[k - 1], path[k]);
      len += d;
      const dc = distance(path[k], centre);
      const i = cellOf(path[k]);
      if (dc <= ATTACK.viewRangeM) {
        inRange += d;
        if (i >= 0 && seen[i]) seenLen += d;
        else if (dc < lastDeadM && dc > input.frontageM / 4) [lastDeadM, lastDead] = [dc, path[k]];
      }
    }
    return { lengthM: len, seenShare: inRange ? seenLen / inRange : 0, lastDeadM, lastDead };
  };
  const axes: AttackAxis[] = [];
  const v = { x: u.y, y: -u.x };
  const main = routeTo(weighted(ATTACK.seenPenalty.main), centre);
  if (!main) return null;
  axes.push({ name: 'Axis 1', kind: 'dismounted', group: 'Assault group 1, about ten men on foot', path: main, ...facts(main) });
  // A second assault group: towards the other half of the area, if its route differs.
  {
    const side = random() < 0.5 ? 1 : -1;
    const t = { x: centre.x + v.x * side * input.frontageM * 0.4, y: centre.y + v.y * side * input.frontageM * 0.4 };
    const p = routeTo(weighted(ATTACK.seenPenalty.main * 1.5), t);
    if (p && differs(p, main)) axes.push({ name: 'Axis 2', kind: 'dismounted', group: 'Assault group 2, about ten men on foot', path: p, ...facts(p) });
  }
  if (options.infiltration) {
    // Round a flank, as far as possible in dead ground: whichever flank is cheaper.
    let best: Point[] | null = null, bestCost = Infinity;
    const cost = weighted(ATTACK.seenPenalty.infiltration);
    const { cost: cd } = costDistance(cg, cost, [s0]);
    for (const side of [1, -1]) {
      const t = { x: centre.x + v.x * side * (input.frontageM / 2 + 150), y: centre.y + v.y * side * (input.frontageM / 2 + 150) };
      const e = cellOf(t);
      if (e >= 0 && cd[e] < bestCost) [bestCost, best] = [cd[e], routeTo(cost, t)];
    }
    if (best && axes.every((a) => differs(best!, a.path)))
      axes.push({ name: 'Infiltration', kind: 'infiltration', group: 'An infiltration team of four or five men', path: best, ...facts(best) });
  }
  if (options.mounted) {
    const p = routeTo(weighted(1, true), centre);
    if (p && axes.every((a) => differs(p, a.path)))
      axes.push({ name: 'Mounted axis', kind: 'mounted', group: 'Two or three BMPs', path: p, ...facts(p) });
  }

  // ---- Overwatch: the viewpoints on the enemy's side that see most of your area ----
  const targets = areaSamples(centre, input.frontageM);
  const cands: Overwatch[] = [];
  const step = 100;
  const R1 = ATTACK.overwatchM[1];
  for (let y = -R1; y <= R1; y += step)
    for (let x = -R1; x <= R1; x += step) {
      const p = { x: centre.x + x, y: centre.y + y };
      const d = Math.hypot(x, y);
      if (d < ATTACK.overwatchM[0] || d > R1 || !inBox(p, 100)) continue;
      const ang = (Math.acos(Math.max(-1, Math.min(1, (x * u.x + y * u.y) / d))) * 180) / Math.PI;
      if (ang > ATTACK.overwatchHalfAngleDeg) continue;
      const i = cellOf(p);
      if (i < 0 || !Number.isFinite(going[i])) continue;
      let n = 0;
      for (const t of targets) if (lineOfSight(cg, p, t, ATTACK.overwatchEyeM, ATTACK.positionShowsM, false, obstacles)) n++;
      if (n) cands.push({ point: p, label: '', seesShare: n / targets.length, distanceM: d });
    }
  cands.sort((a, b) => b.seesShare - a.seesShare || a.distanceM - b.distanceM);
  const overwatch: Overwatch[] = [];
  for (const c of cands) {
    if (overwatch.length >= 2) break;
    if (overwatch.every((o) => distance(o.point, c.point) >= 500)) overwatch.push(c);
  }
  overwatch.forEach((o, k) => (o.label = options.mounted ? `BMPs ${k + 1}` : `ATGM and MG ${k + 1}`));

  const strength =
    'A reinforced motor rifle company: ' +
    `${axes.filter((a) => a.kind === 'dismounted').length} assault group${axes.filter((a) => a.kind === 'dismounted').length > 1 ? 's' : ''} of about ten men on foot` +
    (options.infiltration && axes.some((a) => a.kind === 'infiltration') ? ', an infiltration team of four or five' : '') +
    (options.mounted ? ', and BMPs in fire support' : ', with machine guns and anti-tank missiles in fire support') +
    (options.artillery ? '; mortars and artillery on call' : '') +
    (options.drones ? '; reconnaissance and attack drones overhead' : '') + '.';

  reasons.push(`The enemy forms up about ${Math.round(distance(assembly, centre) / 100) / 10} km away and attacks on ${axes.length > 1 ? `${axes.length} axes` : 'one axis'}.`);
  for (const a of axes)
    reasons.push(
      `${a.name} (${a.group}): ${Math.round(a.lengthM / 100) / 10} km; ${Math.round(a.seenShare * 100)}% of it within ${ATTACK.viewRangeM / 1000} km of your area can be seen from it` +
        (Number.isFinite(a.lastDeadM) ? `; it stays in dead ground until about ${Math.round(a.lastDeadM / 10) * 10} m from the centre of your area.` : '.'),
    );
  for (const o of overwatch) reasons.push(`${o.label}: overwatch ${Math.round(o.distanceM / 10) * 10} m away, overlooking ${Math.round(o.seesShare * 100)}% of your area.`);

  return {
    threatBearingDeg: input.threatBearingDeg,
    centre,
    frontageM: input.frontageM,
    assembly,
    axes,
    overwatch,
    options,
    strength,
    deadFromArea: dead,
    seenFromArea: seen,
    maskWidth: W,
    maskHeight: H,
    maskCellM: cg.cellM,
    reasons,
  };
}

/** Two routes differ if at least a third of one lies more than 100 m from the other. */
function differs(a: Point[], b: Point[]): boolean {
  let far = 0, n = 0;
  for (let k = 0; k < a.length; k += 5) {
    n++;
    let m = Infinity;
    for (let j = 0; j < b.length; j += 3) m = Math.min(m, distance(a[k], b[j]));
    if (m > 100) far++;
  }
  return n > 0 && far / n >= 0.33;
}
