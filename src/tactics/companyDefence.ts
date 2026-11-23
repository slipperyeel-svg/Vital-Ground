/**
 * Enemy company defence (PO, DECISIONS.md 109–116), on Russian doctrine and
 * lessons from Ukraine:
 *
 *  - a company strongpoint across the user's line of advance: two platoon
 *    strongpoints forward (about 400 × 300 m each, 500–900 m apart, which
 *    leaves a gap between them) and one in depth behind the gap;
 *  - sections (or, if dispersed, small teams) inside each platoon area,
 *    sited by the section logic the PO approved: fields of fire, flank or
 *    rear fire, reverse slope with an outpost on the crest, concealment,
 *    little dead ground;
 *  - the depth platoon sited to see into the forward platoons' dead ground;
 *  - company HQ behind, concealed;
 *  - optional elements, each included or not per scenario (PO 113): mines and
 *    obstacles, dummy positions, dispersed small teams, concealment against
 *    drones, drone surveillance and indirect fire.
 *
 * The direction of advance whose company defence scores highest is chosen.
 * Every placement is computed from the ground; weights and distances are
 * first figures for the PO to tune.
 */
import { gridMils, milsText } from '../geo/gridref';
import { bearingVector, distance, pointToCell, type Grid, type Mask, type Point } from '../terrain/grid';
import { viewshed, type Obstacles } from '../terrain/viewshed';
import { slope as slopeOf } from '../terrain/slope';
import type { FeatureLayers } from '../features/layers';
import { OPPOSITE, SIDE_BEARING, slopeOnlyGoing, type Side } from './approach';
import {
  analysisGrids,
  buildCtx,
  crestInFront,
  fwd,
  POSTURES,
  routeTowards,
  score,
  SECTION_SCORING,
  standable,
  type Ctx,
} from './sectionDefence';

export interface CompanyOptions {
  mines: boolean;
  dummies: boolean;
  dispersed: boolean;
  droneConcealment: boolean;
  isrFires: boolean;
}
export type OptionKey = keyof CompanyOptions;

/** Chance that the generator includes each element when left to decide. PO to tune. */
export const OPTION_CHANCE: Record<OptionKey, number> = {
  mines: 0.6,
  dummies: 0.5,
  dispersed: 0.4,
  droneConcealment: 0.6,
  isrFires: 0.5,
};

/** First figures, from doctrine (DECISIONS.md 112); PO to tune. */
export const COMPANY = {
  analysisCellM: 10,
  /**
   * Forward platoon centres this far ahead of the start: within the preferred
   * distance if the ground there allows a company defence; further out (up to
   * forwardMaxM) if nothing fits nearer, or the best ground further out is at
   * least `fartherIfBetterBy` times as good. PO, 15 Nov 2026: the enemy need
   * not be within 1,300 m, and the ground should win; so 1.0: the best ground
   * anywhere in range, with nearer ground winning a tie.
   */
  forwardMinM: 600,
  forwardPreferredM: 1300,
  forwardMaxM: 2500,
  fartherIfBetterBy: 1.0,
  /** Candidate positions are searched this far either side of the main route. */
  lateralMaxM: 1300,
  sampleM: 60,
  edgeMarginM: 150,
  platoonFrontM: 400,
  platoonDepthM: 300,
  forwardSpacingM: [500, 900] as const,
  /** The two forward platoons may differ in depth by at most this. */
  forwardStaggerM: 300,
  depthBehindM: [400, 800] as const,
  sectionsPerPlatoon: 3,
  sectionSpacingM: 100,
  /** Dispersed: this many small teams per platoon, at least this far apart. */
  teamsPerPlatoon: 5,
  teamSpacingM: 100,
  /** Mines: from this far in front of the forward positions, up to this deep. */
  mineFromM: 100,
  mineDepthM: [200, 500] as const,
  /** Mines lie within this distance of an approach route. */
  mineRouteM: 120,
  routes: 3,
  /** Mutual support: the ground within this distance of a position is "its" ground. */
  supportRadiusM: 100,
  /** Weight on mutual support when choosing positions (and between the forward platoons). */
  supportWeight: 1.0,
  /** A position counts as supported if another sees at least this share of the ground around it. */
  supportedShare: 0.3,
  /** Weight on the depth platoon seeing (covering by fire) the gap between the forward platoons. */
  gapWeight: 2,
};

/** The figures in use for the company being placed: COMPANY with its distances scaled by the spread. */
let CUR: ReturnType<typeof scaledCompany> = scaledCompany(1);
function scaledCompany(f: number) {
  const C = COMPANY;
  return {
    ...C,
    scale: f,
    platoonFrontM: C.platoonFrontM * f,
    platoonDepthM: C.platoonDepthM * f,
    forwardSpacingM: [C.forwardSpacingM[0] * f, C.forwardSpacingM[1] * f] as readonly [number, number],
    forwardStaggerM: C.forwardStaggerM * f,
    depthBehindM: [C.depthBehindM[0] * f, C.depthBehindM[1] * f] as readonly [number, number],
    sectionSpacingM: C.sectionSpacingM * f,
    teamSpacingM: C.teamSpacingM * f,
  };
}

export type PositionKind = 'section' | 'team' | 'outpost' | 'hq' | 'dummy';

/**
 * How spread out the company is (PO, 20 Nov 2026: vary the distances between
 * enemy elements). Every spacing (between sections, the size of platoon areas,
 * between platoons, the depth, and each layout's own distances) is scaled by
 * the factor. "Very wide" is the Ukraine lesson: dispersed against drones and
 * artillery. Weights set how often each comes up. First figures; PO to tune.
 */
export type SpreadName = 'close' | 'standard' | 'wide' | 'very wide';
export const SPREADS: { name: SpreadName; factor: number; weight: number }[] = [
  // PO, 20 Nov 2026: favour the wider set-ups, given how common they now are.
  { name: 'close', factor: 0.75, weight: 0.5 },
  { name: 'standard', factor: 1, weight: 1 },
  { name: 'wide', factor: 1.3, weight: 2 },
  { name: 'very wide', factor: 1.6, weight: 2 },
];

/**
 * How the enemy company lays itself out (PO, 19 Nov 2026: widen the options),
 * chosen by the ground: the generator builds each layout that fits and picks
 * among those that suit the ground best, with some variety.
 */
export type LayoutType = 'twoUp' | 'oneUp' | 'threeUp' | 'strongpoint' | 'screen' | 'counterattack' | 'echelon';
export const LAYOUT_TYPES: LayoutType[] = ['twoUp', 'oneUp', 'threeUp', 'strongpoint', 'screen', 'counterattack', 'echelon'];
export const LAYOUT_NAMES: Record<LayoutType, string> = {
  twoUp: 'two up, one back',
  oneUp: 'one up, two back',
  threeUp: 'three up, in line',
  strongpoint: 'all-round strongpoint',
  screen: 'forward screen and main position',
  counterattack: 'two up, with a counter-attack force',
  echelon: 'echeloned along the route',
};
/** How often each layout is chosen when the ground suits several equally. PO to tune. */
export const LAYOUT_PRIOR: Record<LayoutType, number> = {
  twoUp: 1, oneUp: 1, threeUp: 0.7, strongpoint: 0.8, screen: 0.8, counterattack: 1, echelon: 0.7,
};

export interface EnemyPosition {
  kind: PositionKind;
  platoon: string; // '1 Pl', '2 Pl', '3 Pl', 'Coy HQ', '—'
  label: string;
  point: Point;
  /** Number of men (approximate). */
  men: number;
}

export type PlatoonRole = 'forward' | 'depth' | 'screen' | 'reserve';

export interface PlatoonArea {
  name: string;
  /** forward and depth: fighting positions; screen: teams well forward; reserve: a counter-attack force, mounted. */
  role: PlatoonRole;
  centre: Point;
  /** Corners of the platoon area (local metres), for the map. */
  outline: Point[];
  positions: EnemyPosition[];
  /** True if its main position is on a reverse slope behind a crest. */
  reverseSlope: boolean;
}

export interface Gap {
  centre: Point;
  /** Distance between the nearest positions of the two forward platoons. */
  widthM: number;
  /** Share of the gap the depth platoon can see (and cover by fire). */
  coveredFromDepth: number;
  /** Share of the gap any fighting position can see (forward or depth). */
  coveredByAny: number;
}

export interface CompanyLayout {
  /** How the company is laid out. */
  layout: LayoutType;
  /** How spread out it is, and the factor applied to every spacing. */
  spread: { name: SpreadName; factor: number };
  /** Edge nearest the attacker's side (approximate when the advance is not N/E/S/W). */
  attackerSide: Side;
  advanceBearingDeg: number;
  /** The attacker's likely routes forward from the start. */
  routes: Point[][];
  platoons: PlatoonArea[];
  hq: EnemyPosition | null;
  dummies: EnemyPosition[];
  options: CompanyOptions;
  gaps: Gap[];
  maskWidth: number;
  maskHeight: number;
  maskCellM: number;
  /** How many real positions cover each cell with fire (all round, within gun range); 2+ = interlocking. */
  killZone: Uint8Array;
  /** Ground within 300 m in front of the forward positions that no position can see. */
  deadGround: Mask;
  /** Mined and obstructed ground, if the option is on. */
  mines: Mask | null;
  /** The mined ground as separate minefields, each an outline (local metres), for APP-6 drawing. */
  minefields: Point[][];
  /** Share of the ground under fire covered by two or more positions. */
  interlock: number;
  /** For each fighting position (label), the positions that can support it by fire. */
  support: { label: string; supportedBy: string[] }[];
  reasons: string[];
  log: string[];
}

export interface CompanyInput {
  grid: Grid;
  layers: FeatureLayers | null;
  obstacles?: Obstacles | null;
  /** Force elements on or off; any left undefined are decided by the generator. */
  options?: Partial<CompanyOptions>;
  /** Seed for the generator's choices; omit for the most defensible layout and no random elements. */
  seed?: number;
  start?: Point;
  /** Attacker sides to try (advance away from them): kept for tests. */
  sides?: Side[];
  /** Advance bearings to try, degrees. Default: four at right angles, randomly turned (16 points). */
  bearings?: number[];
  /** Force a layout (DS or Developer page); otherwise the ground decides. */
  layout?: LayoutType;
  /** Force how spread out the company is; otherwise chosen at random (seeded). */
  spread?: SpreadName;
  progress?: (message: string) => void;
}

/** Small seeded random number generator (mulberry32). */
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

/** The 16 points of the compass, for an advance bearing. */
export const COMPASS16 = [
  'north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east',
  'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west',
];
export const compass16 = (bearingDeg: number) => COMPASS16[Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16];
/** The advance as a grid bearing in mils (PO, 15 Nov 2026): "on 1590 mils". */
let dirCentre: { lat: number; lon: number } | undefined;
const DIR = (bearing: number) => `on ${dirCentre ? gridMils(bearing, dirCentre.lat, dirCentre.lon) : milsText(bearing)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

interface Cand {
  p: Point;
  total: number;
  reverse: boolean;
  vs: Mask;
}

/** Up to `routes` distinct routes forward: each new one avoids the ground near the last. */
function approachRoutes(cg: Grid, going: Float32Array, start: Point, bearingDeg: number, n: number): Point[][] {
  const g = new Float32Array(going);
  const out: Point[][] = [];
  for (let k = 0; k < n; k++) {
    const r = routeTowards(cg, g, start, bearingDeg);
    if (!r) break;
    if (!out.some((o) => similar(o, r))) out.push(r);
    // Make the ground near this route three times dearer for the next.
    const R = Math.ceil(150 / cg.cellM);
    for (const q of r) {
      const c = pointToCell(cg, q);
      for (let dr = -R; dr <= R; dr++)
        for (let dc = -R; dc <= R; dc++) {
          const rr = c.row + dr, cc = c.col + dc;
          if (rr < 0 || cc < 0 || rr >= cg.height || cc >= cg.width || dr * dr + dc * dc > R * R) continue;
          const i = rr * cg.width + cc;
          if (Number.isFinite(g[i]) && g[i] === going[i]) g[i] *= 3;
        }
    }
  }
  return out;
}

/** Two routes are the same if most of one lies within 100 m of the other. */
function similar(a: Point[], b: Point[]): boolean {
  let near = 0;
  for (let k = 0; k < b.length; k += 4) if (a.some((q) => distance(q, b[k]) < 100)) near++;
  return near / Math.ceil(b.length / 4) > 0.8;
}

/** Rectangle of a platoon area, aligned across the line of advance. */
function outline(centre: Point, u: Point, front: number, depth: number): Point[] {
  const v = { x: u.y, y: -u.x };
  const hf = front / 2, hd = depth / 2;
  return [
    [-hf, -hd], [hf, -hd], [hf, hd], [-hf, hd],
  ].map(([l, f]) => ({ x: centre.x + v.x * l + u.x * f, y: centre.y + v.y * l + u.y * f }));
}

function inArea(p: Point, centre: Point, u: Point, front: number, depth: number): boolean {
  const v = { x: u.y, y: -u.x };
  const dx = p.x - centre.x, dy = p.y - centre.y;
  return Math.abs(dx * v.x + dy * v.y) <= front / 2 && Math.abs(dx * u.x + dy * u.y) <= depth / 2;
}

/**
 * How well position `a` supports position `b`: the share of the ground
 * within 100 m of `b` that `a` can see (and so fire into). Uses `a`'s
 * viewshed (gun range).
 */
function supports(cg: Grid, a: Cand, b: Cand): number {
  const R = Math.ceil(COMPANY.supportRadiusM / cg.cellM);
  const c = pointToCell(cg, b.p);
  let total = 0, seen = 0;
  for (let dr = -R; dr <= R; dr++)
    for (let dc = -R; dc <= R; dc++) {
      if (dr * dr + dc * dc > R * R) continue;
      const r = c.row + dr, cc = c.col + dc;
      if (r < 0 || cc < 0 || r >= cg.height || cc >= cg.width) continue;
      total++;
      seen += a.vs[r * cg.width + cc];
    }
  return total ? seen / total : 0;
}

/** Mutual support between a new position and those already chosen: the best two-way support with any of them. */
function mutualWith(cg: Grid, c: Cand, chosen: Cand[]): number {
  let best = 0;
  for (const o of chosen) best = Math.max(best, (supports(cg, c, o) + supports(cg, o, c)) / 2);
  return best;
}

/**
 * Best positions within an area, kept apart, chosen one at a time: the first
 * on its own merits, each later one also on how well it and the positions
 * already chosen can fire into the ground around each other (PO: mutually
 * supporting positions with interlocking arcs).
 */
function bestIn(cg: Grid, cands: Cand[], centre: Point, u: Point, n: number, spacing: number): Cand[] {
  const inside = cands.filter((c) => inArea(c.p, centre, u, CUR.platoonFrontM, CUR.platoonDepthM));
  const out: Cand[] = [];
  while (out.length < n) {
    let best: Cand | null = null;
    let bestV = -Infinity;
    for (const c of inside) {
      if (out.includes(c) || out.some((o) => distance(o.p, c.p) < spacing)) continue;
      const v = c.total + (out.length ? COMPANY.supportWeight * mutualWith(cg, c, out) : 0);
      if (v > bestV) [bestV, best] = [v, c];
    }
    if (!best) break;
    out.push(best);
  }
  return out;
}

/** Position of every cell along (forward) and across (lateral) the line of advance, and its x, y. */
function cellFrames(cg: Grid, start: Point, u: Point) {
  const N = cg.width * cg.height;
  const F = new Float32Array(N), Lt = new Float32Array(N), X = new Float32Array(N), Y = new Float32Array(N);
  const half = (cg.width * cg.cellM) / 2;
  for (let r = 0; r < cg.height; r++)
    for (let c = 0; c < cg.width; c++) {
      const i = r * cg.width + c;
      const x = (c + 0.5) * cg.cellM - half - start.x;
      const y = half - (r + 0.5) * cg.cellM - start.y;
      X[i] = x + start.x;
      Y[i] = y + start.y;
      F[i] = x * u.x + y * u.y;
      Lt[i] = x * u.y - y * u.x;
    }
  return { F, Lt, X, Y };
}

/** Lay out one direction of advance. Returns null if no sensible defence fits. */
function layoutForSide(input: CompanyInput, base: ReturnType<typeof analysisGrids>, side: number, opts: CompanyOptions) {
  // `side` is the advance bearing, degrees (any of 16 compass points).
  const { cg, layers } = base;
  const C = CUR;
  const start = input.start ?? { x: 0, y: 0 };
  const slopeDeg = slopeOf(cg);
  const going = layers ? layers.going : slopeOnlyGoing(slopeDeg);
  const routes = approachRoutes(cg, going, start, side, C.routes);
  if (!routes.length) return { log: `Advancing ${DIR(side)}: no route forward.`, layout: null };

  const spec = { ...POSTURES.prepared, coverWeight: opts.droneConcealment ? 0.8 : POSTURES.prepared.coverWeight };
  const ctx: Ctx = buildCtx(base, spec, nearestSide((side + 180) % 360), start, routes, C.forwardMinM - 100, {
    advanceBearingDeg: side,
    minRouteCover: 0.1,
    openPenalty: opts.droneConcealment ? 0.5 : 0,
  });
  const u = ctx.u;
  const v = { x: u.y, y: -u.x };
  const lat = (p: Point) => (p.x - start.x) * v.x + (p.y - start.y) * v.y;
  const half = (cg.width * cg.cellM) / 2;

  // 1. Defensibility of every candidate position in the band ahead.
  const mainLat = (f: number) => {
    let best = routes[0][0];
    for (const q of routes[0]) if (Math.abs(fwd(ctx, q) - f) < Math.abs(fwd(ctx, best) - f)) best = q;
    return lat(best);
  };
  const cands: Cand[] = [];
  for (let y = -half + C.sampleM / 2; y < half; y += C.sampleM)
    for (let x = -half + C.sampleM / 2; x < half; x += C.sampleM) {
      const p = { x, y };
      const f = fwd(ctx, p);
      if (f < C.forwardMinM - C.platoonDepthM / 2 || f > C.forwardMaxM + C.depthBehindM[1] + C.platoonDepthM / 2) continue;
      if (half - Math.abs(x) < C.edgeMarginM || half - Math.abs(y) < C.edgeMarginM) continue;
      if (Math.abs(lat(p) - mainLat(f)) > C.lateralMaxM) continue;
      if (!standable(ctx, p)) continue;
      const s = score(ctx, p);
      if (s) cands.push({ p, total: s.total, reverse: s.reverseSlope, vs: s.vs });
    }
  if (cands.length < 6) return { log: `Advancing ${DIR(side)}: too little defensible ground ahead.`, layout: null };

  // 2. Two forward platoons: the pair of areas with the best positions, the
  //    right distance apart, at a similar depth.
  const n = opts.dispersed ? C.teamsPerPlatoon : C.sectionsPerPlatoon;
  const spacing = opts.dispersed ? C.teamSpacingM : C.sectionSpacingM;
  // A forward platoon must leave room behind it, inside the box, for the depth platoon.
  const depthRoom = C.depthBehindM[0] + C.platoonDepthM / 2;
  const inBox = (p: Point) => half - Math.abs(p.x) >= C.edgeMarginM && half - Math.abs(p.y) >= C.edgeMarginM;
  const centres = cands.filter((c) => {
    const f = fwd(ctx, c.p);
    return f >= C.forwardMinM && f <= C.forwardMaxM && inBox({ x: c.p.x + u.x * depthRoom, y: c.p.y + u.y * depthRoom });
  });
  const value = new Map<Cand, { v: number; picks: Cand[] }>();
  for (const c of centres) {
    const picks = bestIn(cg, cands, c.p, u, n, spacing);
    value.set(c, { v: picks.reduce((a, b) => a + b.total, 0) * (picks.length >= Math.min(3, n) ? 1 : 0.5), picks });
  }
  // Best pair within the preferred distance, and best pair anywhere.
  let near: [Cand, Cand] | null = null, nearV = -Infinity;
  let far: [Cand, Cand] | null = null, farV = -Infinity;
  for (const a of centres)
    for (const b of centres) {
      if (lat(a.p) >= lat(b.p)) continue;
      const d = lat(b.p) - lat(a.p);
      if (d < C.forwardSpacingM[0] || d > C.forwardSpacingM[1]) continue;
      if (Math.abs(fwd(ctx, a.p) - fwd(ctx, b.p)) > C.forwardStaggerM) continue;
      const va = value.get(a)!, vb = value.get(b)!;
      if (va.picks.some((x) => vb.picks.includes(x))) continue;
      // Bonus if the two forward platoons can support each other across the gap.
      let cross = 0;
      for (const x of va.picks) for (const y of vb.picks) cross = Math.max(cross, (supports(cg, x, y) + supports(cg, y, x)) / 2);
      const vv = va.v + vb.v + COMPANY.supportWeight * cross;
      if (vv > farV) [farV, far] = [vv, [a, b]];
      const isNear = Math.max(fwd(ctx, a.p), fwd(ctx, b.p)) <= C.forwardPreferredM;
      if (isNear && vv > nearV) [nearV, near] = [vv, [a, b]];
    }
  const pair = near && farV < C.fartherIfBetterBy * nearV ? near : far;
  const pairV = pair === near ? nearV : farV;
  if (!pair) return { log: `Advancing ${DIR(side)}: no two platoon areas fit the frontage.`, layout: null };

  const fwdPicks = [value.get(pair[0])!.picks, value.get(pair[1])!.picks];
  const forwardPositions = fwdPicks.flat();
  const frames = cellFrames(cg, start, u);

  // Dead ground in front of the forward positions (within 300 m), which the
  // depth platoon should be able to see into.
  const N = cg.width * cg.height;
  const seenFwd = new Uint8Array(N);
  for (const c of forwardPositions) for (let i = 0; i < N; i++) if (c.vs[i]) seenFwd[i] = 1;
  const frontLine = Math.min(...forwardPositions.map((c) => fwd(ctx, c.p)));
  const fwdDead = new Uint8Array(N);
  const deadCells: number[] = [];
  const latLo = Math.min(lat(pair[0].p), lat(pair[1].p)) - 300, latHi = Math.max(lat(pair[0].p), lat(pair[1].p)) + 300;
  for (let i = 0; i < N; i++) {
    const f = frames.F[i];
    if (f > frontLine + 50 || f < frontLine - 300 || seenFwd[i]) continue;
    if (frames.Lt[i] < latLo || frames.Lt[i] > latHi) continue;
    fwdDead[i] = 1;
    deadCells.push(i);
  }

  // 3. Depth platoon: behind, between the two forward platoons, sited to see
  //    into their dead ground and the gap, while staying hidden.
  const midF = (fwd(ctx, pair[0].p) + fwd(ctx, pair[1].p)) / 2;
  const loL = Math.min(lat(pair[0].p), lat(pair[1].p)) - 100, hiL = Math.max(lat(pair[0].p), lat(pair[1].p)) + 100;
  const deadTotal = deadCells.length;
  // The gap between the forward platoons: ground within 150 m of the midpoint
  // of their two nearest positions. Doctrine covers a gap with fire from depth.
  let ga = fwdPicks[0][0].p, gb = fwdPicks[1][0].p, gd = Infinity;
  for (const x of fwdPicks[0]) for (const y of fwdPicks[1]) if (distance(x.p, y.p) < gd) [gd, ga, gb] = [distance(x.p, y.p), x.p, y.p];
  const gapCentre = { x: (ga.x + gb.x) / 2, y: (ga.y + gb.y) / 2 };
  const gapCells: number[] = [];
  for (let i = 0; i < N; i++) if ((frames.X[i] - gapCentre.x) ** 2 + (frames.Y[i] - gapCentre.y) ** 2 <= 150 * 150) gapCells.push(i);
  const depthScore = (c: Cand) => {
    const vs = viewshed(cg, c.p, { obsHeightM: spec.eyeM, targetHeightM: SECTION_SCORING.attackerHeightM, maxRangeM: 1000, obstacles: ctx.obstacles });
    let seen = 0, gapSeen = 0;
    for (const i of deadCells) seen += vs[i];
    for (const i of gapCells) gapSeen += vs[i];
    const cc = pointToCell(cg, c.p);
    const exposure = ctx.attackerSees[cc.row * cg.width + cc.col] / ctx.nViewpoints;
    return (
      (deadTotal ? 2 * (seen / deadTotal) : 0) +
      (gapCells.length ? COMPANY.gapWeight * (gapSeen / gapCells.length) : 0) +
      0.5 * c.total -
      1.5 * exposure
    );
  };
  const depthCands = cands.filter((c) => {
    const f = fwd(ctx, c.p) - midF;
    return f >= C.depthBehindM[0] && f <= C.depthBehindM[1] && lat(c.p) >= loL && lat(c.p) <= hiL;
  });
  let depthCentre: Cand | null = null;
  let depthPicks: Cand[] = [];
  let depthBest = -Infinity;
  // Score each depth centre by the positions it would hold.
  const depthScored = new Map<Cand, number>();
  for (const c of depthCands) depthScored.set(c, depthScore(c));
  for (const c of depthCands) {
    const inside = depthCands
      .filter((d) => inArea(d.p, c.p, u, C.platoonFrontM, C.platoonDepthM))
      .sort((a, b) => depthScored.get(b)! - depthScored.get(a)!);
    const picks: Cand[] = [];
    for (const d of inside) {
      if (picks.length >= n) break;
      if (picks.every((o) => distance(o.p, d.p) >= spacing)) picks.push(d);
    }
    const val = picks.reduce((a, b) => a + depthScored.get(b)!, 0);
    if (picks.length && val > depthBest) [depthBest, depthCentre, depthPicks] = [val, c, picks];
  }

  return {
    log: '',
    layout: {
      routes, ctx, pair, fwdPicks, depthCentre, depthPicks, frontLine, value: pairV + Math.max(0, depthBest), cands, n, spacing, lat, fwdDead, deadTotal, frames,
      centres, areaValue: value, mainLat, inBox, depthRoom,
    },
  };
}

type SideLayout = NonNullable<ReturnType<typeof layoutForSide>['layout']>;

/** A platoon-sized group in a layout: its role, centre and chosen positions (u: the way it faces, if not the advance). */
interface Group {
  role: PlatoonRole;
  centre: Point;
  picks: Cand[];
  u?: Point;
}
interface Variant {
  type: LayoutType;
  groups: Group[];
  /** How well the ground suits this layout: the average quality of its positions, plus what the layout needs. */
  quality: number;
  /** The feature an all-round strongpoint is built on (company HQ goes there). */
  hub?: Point;
}

export const ROLE_NAMES: Record<PlatoonRole, string> = { forward: 'forward', depth: 'depth', screen: 'forward screen', reserve: 'counter-attack force' };

const rotate = (d: Point, deg: number): Point => {
  const r = (deg * Math.PI) / 180;
  // Clockwise rotation (bearings run clockwise).
  return { x: d.x * Math.cos(r) + d.y * Math.sin(r), y: -d.x * Math.sin(r) + d.y * Math.cos(r) };
};

/**
 * Every layout that fits the ground in this direction (PO, 19 Nov 2026). Each is
 * built from the same candidate positions, scored on the ground (fields of fire,
 * cover, reverse slopes, mutual support), with what that layout needs:
 *  - two up, one back: as before;
 *  - one up, two back: one platoon forward on the best single area, two in depth
 *    behind it, reverse slopes favoured (a narrow front or a single crest);
 *  - three up: three platoons in line, no depth (good ground wide across the route);
 *  - all-round strongpoint: three platoons around one feature, facing outwards
 *    (a hill top, wood or village), HQ in the middle;
 *  - forward screen and main position: small teams 500–900 m in front of a main
 *    position of two platoons further back (a long, open approach);
 *  - counter-attack force: two platoons forward, a platoon in BMPs hidden 500–1,500 m
 *    behind with a way forward (covered ground behind the position);
 *  - echeloned along the route: platoons staggered in depth astride the main
 *    route, alternating sides (a channelled approach).
 */
function buildVariants(L: SideLayout, force?: LayoutType): Variant[] {
  const C = CUR;
  const { ctx, cands, n, spacing, lat, centres, areaValue, mainLat, inBox } = L;
  const sp = C.scale; // the company's spread
  const cg = ctx.cg;
  const u = ctx.u;
  const f = (p: Point) => fwd(ctx, p);
  // Value of an area centred anywhere (cached for candidate centres).
  const area = (centre: Point, uu: Point = u): { v: number; picks: Cand[] } => {
    const picks = bestIn(cg, cands, centre, uu, n, spacing);
    return { v: picks.reduce((a, b) => a + b.total, 0) * (picks.length >= Math.min(3, n) ? 1 : 0.5), picks };
  };
  const at = (c: Cand) => areaValue.get(c) ?? area(c.p);
  /** Best positions in an area, leaving out positions already taken by another platoon. */
  const areaExcl = (centre: Point, used: Cand[], uu: Point = u): Cand[] => bestIn(cg, cands.filter((c) => !used.includes(c)), centre, uu, n, spacing);
  const overlaps = (a: Cand[], b: Cand[]) => a.some((x) => b.includes(x));
  const quality = (groups: Group[], bonus = 0) => {
    const ps = groups.flatMap((g) => g.picks);
    return ps.length ? ps.reduce((a, b) => a + b.total, 0) / ps.length + bonus : -Infinity;
  };
  const out: Variant[] = [];
  const want = (t: LayoutType) => !force || force === t;

  // Two up, one back (the layout found while choosing the direction).
  const twoUp: Group[] = [
    { role: 'forward', centre: L.pair[0].p, picks: L.fwdPicks[0] },
    { role: 'forward', centre: L.pair[1].p, picks: L.fwdPicks[1] },
  ];
  if (L.depthCentre && L.depthPicks.length) twoUp.push({ role: 'depth', centre: L.depthCentre.p, picks: L.depthPicks });
  if (want('twoUp')) out.push({ type: 'twoUp', groups: twoUp, quality: quality(twoUp) });

  // One up, two back.
  if (want('oneUp')) {
    const a = [...centres].filter((c) => f(c.p) <= C.forwardPreferredM).sort((x, y) => at(y).v - at(x).v)[0] ?? centres[0];
    if (a) {
      const pa = at(a).picks;
      const behind = cands.filter((c) => {
        const d = f(c.p) - f(a.p);
        return d >= 300 * sp && d <= 800 * sp && Math.abs(lat(c.p) - lat(a.p)) <= 600 * sp && inBox(c.p);
      });
      let best: [Cand, Cand] | null = null, bestV = -Infinity;
      for (const x of behind)
        for (const y of behind) {
          if (lat(x.p) >= lat(y.p)) continue;
          const sep = lat(y.p) - lat(x.p);
          if (sep < 400 * sp || sep > 800 * sp || Math.abs((lat(x.p) + lat(y.p)) / 2 - lat(a.p)) > 250 * sp) continue;
          const vx = at(x), vy = at(y);
          if (overlaps(vx.picks, vy.picks) || overlaps(vx.picks, pa) || overlaps(vy.picks, pa)) continue;
          const rev = [...vx.picks, ...vy.picks].filter((c) => c.reverse).length * 0.3;
          if (vx.v + vy.v + rev > bestV) [bestV, best] = [vx.v + vy.v + rev, [x, y]];
        }
      if (best) {
        const g: Group[] = [
          { role: 'forward', centre: a.p, picks: pa },
          { role: 'depth', centre: best[0].p, picks: at(best[0]).picks },
          { role: 'depth', centre: best[1].p, picks: at(best[1]).picks },
        ];
        const rev = g.slice(1).flatMap((x) => x.picks).filter((c) => c.reverse).length / Math.max(1, g[1].picks.length + g[2].picks.length);
        out.push({ type: 'oneUp', groups: g, quality: quality(g, 0.3 * rev) });
      }
    }
  }

  // Three up, in line: three platoon areas side by side, 400–700 m apart, at a similar depth.
  if (want('threeUp')) {
    let best: { g: Group[]; v: number } | null = null;
    const near = centres.filter((c) => f(c.p) <= C.forwardPreferredM + 300);
    for (const b of near) {
      const vb = at(b);
      const side = (sgn: number) => {
        let bestS: { c: Cand; picks: Cand[]; v: number } | null = null;
        for (const c of near) {
          const sep = (lat(c.p) - lat(b.p)) * sgn;
          if (sep < 400 * sp || sep > 700 * sp || Math.abs(f(c.p) - f(b.p)) > C.forwardStaggerM) continue;
          const picks = areaExcl(c.p, vb.picks);
          const v = picks.reduce((x, y) => x + y.total, 0);
          if (picks.length && (!bestS || v > bestS.v)) bestS = { c, picks, v };
        }
        return bestS;
      };
      const l = side(-1);
      if (!l) continue;
      const r = side(1);
      if (!r || overlaps(l.picks, r.picks)) continue;
      const v = vb.v + l.v + r.v;
      if (!best || v > best.v)
        best = {
          v,
          g: [
            { role: 'forward', centre: l.c.p, picks: l.picks },
            { role: 'forward', centre: b.p, picks: vb.picks },
            { role: 'forward', centre: r.c.p, picks: r.picks },
          ],
        };
    }
    if (best) out.push({ type: 'threeUp', groups: best.g, quality: quality(best.g) });
  }

  // All-round strongpoint on a dominant feature.
  if (want('strongpoint')) {
    let best: { hub: Point; groups: Group[]; v: number } | null = null;
    const hubs = centres.filter((_, k) => k % 2 === 0);
    for (const h of hubs) {
      const groups: Group[] = [];
      let v = 0;
      let ok = true;
      for (const [deg, role] of [[0, 'forward'], [120, 'depth'], [240, 'depth']] as [number, PlatoonRole][]) {
        const uu = rotate(u, deg);
        const centre = { x: h.p.x + uu.x * 250 * sp, y: h.p.y + uu.y * 250 * sp };
        if (!inBox(centre)) { ok = false; break; }
        const ar = area(centre, uu);
        if (!ar.picks.length || groups.some((g) => overlaps(g.picks, ar.picks))) { ok = false; break; }
        groups.push({ role, centre, picks: ar.picks, u: uu });
        v += ar.v;
      }
      if (!ok) continue;
      // A feature to hold: height over the ground around it, woods or buildings.
      const hc = pointToCell(cg, h.p);
      const z = cg.data[hc.row * cg.width + hc.col];
      let ring = 0, k = 0;
      for (let deg = 0; deg < 360; deg += 45) {
        const q = { x: h.p.x + 500 * Math.sin((deg * Math.PI) / 180), y: h.p.y + 500 * Math.cos((deg * Math.PI) / 180) };
        const qc = pointToCell(cg, q);
        if (qc.col < 0 || qc.row < 0 || qc.col >= cg.width || qc.row >= cg.height) continue;
        ring += cg.data[qc.row * cg.width + qc.col];
        k++;
      }
      const prominence = k ? z - ring / k : 0;
      const covered = ctx.obstacles && ctx.obstacles.heightM[hc.row * cg.width + hc.col] >= 2 ? 1 : 0;
      const vv = v * (1 + Math.max(0, prominence) / 40 + 0.15 * covered);
      if (!best || vv > best.v) best = { hub: h.p, groups, v: vv };
    }
    if (best) {
      const hc = pointToCell(cg, best.hub);
      const z = cg.data[hc.row * cg.width + hc.col];
      let ring = 0, k = 0;
      for (let deg = 0; deg < 360; deg += 45) {
        const q = { x: best.hub.x + 500 * Math.sin((deg * Math.PI) / 180), y: best.hub.y + 500 * Math.cos((deg * Math.PI) / 180) };
        const qc = pointToCell(cg, q);
        if (qc.col < 0 || qc.row < 0 || qc.col >= cg.width || qc.row >= cg.height) continue;
        ring += cg.data[qc.row * cg.width + qc.col];
        k++;
      }
      const prominence = Math.max(0, k ? z - ring / k : 0);
      out.push({ type: 'strongpoint', groups: best.groups, hub: best.hub, quality: quality(best.groups, Math.min(0.4, prominence / 50)) });
    }
  }

  // Forward screen and main position.
  if (want('screen')) {
    const deep = centres.filter((c) => f(c.p) >= C.forwardMinM + 600 * sp);
    let pair: [Cand, Cand] | null = null, pv = -Infinity;
    for (const a of deep)
      for (const b of deep) {
        if (lat(a.p) >= lat(b.p)) continue;
        const d = lat(b.p) - lat(a.p);
        if (d < C.forwardSpacingM[0] || d > C.forwardSpacingM[1] || Math.abs(f(a.p) - f(b.p)) > C.forwardStaggerM) continue;
        const va = at(a), vb = at(b);
        if (overlaps(va.picks, vb.picks)) continue;
        if (va.v + vb.v > pv) [pv, pair] = [va.v + vb.v, [a, b]];
      }
    if (pair) {
      const used = [...at(pair[0]).picks, ...at(pair[1]).picks];
      const mainF = Math.min(...used.map((c) => f(c.p)));
      // Screen teams 500–900 m in front of the main position's forward positions: good observation, near the approaches, spread across them.
      const forwardBand = cands
        .filter((c) => f(c.p) >= mainF - 900 * sp && f(c.p) <= mainF - 500 * sp && Math.abs(lat(c.p) - mainLat(f(c.p))) <= 700 * sp && !used.includes(c))
        .sort((x, y) => y.total - x.total);
      const teams: Cand[] = [];
      for (const c of forwardBand) {
        if (teams.length >= 3) break;
        if (teams.every((t) => distance(t.p, c.p) >= 300 * sp)) teams.push(c);
      }
      if (teams.length >= 2) {
        const cx = teams.reduce((a, t) => a + t.p.x, 0) / teams.length, cy = teams.reduce((a, t) => a + t.p.y, 0) / teams.length;
        const g: Group[] = [
          { role: 'forward', centre: pair[0].p, picks: at(pair[0]).picks },
          { role: 'forward', centre: pair[1].p, picks: at(pair[1]).picks },
          { role: 'screen', centre: { x: cx, y: cy }, picks: teams },
        ];
        out.push({ type: 'screen', groups: g, quality: quality(g) });
      }
    }
  }

  // Counter-attack force: two up, and a platoon in BMPs hidden behind with a way forward.
  if (want('counterattack')) {
    const midF = (f(L.pair[0].p) + f(L.pair[1].p)) / 2;
    const midL = (lat(L.pair[0].p) + lat(L.pair[1].p)) / 2;
    let bestP: Point | null = null, bestE = Infinity;
    const half = (cg.width * cg.cellM) / 2;
    for (let dF = 500 * sp; dF <= 1500 * sp; dF += 100)
      for (let dL = -600 * sp; dL <= 600 * sp; dL += 100) {
        const p = { x: u.x * (midF + dF) + u.y * (midL + dL), y: u.y * (midF + dF) - u.x * (midL + dL) };
        const q = { x: p.x + ctx.start.x, y: p.y + ctx.start.y };
        if (Math.abs(q.x) > half - C.edgeMarginM || Math.abs(q.y) > half - C.edgeMarginM || !standable(ctx, q)) continue;
        const qc = pointToCell(cg, q);
        const i = qc.row * cg.width + qc.col;
        const exposure = ctx.attackerSees[i] / ctx.nViewpoints - (ctx.obstacles && ctx.obstacles.heightM[i] >= 2 ? 0.2 : 0);
        if (exposure < bestE) [bestE, bestP] = [exposure, q];
      }
    if (bestP) {
      const v = { x: u.y, y: -u.x };
      const vehicles: Cand[] = [-80 * sp, 0, 80 * sp].map((l) => ({ p: { x: bestP!.x + v.x * l, y: bestP!.y + v.y * l }, total: 0, reverse: false, vs: new Uint8Array(0) }));
      const g: Group[] = [twoUp[0], twoUp[1], { role: 'reserve', centre: bestP, picks: vehicles }];
      // The forward platoons' quality, plus how well the reserve is hidden.
      out.push({ type: 'counterattack', groups: g, quality: quality(g.slice(0, 2), 0.3 * Math.max(0, 1 - bestE)) });
    }
  }

  // Echeloned along the main route, alternating sides.
  if (want('echelon')) {
    const near = (c: Cand, side: number, lo: number, hi: number) => {
      const d = (lat(c.p) - mainLat(f(c.p))) * side;
      return d >= lo && d <= hi;
    };
    let best: { groups: Group[]; v: number } | null = null;
    const firsts = centres.filter((c) => f(c.p) <= C.forwardPreferredM && Math.abs(lat(c.p) - mainLat(f(c.p))) <= 250 * sp);
    // Try the best few first positions on each side: the very best may leave no room for two more behind it.
    const tops = [...firsts].sort((x, y) => at(y).v - at(x).v).filter((_, k) => k < 40 && k % 4 === 0);
    for (const [sideFirst, a] of [1, -1].flatMap((sd) => tops.map((t) => [sd, t] as [number, Cand]))) {
      const pa = at(a).picks;
      const pick = (after: Cand, side: number, used: Cand[]) =>
        cands
          .filter((c) => f(c.p) - f(after.p) >= 300 * sp && f(c.p) - f(after.p) <= 600 * sp && near(c, side, 150 * sp, 500 * sp) && inBox(c.p))
          .filter((_, k) => k % 2 === 0)
          .map((c) => {
            const picks = areaExcl(c.p, used);
            return { c, picks, v: picks.reduce((x, y) => x + y.total, 0) };
          })
          .filter((x) => x.picks.length)
          .sort((x, y) => y.v - x.v)[0];
      const b = pick(a, sideFirst, pa);
      if (!b) continue;
      const cc = pick(b.c, -sideFirst, [...pa, ...b.picks]);
      if (!cc) continue;
      const g: Group[] = [
        { role: 'forward', centre: a.p, picks: pa },
        { role: 'depth', centre: b.c.p, picks: b.picks },
        { role: 'depth', centre: cc.c.p, picks: cc.picks },
      ];
      const v = at(a).v + b.v + cc.v;
      if (!best || v > best.v) best = { groups: g, v };
    }
    if (best) {
      // Suits a channelled approach: the routes forward run close together.
      const spread = L.routes.length > 1 ? Math.max(...L.routes.map((r) => Math.abs(lat(r[Math.floor(r.length / 2)]) - lat(L.routes[0][Math.floor(L.routes[0].length / 2)])))) : 0;
      out.push({ type: 'echelon', groups: best.groups, quality: quality(best.groups, spread < 400 ? 0.3 : 0) });
    }
  }

  // Always something: two up, one back.
  if (!out.length) out.push({ type: 'twoUp', groups: twoUp, quality: quality(twoUp) });
  return out;
}

/**
 * Choose among the layouts that fit: the better the ground suits a layout, the
 * likelier it is, with some variety (PO: chosen by the ground).
 */
function chooseVariant(vs: Variant[], random: (() => number) | null): Variant {
  const best = Math.max(...vs.map((x) => x.quality));
  // Without a seed (tests, the Developer page's default), the classic two up, one back if it fits.
  if (!random) return vs.find((x) => x.type === 'twoUp') ?? vs.reduce((a, b) => (b.quality > a.quality ? b : a));
  const T = Math.max(0.05, Math.abs(best) * 0.12);
  const w = vs.map((x) => LAYOUT_PRIOR[x.type] * Math.exp((x.quality - best) / T));
  let r = random() * w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < vs.length; k++) if ((r -= w[k]) <= 0) return vs[k];
  return vs[vs.length - 1];
}

/** The first line of the DS notes, for each layout. */
function layoutHeadline(type: LayoutType, dir: string, platoons: PlatoonArea[], lat: (p: Point) => number, f: (p: Point) => number, frontLine: number): string {
  const fwdP = platoons.filter((p) => p.role === 'forward');
  const spread = fwdP.length > 1 ? Math.round(Math.max(...fwdP.map((p) => lat(p.centre))) - Math.min(...fwdP.map((p) => lat(p.centre)))) : 0;
  const ahead = `${Math.round(frontLine)} m ahead of you`;
  switch (type) {
    case 'twoUp':
      return `Company defence blocking movement ${dir}, two up, one back: two platoons forward about ${spread} m apart and ${ahead}, one platoon in depth.`;
    case 'oneUp':
      return `Company defence blocking movement ${dir}, one up, two back: one platoon forward ${ahead}, two platoons in depth behind it.`;
    case 'threeUp':
      return `Company defence blocking movement ${dir}, three up: three platoons in line across about ${spread} m, ${ahead}, with nothing in depth.`;
    case 'strongpoint':
      return `All-round company strongpoint astride the route ${dir}: three platoons around one feature, facing outwards, the nearest ${ahead}.`;
    case 'screen': {
      const scr = platoons.find((p) => p.role === 'screen');
      return `Company defence blocking movement ${dir} behind a forward screen: two platoons on the main position ${ahead}; a screen of small teams about ${scr ? Math.round(frontLine - f(scr.centre)) : 0} m in front of it.`;
    }
    case 'counterattack': {
      const r = platoons.find((p) => p.role === 'reserve');
      return `Company defence blocking movement ${dir}, two up, with a counter-attack force: two platoons forward ${ahead}; a platoon in BMPs held about ${r ? Math.round(f(r.centre) - frontLine) : 0} m behind, hidden, to counter-attack.`;
    }
    case 'echelon':
      return `Company defence echeloned along the route ${dir}: platoons staggered in depth astride the route, alternating sides, the first ${ahead}.`;
  }
}

/** The box edge nearest a bearing. */
const nearestSide = (bearingDeg: number): Side => (['N', 'E', 'S', 'W'] as Side[])[Math.round((((bearingDeg % 360) + 360) % 360) / 90) % 4];

export function placeEnemyCompany(input: CompanyInput): CompanyLayout | null {
  dirCentre = input.grid.meta.centre;
  // How spread out this company is (own random stream; standard when unseeded, as in the tests).
  const spread =
    SPREADS.find((x) => x.name === input.spread) ??
    (input.seed === undefined
      ? SPREADS.find((x) => x.name === 'standard')!
      : (() => {
          let r = rng(input.seed! ^ 0xd157)() * SPREADS.reduce((a, x) => a + x.weight, 0);
          for (const x of SPREADS) if ((r -= x.weight) <= 0) return x;
          return SPREADS[SPREADS.length - 1];
        })());
  CUR = scaledCompany(spread.factor);
  const random = input.seed === undefined ? null : rng(input.seed);
  const chance = (k: OptionKey) => (random ? random() < OPTION_CHANCE[k] : false);
  const options: CompanyOptions = {
    mines: input.options?.mines ?? chance('mines'),
    dummies: input.options?.dummies ?? chance('dummies'),
    dispersed: input.options?.dispersed ?? chance('dispersed'),
    droneConcealment: input.options?.droneConcealment ?? chance('droneConcealment'),
    isrFires: input.options?.isrFires ?? chance('isrFires'),
  };
  const base = analysisGrids(input, COMPANY.analysisCellM);
  const log: string[] = [];
  let best: { side: number; L: NonNullable<ReturnType<typeof layoutForSide>['layout']> } | null = null;
  // Advance bearings to try. Four at right angles, turned by 0, 22.5, 45 or
  // 67.5 degrees (own random stream), so any of the 16 compass points can come
  // up without trying all 16 (PO, 15 Nov 2026).
  const turn = input.seed === undefined ? 0 : Math.floor(rng(input.seed ^ 0x16) () * 4) * 22.5;
  const sides = input.bearings ?? (input.sides ? input.sides.map((s) => SIDE_BEARING[OPPOSITE[s]]) : [0, 90, 180, 270].map((b) => (b + turn) % 360));
  for (const [k, side] of sides.entries()) {
    input.progress?.(`Reading the ground for an enemy company: advance ${DIR(side)} (${k + 1} of ${sides.length})…`);
    const r = layoutForSide(input, base, side, options);
    if (!r.layout) {
      log.push(r.log);
      continue;
    }
    log.push(`Advancing ${DIR(side)}: company defence scores ${r.layout.value.toFixed(1)}.`);
    if (!best || r.layout.value > best.L.value) best = { side, L: r.layout };
  }
  if (!best) return null;

  const { side } = best;
  const L = best.L;
  const { ctx, cands } = L;
  const cg = ctx.cg;
  const u = ctx.u;
  const C = CUR;
  const N = cg.width * cg.height;

  // The layouts that fit this ground, and the one chosen (PO, 19 Nov 2026).
  const variants = buildVariants(L, input.layout);
  const pickRandom = input.seed === undefined ? null : rng(input.seed ^ 0x1a7);
  const chosen = chooseVariant(variants, pickRandom);
  const groups = chosen.groups;
  log.push(`Layouts that fit: ${variants.map((x) => `${LAYOUT_NAMES[x.type]} (${x.quality.toFixed(2)})`).join('; ')}. Chosen: ${LAYOUT_NAMES[chosen.type]}.`);

  // Platoons and their positions: forward platoons named left to right (En 1 Pl, En 2 Pl…), then the rest.
  const order = [...groups].sort((x, y) => {
    const rank = (g: Group) => ({ forward: 0, screen: 1, depth: 2, reserve: 3 })[g.role];
    return rank(x) - rank(y) || L.lat(x.centre) - L.lat(y.centre);
  });
  const platoons: PlatoonArea[] = [];
  const posLabel = (k: number, role: PlatoonRole) =>
    role === 'screen' ? `Team ${k + 1}` : role === 'reserve' ? `Vehicle ${k + 1}` : options.dispersed ? `Team ${k + 1}` : `Section ${k + 1}`;
  order.forEach((g, k) => {
    const name = `En ${k + 1} Pl`;
    const kind: PositionKind = g.role === 'screen' || options.dispersed ? 'team' : 'section';
    const men = g.role === 'screen' ? 3 : g.role === 'reserve' ? 7 : options.dispersed ? 3 : 8;
    const positions: EnemyPosition[] = g.picks.map((c, j) => ({ kind, platoon: name, label: `${name} ${posLabel(j, g.role)}`, point: c.p, men }));
    const reverse = g.role === 'forward' && g.picks.length > 0 && g.picks[0].reverse;
    if (reverse) {
      const crest = crestInFront(ctx, g.picks[0].p);
      if (crest && standable(ctx, crest.point)) positions.push({ kind: 'outpost', platoon: name, label: `${name} outpost`, point: crest.point, men: 2 });
    }
    platoons.push({
      name, role: g.role, centre: g.centre, reverseSlope: reverse,
      outline: outline(g.centre, g.u ?? u, g.role === 'screen' ? 900 * C.scale : C.platoonFrontM, g.role === 'screen' ? 400 * C.scale : C.platoonDepthM), positions,
    });
  });
  // The forward line: the nearest main (forward) positions.
  const mainFwd = groups.filter((g) => g.role === 'forward').flatMap((g) => g.picks);
  const frontLine = Math.min(...mainFwd.map((c) => fwd(ctx, c.p)));
  const real = platoons.flatMap((p) => p.positions);

  // Company HQ: 150–400 m behind the depth platoon (or the forward line), as hidden as possible.
  let hq: EnemyPosition | null = null;
  {
    const ref = chosen.hub ?? (groups.find((g) => g.role === 'depth') ?? groups.find((g) => g.role === 'forward')!).centre;
    let bestHq: Point | null = null;
    let bestV = Infinity;
    for (let b = chosen.hub ? 0 : 150; b <= (chosen.hub ? 100 : 400); b += 50)
      for (let l = -200; l <= 200; l += 50) {
        const p = { x: ref.x + u.x * b + (u.y) * l, y: ref.y + u.y * b + (-u.x) * l };
        if (!standable(ctx, p)) continue;
        const c = pointToCell(cg, p);
        if (c.col < 0 || c.row < 0 || c.col >= cg.width || c.row >= cg.height) continue;
        const i = c.row * cg.width + c.col;
        const v = ctx.attackerSees[i] + (ctx.obstacles && ctx.obstacles.heightM[i] >= 1 ? -0.5 : 0);
        if (v < bestV) [bestV, bestHq] = [v, p];
      }
    if (bestHq) hq = { kind: 'hq', platoon: 'Coy HQ', label: 'Coy HQ', point: bestHq, men: 6 };
  }

  // Dummies: good ground the enemy did not use, away from real positions.
  const dummies: EnemyPosition[] = [];
  if (options.dummies) {
    const order = [...cands].sort((a, b) => b.total - a.total);
    for (const c of order) {
      if (dummies.length >= 3) break;
      // Within the enemy's own area: up to 300 m in front of the forward line, 600 m behind it.
      const f = fwd(ctx, c.p);
      if (f < frontLine - 300 || f > frontLine + 600) continue;
      if (real.some((r) => distance(r.point, c.p) < 250) || dummies.some((d) => distance(d.point, c.p) < 250)) continue;
      dummies.push({ kind: 'dummy', platoon: '—', label: `Dummy ${dummies.length + 1}`, point: c.p, men: 0 });
    }
  }

  // Kill zone and dead ground in front, from all real fighting positions.
  const { F, X, Y } = L.frames;
  const killZone = new Uint8Array(N);
  const seen300 = new Uint8Array(N);
  const spec = POSTURES.prepared;
  const r2 = spec.rifleRangeM ** 2;
  // The counter-attack force is mounted and held back: it does not cover ground by fire from where it waits.
  const reserveNames = platoons.filter((p) => p.role === 'reserve').map((p) => p.name);
  const fighting = real.filter((r) => r.kind !== 'outpost' && r.kind !== 'hq' && !reserveNames.includes(r.platoon));
  const views: Cand[] = [];
  for (const r of fighting) {
    const vs = viewshed(cg, r.point, { obsHeightM: spec.eyeM, targetHeightM: SECTION_SCORING.attackerHeightM, maxRangeM: spec.gunRangeM, obstacles: ctx.obstacles });
    views.push({ p: r.point, vs, total: 0, reverse: false });
    // Russian strongpoints are built for all-round defence: count fire in every direction.
    for (let i = 0; i < N; i++) {
      if (!vs[i]) continue;
      if (killZone[i] < 255) killZone[i]++;
      if ((X[i] - r.point.x) ** 2 + (Y[i] - r.point.y) ** 2 <= r2) seen300[i] = 1;
    }
  }
  const forwardReal = real.filter((r) => platoons.find((p) => p.name === r.platoon)?.role === 'forward' && r.kind !== 'outpost');
  const deadGround = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (seen300[i] || F[i] > frontLine) continue;
    if (forwardReal.some((r) => (X[i] - r.point.x) ** 2 + (Y[i] - r.point.y) ** 2 <= r2)) deadGround[i] = 1;
  }

  // Gaps between neighbouring forward platoons, and how well the depth platoons cover them.
  const gaps: Gap[] = [];
  {
    const fwdP = platoons.filter((p) => p.role === 'forward').sort((x, y) => L.lat(x.centre) - L.lat(y.centre));
    const depthVs = platoons
      .filter((p) => p.role === 'depth')
      .flatMap((p) => p.positions)
      .map((p) => viewshed(cg, p.point, { obsHeightM: spec.eyeM, targetHeightM: SECTION_SCORING.attackerHeightM, maxRangeM: 1000, obstacles: ctx.obstacles }));
    for (let k = 1; k < fwdP.length; k++) {
      const a = fwdP[k - 1].positions.filter((p) => p.kind !== 'outpost');
      const b = fwdP[k].positions.filter((p) => p.kind !== 'outpost');
      let dMin = Infinity;
      let pa = a[0]?.point, pb = b[0]?.point;
      for (const x of a) for (const y of b) if (distance(x.point, y.point) < dMin) [dMin, pa, pb] = [distance(x.point, y.point), x.point, y.point];
      if (!pa || !pb) continue;
      const centre = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      let total = 0, covered = 0, any = 0;
      for (let i = 0; i < N; i++) {
        if ((X[i] - centre.x) ** 2 + (Y[i] - centre.y) ** 2 > 150 * 150) continue;
        total++;
        const fromDepth = depthVs.some((vs) => vs[i]);
        if (fromDepth) covered++;
        if (fromDepth || views.some((v) => v.vs[i])) any++;
      }
      gaps.push({ centre, widthM: dMin, coveredFromDepth: total ? covered / total : 0, coveredByAny: total ? any / total : 0 });
    }
  }

  // Mines and obstacles: across the approaches in front of the forward line,
  // where they are covered by fire or lie in the defence's dead ground.
  let mines: Mask | null = null;
  if (options.mines) {
    mines = new Uint8Array(N);
    const depth = random ? C.mineDepthM[0] + random() * (C.mineDepthM[1] - C.mineDepthM[0]) : C.mineDepthM[1];
    const lo = Math.min(...forwardReal.map((r) => L.lat(r.point))) - 200;
    const hi = Math.max(...forwardReal.map((r) => L.lat(r.point))) + 200;
    // Cells near any approach route.
    const nearRoute = new Uint8Array(N);
    const R = Math.ceil(C.mineRouteM / cg.cellM);
    for (const r of L.routes)
      for (const p of r) {
        const c = pointToCell(cg, p);
        for (let dr = -R; dr <= R; dr++)
          for (let dc = -R; dc <= R; dc++) {
            const rr = c.row + dr, cc = c.col + dc;
            if (rr >= 0 && cc >= 0 && rr < cg.height && cc < cg.width) nearRoute[rr * cg.width + cc] = 1;
          }
      }
    for (let i = 0; i < N; i++) {
      const f = frontLine - F[i];
      if (f < C.mineFromM || f > C.mineFromM + depth) continue;
      if (L.frames.Lt[i] < lo || L.frames.Lt[i] > hi) continue;
      if (!nearRoute[i] || !(killZone[i] || deadGround[i] || L.fwdDead[i])) continue;
      mines[i] = 1;
    }
  }

  // Interlocking arcs: share of the ground under fire covered by two or more positions.
  let under = 0, twoPlus = 0;
  for (let i = 0; i < N; i++) {
    if (!killZone[i]) continue;
    under++;
    if (killZone[i] >= 2) twoPlus++;
  }
  const interlock = under ? twoPlus / under : 0;
  // Mutual support: which other positions can fire into the ground around each one.
  const supportedBy = fighting.map((_, k) =>
    fighting.filter((_, j) => j !== k && supports(cg, views[j], views[k]) >= COMPANY.supportedShare).map((o) => o.label),
  );
  const unsupported = fighting.filter((_, k) => supportedBy[k].length === 0).map((r) => r.label);

  // Reasons (for the DS), from the computed facts.
  const reasons: string[] = [];
  reasons.push(layoutHeadline(chosen.type, DIR(side), platoons, L.lat, (p) => fwd(ctx, p), frontLine));
  reasons.push(
    `Spacing: ${spread.name}${spread.name === 'very wide' ? ', dispersed against drones and artillery' : ''}. ` +
      `${options.dispersed ? 'Teams' : 'Sections'} at least about ${Math.round(options.dispersed ? C.teamSpacingM : C.sectionSpacingM)} m apart; ` +
      `platoon areas about ${Math.round(C.platoonFrontM)} × ${Math.round(C.platoonDepthM)} m.`,
  );
  for (const p of platoons) {
    const s = p.positions.filter((x) => x.kind !== 'outpost').length;
    reasons.push(
      `${p.name} (${ROLE_NAMES[p.role]}): ${s} ${p.role === 'screen' ? 'small teams' : p.role === 'reserve' ? 'vehicles (BMPs)' : options.dispersed ? 'small teams' : 'sections'}${p.reverseSlope ? ', on a reverse slope behind a crest' : ''}` +
        `${p.positions.some((x) => x.kind === 'outpost') ? ', with an outpost on the crest' : ''}.`,
    );
  }
  reasons.push(`Interlocking arcs: ${pct(interlock)} of the ground under the company's fire is covered by two or more positions.`);
  reasons.push(
    `Mutual support: ${fighting.length - unsupported.length} of ${fighting.length} positions can be supported by fire from at least one other ` +
      `(it sees at least ${pct(COMPANY.supportedShare)} of the ground within ${COMPANY.supportRadiusM} m of them).` +
      (unsupported.length ? ` Not supported: ${unsupported.join(', ')}.` : ''),
  );
  if (gaps[0]) {
    reasons.push(
      `Gap between the forward platoons: about ${Math.round(gaps[0].widthM)} m between their nearest positions. Of the ground within 150 m of its centre, ` +
        `the depth platoon sees ${pct(gaps[0].coveredFromDepth)} and the company as a whole ${pct(gaps[0].coveredByAny)}.` +
        (gaps[0].coveredByAny < 0.5 ? ' The gap is poorly covered by fire: a weakness in this defence.' : ''),
    );
  }
  if (L.deadTotal) {
    let dz = 0;
    for (let i = 0; i < N; i++) dz += deadGround[i];
    reasons.push(`Dead ground within 300 m in front of the forward positions that no enemy position can see: about ${Math.round((dz * cg.cellM * cg.cellM) / 10000)} ha.`);
  }
  if (options.mines && mines) {
    let m = 0;
    for (let i = 0; i < N; i++) m += mines[i];
    reasons.push(`Mines and obstacles across the approaches: about ${Math.round((m * cg.cellM * cg.cellM) / 10000)} ha, from ${C.mineFromM} m in front of the forward positions.`);
  }
  if (options.dummies) reasons.push(`${dummies.length} dummy positions on good ground the enemy did not use.`);
  if (options.droneConcealment) reasons.push('Positions sited for concealment from drones: tree lines, hedges and cover preferred, open ground avoided.');
  if (options.isrFires) reasons.push('The enemy has drone surveillance over the approaches and indirect fire on call.');

  return {
    layout: chosen.type,
    spread: { name: spread.name, factor: spread.factor },
    attackerSide: nearestSide((side + 180) % 360),
    advanceBearingDeg: side,
    routes: L.routes,
    platoons,
    hq,
    dummies,
    options,
    gaps,
    maskWidth: cg.width,
    maskHeight: cg.height,
    maskCellM: cg.cellM,
    killZone,
    deadGround,
    mines,
    minefields: mines ? minefieldOutlines(mines, cg.width, cg.height, cg.cellM) : [],
    interlock,
    support: fighting.map((r, k) => ({ label: r.label, supportedBy: supportedBy[k] })),
    reasons,
    log,
  };
}

/** Unit vector of the attacker's movement for a layout (for the map). */
export const advanceVector = (l: CompanyLayout) => bearingVector(l.advanceBearingDeg);

/**
 * Split a mines mask into separate minefields and give each an outline (its
 * convex hull, local metres), so it can be drawn as an APP-6 minefield (PO,
 * 23 Nov 2026). Mined cells within `joinM` of each other count as one field;
 * scraps smaller than `minAreaM2` are dropped.
 */
export function minefieldOutlines(mask: Uint8Array, width: number, height: number, cellM: number, joinM = 30, minAreaM2 = 2000): Point[][] {
  const label = new Int32Array(width * height).fill(-1);
  const R = Math.max(1, Math.round(joinM / cellM));
  const out: Point[][] = [];
  const toX = (c: number) => (c + 0.5) * cellM - (width * cellM) / 2;
  const toY = (r: number) => (height * cellM) / 2 - (r + 0.5) * cellM;
  for (let s0 = 0; s0 < mask.length; s0++) {
    if (!mask[s0] || label[s0] >= 0) continue;
    const id = out.length;
    const cells: number[] = [];
    const stack = [s0];
    label[s0] = id;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const r = Math.floor(i / width), c = i % width;
      for (let dr = -R; dr <= R; dr++)
        for (let dc = -R; dc <= R; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue;
          const j = rr * width + cc;
          if (mask[j] && label[j] < 0) { label[j] = id; stack.push(j); }
        }
    }
    if (cells.length * cellM * cellM < minAreaM2) { out.push([]); continue; }
    // Convex hull of the cell corners (monotone chain).
    const h = cellM / 2;
    const pts: Point[] = [];
    for (const i of cells) {
      const x = toX(i % width), y = toY(Math.floor(i / width));
      pts.push({ x: x - h, y: y - h }, { x: x + h, y: y - h }, { x: x + h, y: y + h }, { x: x - h, y: y + h });
    }
    pts.sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: Point[] = [], upper: Point[] = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let k = pts.length - 1; k >= 0; k--) {
      const p = pts[k];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    out.push([...lower.slice(0, -1), ...upper.slice(0, -1)]);
  }
  return out.filter((o) => o.length >= 3);
}
