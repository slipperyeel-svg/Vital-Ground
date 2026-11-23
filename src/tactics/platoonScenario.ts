/**
 * Infantry platoon scenario against a generated enemy company, written to the
 * scenario guidelines in docs/SCENARIO_GUIDELINES.md (G1–G13, from Moltke's
 * Tactical Problems), with the PO's intent-based task types (DECISIONS.md 110),
 * variable information (111), optional enemy elements (113) and a second
 * phase in which the situation develops (G11).
 *
 * Every fact in the text comes from the computed layout, ground and features
 * (core principle 1). The quality gate (core principle 2) asks for a real
 * trade-off: a covered route that saves exposure at the cost of time, or
 * mines on the obvious route.
 */
import { bearingVector, cellToPoint, distance, pointToCell, type Grid, type Point } from '../terrain/grid';
import { localToLatLon } from '../terrain/elevation';
import { viewshed, type Obstacles } from '../terrain/viewshed';
import { slope as slopeOf } from '../terrain/slope';
import { fromBNG, fromUTM, gridMils, gridRef, inGreatBritain, milsText, toBNG, toUTM } from '../geo/gridref';
import { latLonToLocal } from '../terrain/elevation';
import { COVER, type FeatureLayers } from '../features/layers';
import { costDistance, slopeOnlyGoing } from './approach';
import { analysisGrids } from './sectionDefence';
import type { CompanyLayout, EnemyPosition } from './companyDefence';
import { hhmm, sunTimes } from './sun';

/** Offensive tasks (the original problems). */
export type AttackTask = 'secure' | 'neutralise' | 'findFix' | 'screen';
/** Defensive tasks (PO, 23 Nov 2026). */
export type DefenceTask = 'defend' | 'block';
export type TaskType = AttackTask | DefenceTask;
/** The kind of problem (PO, 23 Nov 2026: selectable, or left to chance). */
export type ProblemType = 'attack' | 'defence';
export const ATTACK_TASKS: AttackTask[] = ['secure', 'neutralise', 'findFix', 'screen'];
export const DEFENCE_TASKS: DefenceTask[] = ['defend', 'block'];
export const problemTypeOf = (t: TaskType): ProblemType => ((DEFENCE_TASKS as string[]).includes(t) ? 'defence' : 'attack');
export type InfoLevel = 'rich' | 'partial' | 'poor';
/** How much of the enemy you are tasked against lies inside your boundaries (PO, 20 Nov 2026). */
export type LaneMode = 'whole' | 'most' | 'part';
/** How often each is chosen when the DS has not chosen (first figures; DECISIONS.md 203). */
export const LANE_WEIGHTS: Record<LaneMode, number> = { whole: 0.4, most: 0.35, part: 0.25 };

export const TASK_LABEL: Record<TaskType, string> = {
  secure: 'Secure ground beyond',
  neutralise: 'Neutralise enemy in an area',
  findFix: 'Find and fix',
  screen: 'Screen a flank',
  defend: 'Defend a platoon position',
  block: 'Block a route',
};

/** The quality gate for movement: PO to tune (DECISIONS.md 127). */
export const SCENARIO_GATE = {
  /** The covered route must cut the share of the route under enemy fire by at least this much… */
  minExposureSaving: 0.2,
  /** …and cost at least this much extra distance (otherwise there is no trade-off). */
  minExtraLength: 0.15,
  /** Mines on the obvious route only make a dilemma if avoiding them costs at least this much extra distance. */
  minMineDetour: 0.1,
  /** Route cost multipliers for the "covered route" the DS computes. */
  firePenalty: 4,
  minePenalty: 30,
};

export interface EnemyReport {
  /** What the report says. */
  text: string;
  /** Who or what it comes from, and when. */
  source: string;
  reliability: 'good' | 'fair' | 'doubtful';
}

export interface RouteFacts {
  path: Point[];
  lengthM: number;
  /** Share of the route under enemy fire (at least one real position covers it). */
  underFire: number;
  /** Mined cells crossed. */
  minesCrossed: number;
}

/** Map markers for the situation (APP-6 symbols and tactical graphics are drawn from these). */
export interface ScenarioMarkers {
  /** Friendly units, always shown. */
  friendly: { label: string; designation: string; higher: string; point: Point; echelon: 'platoon' | 'company'; hq?: boolean; own?: boolean;
    /** APP-6 unit type: infantry, or mechanised infantry (armour oval) for a Boxer-mounted battlegroup. */
    kind: 'infantry' | 'mechanisedInfantry' }[];
  /** Friendly control measures (2 up): company boundary, start line, phase line. */
  control: { kind: 'boundary' | 'phaseLine'; path: Point[]; label: string; /** Boundary: units on its [left, right], looking forward. */ sides?: [string, string] }[];
  /** Defence: your platoon area (blue outline). */
  area?: { outline: Point[]; label: string };
  /** Defence: the enemy's axes. `reported` ones are shown (dashed) before the ground truth; all are shown with it. */
  enemyAxes?: { path: Point[]; label: string; reported: boolean; kind: 'mounted' | 'dismounted' | 'infiltration' }[];
  /** Defence: enemy overwatch (fire support) positions, shown with the ground truth. */
  enemyOverwatch?: { point: Point; label: string }[];
  /** Defence: the enemy's assembly area, shown with the ground truth. */
  enemyAssembly?: Point;
  /** The battlegroup objective. */
  bgObjective: { point: Point; name: string; onMap: boolean };
  /** Effects arrows (axes of advance), always shown. */
  axes: { label: string; path: Point[]; own: boolean }[];
  /** The task graphic on the objective. */
  task: { kind: TaskType; objective: Point; from: Point; across: Point; label: string; /** Your objective's codename, e.g. "OBJ KESTREL" (secure and neutralise only). */ code?: string };
  /** Enemy the scenario says has been seen: shown as suspected, in phase 1 or once the situation develops. */
  sightings: { phase: 1 | 2; point: Point; echelon: 'team' | 'section' | 'platoon'; label: string; dummy?: boolean }[];
  /** A suspected minefield outline, if reported (phase 1) or found (phase 2). */
  minefields: { phase: 1 | 2; outline: Point[]; label: string }[];
}

export type BgType = 'light' | 'mechanised';

/**
 * Units (PO, 15 Nov 2026). The user's own units are fictional: 1st Battalion,
 * The Sandhurst Rifles; The Camberley Yeomanry (for armoured or recce problems
 * later); and 172 Field Regiment, RA (155 (Sidi Nsir), 156 and 157 Batteries),
 * the battlegroup's fire support and the user's unit for artillery problems. Every other unit (flanking battlegroups, tanks, recce) is a
 * real British Army regiment, from the PO's lists.
 */
export const OWN_BATTALION = { short: '1 SR', full: '1st Battalion, The Sandhurst Rifles' };
export const OWN_CAVALRY = { short: 'CY', full: 'The Camberley Yeomanry' };
/** The user's artillery (PO, 15 Nov 2026): 172 Field Regiment, RA, with its three batteries. */
export const OWN_ARTILLERY = {
  short: '172 Fd Regt RA',
  full: '172 Field Regiment, RA',
  batteries: ['155 (Sidi Nsir) Battery', '156 Battery', '157 Battery'],
};
/** Real infantry regiments: name and abbreviation (RRF units write FUSILIERS). */
export const INFANTRY: { name: string; abbr: string }[] = [
  { name: 'Grenadier Guards', abbr: 'GREN GDS' },
  { name: 'Coldstream Guards', abbr: 'COLDM GDS' },
  { name: 'Scots Guards', abbr: 'SG' },
  { name: 'Irish Guards', abbr: 'IG' },
  { name: 'Welsh Guards', abbr: 'WG' },
  { name: 'The Royal Regiment of Scotland', abbr: 'SCOTS' },
  { name: "The Princess of Wales's Royal Regiment", abbr: 'PWRR' },
  { name: "The Duke of Lancaster's Regiment", abbr: 'LANCS' },
  { name: 'The Royal Regiment of Fusiliers', abbr: 'FUSILIERS' },
  { name: 'The Royal Anglian Regiment', abbr: 'R ANGLIAN' },
  { name: 'The Royal Yorkshire Regiment', abbr: 'R YORKS' },
  { name: 'The Mercian Regiment', abbr: 'MERCIAN' },
  { name: 'The Royal Welsh', abbr: 'R WELSH' },
  { name: 'The Royal Irish Regiment', abbr: 'R IRISH' },
  { name: 'The Parachute Regiment', abbr: 'PARA' },
  { name: 'The Royal Gurkha Rifles', abbr: 'RGR' },
  { name: 'The Rifles', abbr: 'RIFLES' },
  { name: 'The Ranger Regiment', abbr: 'RANGER' },
];
/** Real cavalry and armoured regiments; `tanks` marks those that crew main battle tanks. */
export const CAVALRY: { name: string; abbr: string; tanks?: boolean; reserve?: boolean }[] = [
  { name: 'The Life Guards', abbr: 'LG' },
  { name: 'The Blues and Royals', abbr: 'RHG/D' },
  { name: "1st The Queen's Dragoon Guards", abbr: 'QDG' },
  { name: 'The Royal Scots Dragoon Guards', abbr: 'SCOTS DG' },
  { name: 'The Royal Dragoon Guards', abbr: 'RDG' },
  { name: "The Queen's Royal Hussars", abbr: 'QRH', tanks: true },
  { name: 'The Royal Lancers', abbr: 'RL' },
  { name: "The King's Royal Hussars", abbr: 'KRH', tanks: true },
  { name: 'The Light Dragoons', abbr: 'LD' },
  { name: 'Royal Tank Regiment', abbr: 'RTR', tanks: true },
  { name: 'The Royal Yeomanry (Reserve)', abbr: 'RY', reserve: true },
  { name: 'The Royal Wessex Yeomanry (Reserve)', abbr: 'RWxY', reserve: true },
  { name: "The Queen's Own Yeomanry (Reserve)", abbr: 'QOY', reserve: true },
  { name: 'The Scottish and North Irish Yeomanry (Reserve)', abbr: 'SNIY', reserve: true },
];
const OBJ_NAMES = ['HAWK', 'FALCON', 'KESTREL', 'MERLIN', 'HARRIER', 'OSPREY'];
/**
 * Frontage of a platoon in the attack, metres: a range, drawn per problem and
 * rounded to 100 m (PO, 20 Nov 2026: light role 800–1,500 m, mechanised
 * 1,500–3,000 m; DECISIONS.md 204). Boundaries fall halfway between neighbouring
 * platoons; A Coy sits beyond 1 Pl.
 */
export const FRONTAGE: Record<BgType, readonly [number, number]> = { light: [800, 1500], mechanised: [1500, 3000] };
/**
 * How long the platoon is given (PO, 15 Nov 2026: vary it). The time needed is the
 * obvious route at 2 km/h plus time for the task; the problem then makes it tight,
 * about right, comfortable or generous. First figures; PO to confirm.
 */
export const TIMING = {
  taskMin: { secure: 60, neutralise: 45, findFix: 45, screen: 30 } as Record<AttackTask, number>,
  slack: [
    { name: 'tight', factor: 0.8 },
    { name: 'about right', factor: 1.0 },
    { name: 'comfortable', factor: 1.3 },
    { name: 'generous', factor: 1.6 },
  ],
  minMin: 45,
  maxMin: 360,
};
const PL_NAMES = ['OAK', 'ASH', 'ELM', 'BIRCH', 'ROWAN', 'HAZEL'];

export interface PlatoonScenario {
  problemType: ProblemType;
  task: TaskType;
  info: InfoLevel;
  title: string;
  /** "Who you are" and your force (G2–G3). */
  you: string;
  force: { element: string; detail: string }[];
  /** Higher intent and your task (G4). */
  situation: string;
  /** Battlegroup type for this problem (varies). */
  bgType: BgType;
  /** Friendly forces 2 up and 1 up, and flanks (PO, 15 Nov 2026). */
  friendlyForces: { element: string; detail: string }[];
  task_text: string;
  /** Enemy information, each with source and reliability (G5). */
  enemy: EnemyReport[];
  enemyGaps: string;
  /** Time and light (G6). */
  time: string;
  /** Ground facts not on the map (G7). */
  ground: string[];
  /** Own troops (G8) and weather (G9). */
  ownTroops: string;
  weather: string;
  /** Two or three questions (G10). */
  questions: string[];
  timeAllowed: string;
  /** The time the problem is set for (ms since 1970). */
  startMs: number;
  /** Phase 2: the situation develops (G11). Replaced in the app by developments worked out from the user's plan (planEvents.ts). */
  phase2: { time: string; messages: { time: string; from: string; text: string }[]; questions: string[] };
  /** Ground truth facts, revealed after the user decides (G13: no school solution). */
  ds: string[];
  /** Defence: when the enemy's assault groups leave their assembly area (ms since 1970). */
  enemyMovesMs?: number;
  /** The objective or focus point and computed routes, for the DS map. */
  objective: Point;
  markers: ScenarioMarkers;
  direct: RouteFacts | null;
  covered: RouteFacts | null;
  /** Why it passed the quality gate, or why it is weak. */
  gate: string;
  dataNote: string;
}

export interface ScenarioInput {
  grid: Grid;
  layers: FeatureLayers | null;
  obstacles?: Obstacles | null;
  layout: CompanyLayout;
  task?: TaskType;
  info?: InfoLevel;
  seed: number;
  /** Force how much of the enemy lies inside your boundaries (the DS); otherwise chosen at random. */
  lane?: LaneMode;
  /** "Now", for the date and light. Default: the current time. */
  now?: Date;
  /** Time zone for clock times (the device's, by default). */
  timeZone?: string;
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

/** The light now (G6): before first light, in daylight (with the light left), or after last light. */
export function lightText(lat: number, lon: number, nowT: Date, tz?: string): string {
  const sun = sunTimes(lat, lon, nowT);
  const nowMs = nowT.getTime();
  if (sun.sunrise && nowMs < sun.sunrise.getTime())
    return sun.firstLight && nowMs < sun.firstLight.getTime()
      ? `It is dark. First light ${hhmm(sun.firstLight, tz)}, sunrise ${hhmm(sun.sunrise, tz)}.`
      : `First light was ${hhmm(sun.firstLight, tz)}; sunrise ${hhmm(sun.sunrise, tz)}.`;
  if (sun.lastLight && nowMs < sun.lastLight.getTime()) {
    const mins = Math.round((sun.lastLight.getTime() - nowMs) / 60_000);
    const r10 = Math.round(mins / 10) * 10, hh = Math.floor(r10 / 60), mm = r10 % 60;
    const left = mins < 60
      ? `about ${Math.max(5, Math.round(mins / 5) * 5)} minutes of light remain`
      : `about ${hh} hour${hh > 1 ? 's' : ''}${mm ? ` ${mm} minutes` : ''} of light remain${hh === 1 && !mm ? 's' : ''}`;
    const set = sun.sunset && nowMs >= sun.sunset.getTime() ? `Sunset was ${hhmm(sun.sunset, tz)}` : `Sunset ${hhmm(sun.sunset, tz)}`;
    return `${set}, last light ${hhmm(sun.lastLight, tz)}: ${left}.`;
  }
  const tomorrow = sunTimes(lat, lon, new Date(nowMs + 86_400_000));
  return `It is dark: last light was ${hhmm(sun.lastLight, tz)}. First light tomorrow ${hhmm(tomorrow.firstLight, tz)}, sunrise ${hhmm(tomorrow.sunrise, tz)}.`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

export function writePlatoonScenario(input: ScenarioInput): PlatoonScenario {
  const random = rng(input.seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
  const L = input.layout;
  const g = input.grid;
  const base = analysisGrids({ grid: g, layers: input.layers, obstacles: input.obstacles }, L.maskCellM);
  const cg = base.cg;
  const lay = base.layers;
  const going = lay ? lay.going : slopeOnlyGoing(slopeOf(cg));
  const u = bearingVector(L.advanceBearingDeg);
  const v = { x: u.y, y: -u.x }; // to the right of the advance
  const fwd = (p: Point) => p.x * u.x + p.y * u.y;
  const lat = (p: Point) => p.x * v.x + p.y * v.y;
  // The direction of advance as a grid bearing in mils (PO, 15 Nov 2026), e.g. "on 1590 mils".
  const c0 = g.meta.centre;
  const dir = `on ${c0 ? gridMils(L.advanceBearingDeg, c0.lat, c0.lon) : milsText(L.advanceBearingDeg)}`;
  const start = { x: 0, y: 0 };

  const ref = (p: Point, fig: 3 | 4 = 3) => {
    const c = g.meta.centre;
    if (!c) return `(${Math.round(p.x)} m E, ${Math.round(p.y)} m N)`;
    const ll = localToLatLon(c, p.x, p.y);
    return gridRef(ll.lat, ll.lon, fig).ref;
  };
  const square = (p: Point) => {
    const six = ref(p).split(' ');
    return six.length === 3 ? `${six[0]} ${six[1].slice(0, 2)} ${six[2].slice(0, 2)}` : six.join(' ');
  };
  /** Centre of the 1 km grid square containing p (what a report "in grid square X" can locate). */
  const squareCentre = (p: Point): Point => {
    const c = g.meta.centre;
    if (!c) return p;
    const ll = localToLatLon(c, p.x, p.y);
    let back: { lat: number; lon: number };
    if (inGreatBritain(ll.lat, ll.lon)) {
      const b = toBNG(ll.lat, ll.lon);
      back = fromBNG(Math.floor(b.easting / 1000) * 1000 + 500, Math.floor(b.northing / 1000) * 1000 + 500);
    } else {
      const t = toUTM(ll.lat, ll.lon);
      back = fromUTM({ ...t, easting: Math.floor(t.easting / 1000) * 1000 + 500, northing: Math.floor(t.northing / 1000) * 1000 + 500 });
    }
    return latLonToLocal(c, back.lat, back.lon);
  };
  const sightings: ScenarioMarkers['sightings'] = [];
  function mineOutline(): Point[] {
    let fMin = Infinity, fMax = -Infinity, lMin = Infinity, lMax = -Infinity;
    if (L.mines)
      for (let i = 0; i < L.mines.length; i++) {
        if (!L.mines[i]) continue;
        const q = cellToPoint(cg, i % cg.width, Math.floor(i / cg.width));
        const f = q.x * u.x + q.y * u.y, l = q.x * v.x + q.y * v.y;
        fMin = Math.min(fMin, f); fMax = Math.max(fMax, f); lMin = Math.min(lMin, l); lMax = Math.max(lMax, l);
      }
    if (!Number.isFinite(fMin)) return [];
    return [[lMin, fMin], [lMax, fMin], [lMax, fMax], [lMin, fMax]].map(([l, f]) => ({ x: u.x * f + v.x * l, y: u.y * f + v.y * l }));
  }
  const minefields: ScenarioMarkers['minefields'] = [];
  const N = cg.width * cg.height;
  const cellOf = (p: Point) => {
    const c = pointToCell(cg, p);
    return c.col >= 0 && c.row >= 0 && c.col < cg.width && c.row < cg.height ? c.row * cg.width + c.col : -1;
  };

  // ---- The enemy, as laid out --------------------------------------------
  const fwdPl = L.platoons.filter((p) => p.role === 'forward');
  const depthPl = L.platoons.find((p) => p.role === 'depth') ?? null;
  /** A mounted counter-attack force held back (PO, 19 Nov 2026), if the enemy has one. */
  const reservePl = L.platoons.find((p) => p.role === 'reserve') ?? null;
  const main = L.routes[0];
  const distToMain = (p: Point) => Math.min(...main.map((q) => distance(p, q)));
  const blocking = [...fwdPl].sort((a, b) => distToMain(a.centre) - distToMain(b.centre))[0];
  const other = fwdPl.find((p) => p !== blocking) ?? blocking;
  const frontLine = Math.min(...fwdPl.flatMap((p) => p.positions.map((x) => fwd(x.point))));
  const real = L.platoons.flatMap((p) => p.positions);
  const outposts = real.filter((x) => x.kind === 'outpost');

  // ---- Routes: direct (easiest going) and covered (avoiding enemy fire and mines) ----
  const coveredGoing = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let c = going[i];
    if (L.killZone[i]) c *= 1 + SCENARIO_GATE.firePenalty * Math.min(3, L.killZone[i]);
    if (L.mines && L.mines[i]) c *= SCENARIO_GATE.minePenalty;
    coveredGoing[i] = c;
  }
  const s0 = cellOf(start);
  const plain = costDistance(cg, going, [s0]);
  const safe = costDistance(cg, coveredGoing, [s0]);
  const routeTo = (prev: Int32Array, cost: Float64Array, p: Point): RouteFacts | null => {
    const e = cellOf(p);
    if (e < 0 || !Number.isFinite(cost[e])) return null;
    const cells: number[] = [];
    for (let i = e; i >= 0; i = prev[i]) cells.push(i);
    cells.reverse();
    const path = cells.map((i) => cellToPoint(cg, i % cg.width, Math.floor(i / cg.width)));
    let len = 0, fire = 0, mines = 0;
    for (let k = 1; k < cells.length; k++) {
      const d = distance(path[k - 1], path[k]);
      len += d;
      if (L.killZone[cells[k]]) fire += d;
      if (L.mines && L.mines[cells[k]]) mines++;
    }
    return { path, lengthM: len, underFire: len ? fire / len : 0, minesCrossed: mines };
  };

  // ---- Task and objective --------------------------------------------------
  const half = (cg.width * cg.cellM) / 2 - 150;
  const clampBox = (p: Point) => ({ x: Math.max(-half, Math.min(half, p.x)), y: Math.max(-half, Math.min(half, p.y)) });
  const objectiveFor = (t: AttackTask): { point: Point; name: string } => {
    if (t === 'secure') {
      const beyond = (depthPl ? fwd(depthPl.centre) : frontLine + 500) + 300;
      const q = main.find((p) => fwd(p) >= beyond) ?? main[main.length - 1];
      return { point: clampBox(q), name: groundName(q) };
    }
    if (t === 'neutralise') return { point: blocking.centre, name: `the enemy in grid square ${square(blocking.centre)}` };
    if (t === 'findFix') {
      const gp = L.gaps[0]?.centre ?? blocking.centre;
      return { point: { x: gp.x - u.x * 250, y: gp.y - u.y * 250 }, name: `the enemy's forward positions` };
    }
    // Screen: the flank on the side of the forward platoon away from the main route.
    const side = Math.sign(lat(other.centre) - lat(blocking.centre)) || 1;
    const p = { x: start.x + v.x * side * 700 + u.x * Math.max(300, frontLine - 300), y: start.y + v.y * side * 700 + u.y * Math.max(300, frontLine - 300) };
    return { point: clampBox(p), name: `the company's ${side > 0 ? 'right' : 'left'} flank` };
  };
  function groundName(p: Point): string {
    const i = cellOf(p);
    if (lay && i >= 0) {
      if (lay.crossing[i]) return `the crossing at ${ref(p)}`;
      if (lay.cover[i] === COVER.wood) return `the wood edge at ${ref(p)}`;
      if (lay.cover[i] === COVER.builtUp || lay.cover[i] === COVER.building) return `the buildings at ${ref(p)}`;
    }
    const h = cg.data[i] ?? 0;
    let higher = 0, n = 0;
    for (let k = 0; k < N; k += 37) {
      n++;
      if (cg.data[k] > h) higher++;
    }
    if (n && higher / n < 0.25) return `the high ground at ${ref(p)}`;
    return `the track junction area at ${ref(p)}`;
  }

  const evaluate = (t: AttackTask) => {
    const obj = objectiveFor(t);
    const direct = routeTo(plain.prev, plain.cost, obj.point);
    const covered = routeTo(safe.prev, safe.cost, obj.point);
    let ok = false;
    let why = '';
    if (direct && covered) {
      const saving = direct.underFire - covered.underFire;
      const extra = direct.lengthM ? covered.lengthM / direct.lengthM - 1 : 0;
      if (direct.minesCrossed > 0 && covered.minesCrossed === 0 && extra >= SCENARIO_GATE.minMineDetour) {
        ok = true;
        why = `the obvious route crosses mines; a route avoiding them exists (${pct(extra)} longer).`;
      } else if (saving >= SCENARIO_GATE.minExposureSaving && extra >= SCENARIO_GATE.minExtraLength) {
        ok = true;
        why = `a covered route cuts the share under enemy fire from ${pct(direct.underFire)} to ${pct(covered.underFire)}, at the cost of ${pct(extra)} more distance.`;
      } else if (saving >= SCENARIO_GATE.minExposureSaving) {
        why = `a covered route is better and hardly longer: little dilemma.`;
      } else {
        why = `no route avoids the enemy's fire much better than the obvious one.`;
      }
    } else why = 'no route to the objective.';
    return { t, obj, direct, covered, ok, why };
  };
  const wanted = input.task && problemTypeOf(input.task) === 'attack' ? (input.task as AttackTask) : undefined;
  const order: AttackTask[] = wanted ? [wanted] : ([...ATTACK_TASKS]).sort(() => random() - 0.5);
  const tried = order.map(evaluate);
  const chosen = tried.find((x) => x.ok) ?? tried[0];
  const task = chosen.t;
  const objective = chosen.obj;
  const info: InfoLevel = input.info ?? pick(['rich', 'partial', 'partial', 'poor'] as InfoLevel[]);

  // ---- Time and light (G6) ---------------------------------------------------
  const centre = g.meta.centre ?? { lat: 51.5, lon: -1 };
  // The time now is the real time, or the time the DS set for the problem (PO, 15 Nov 2026).
  const nowT = input.now ?? new Date();
  random(); // (was the dawn/afternoon choice; kept so the other choices for a seed stay the same)
  // Complete by (PO, 15 Nov 2026: vary it): the time the task needs (the obvious route
  // at 2 km/h, plus time for the task itself), made tight, about right, comfortable
  // or generous; to the nearest ten minutes, between 45 minutes and 6 hours.
  const tenMin = 10 * 60_000;
  const rt = rng(input.seed ^ 0x71e);
  const approachMin = chosen.direct ? (chosen.direct.lengthM / 2000) * 60 : 60;
  const needMin = approachMin + TIMING.taskMin[task];
  const slack = TIMING.slack[Math.floor(rt() * TIMING.slack.length)];
  const allowMin = Math.max(TIMING.minMin, Math.min(TIMING.maxMin, needMin * slack.factor));
  const byT = new Date(Math.round((nowT.getTime() + allowMin * 60_000) / tenMin) * tenMin);
  const tz = input.timeZone;
  const dateStr = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: tz }).format(nowT);
  const light = lightText(centre.lat, centre.lon, nowT, tz);
  const time = `${dateStr}. Time now ${hhmm(nowT, tz)}. ${light} Your task is to be complete by ${hhmm(byT, tz)}.`;
  const t2 = new Date(nowT.getTime() + 40 * 60_000);

  // ---- Who you are, your force, situation and task (G2–G4) -------------------
  // 2 up: battlegroup name and type (own random stream, so the other choices for a seed are unchanged).
  const r2 = rng(input.seed ^ 0x5eed2);
  const pick2 = <T>(xs: T[]) => xs[Math.floor(r2() * xs.length)];
  const bgType: BgType = r2() < 0.5 ? 'light' : 'mechanised';
  const bn = OWN_BATTALION;
  const nb = pick2(INFANTRY);
  const neighbour = { short: `1 ${nb.abbr}`, full: `1st Battalion, ${nb.name}` };
  // The battlegroup on the far flank, beyond A Coy (PO, 23 Nov 2026: boundaries between all
  // the units detailed). Own random stream, so the other choices for a seed are unchanged.
  const others = INFANTRY.filter((x) => x.abbr !== nb.abbr);
  const nb2 = others[Math.floor(rng(input.seed ^ 0xfa2)() * others.length)];
  const farNeighbour = { short: `1 ${nb2.abbr}`, full: `1st Battalion, ${nb2.name}` };
  const tankRegt = pick2(CAVALRY.filter((c) => c.tanks));
  const battery = pick2(OWN_ARTILLERY.batteries);
  const bgObjName = `OBJ ${pick2(OBJ_NAMES)}`;
  pick2(PL_NAMES); // (was the phase line's name: PO, 20 Nov 2026, no phase lines; kept so the other choices for a seed stay the same)
  // Your own objective gets a codename too (PO, 15 Nov 2026): "OBJ KESTREL (the track junction area at …)".
  const objCode = task === 'secure' || task === 'neutralise' ? `OBJ ${pick2(OBJ_NAMES.filter((n) => `OBJ ${n}` !== bgObjName))}` : '';
  if (objCode) objective.name = `${objCode} (${objective.name})`;
  // Own random stream, so the other choices for a seed stay the same.
  const [fLo, fHi] = FRONTAGE[bgType];
  const spacing = Math.round((fLo + rng(input.seed ^ 0xf40)() * (fHi - fLo)) / 100) * 100;
  const bg = `${bn.short} BG`;
  const infKind = bgType === 'mechanised' ? 'mechanisedInfantry' as const : 'infantry' as const;
  const you = `You command 2 Platoon, B Company, ${bn.full}${bgType === 'mechanised' ? ' (mechanised, in Boxer)' : ''}. Your company commander is with Company HQ.`;
  const force = bgType === 'light'
    ? [
        { element: '3 sections', detail: 'Eight men each, in two fire teams, with a general-purpose machine gun (GPMG).' },
        { element: 'Platoon HQ', detail: 'Platoon commander, platoon sergeant and signaller, with a small reconnaissance drone (about 30 minutes\' endurance).' },
        { element: 'Fire support', detail: `Battlegroup mortars, and ${battery}, ${OWN_ARTILLERY.full}, in support of the battlegroup. Call for fire through your company commander.` },
      ]
    : [
        { element: '3 sections', detail: 'Eight men each, mounted in Boxer, in two fire teams with a general-purpose machine gun (GPMG).' },
        { element: 'Vehicles', detail: 'Four Boxers (one per section and one for Platoon HQ), each with a remote weapon station (heavy or grenade machine gun). They can give fire support wherever they can see the enemy and survive.' },
        { element: 'Platoon HQ', detail: 'Platoon commander, platoon sergeant and signaller, with a small reconnaissance drone (about 30 minutes\' endurance).' },
        { element: 'Fire support', detail: `Battlegroup mortars, and ${battery}, ${OWN_ARTILLERY.full}, in support of the battlegroup. Call for fire through your company commander.` },
      ];
  const along = (() => {
    if (!lay) return '';
    let road = 0, track = 0;
    for (const p of main) {
      const i = cellOf(p);
      if (i < 0) continue;
      if (lay.route[i] >= 3) road++;
      else if (lay.route[i] === 2) track++;
    }
    return road / main.length > 0.4 ? ' along the road' : (road + track) / main.length > 0.4 ? ' along the track' : '';
  })();
  const situation =
    `${bg} is advancing ${dir}${along} from ${ref(start)}, with B Company leading. ` +
    `The enemy is believed to be holding the ground ahead to block the advance.`;
  const taskText = {
    secure: `Secure ${objective.name} by ${hhmm(byT, tz)} in order to allow the battlegroup to pass through ${dir}.`,
    neutralise: `Neutralise ${objective.name} in order to open the route ${dir} for the battlegroup.`,
    findFix: `Find ${objective.name} across the company's front and fix them in order to allow the company to attack them in the flank.`,
    screen: `Screen ${objective.name} as the company advances in order to give early warning of any enemy move against it and to stop small enemy parties.`,
  }[task];
  const noInstructions = info === 'poor' && random() < 0.3;
  const task_text = noInstructions
    ? `Your company commander has been called away and you have no precise instructions beyond the battlegroup's aim. Act on your own judgement.`
    : taskText;

  // ---- Enemy information (G5) -----------------------------------------------
  const enemy: EnemyReport[] = [];
  const firstPos = (pl: typeof blocking) => pl.positions.find((x) => x.kind !== 'outpost') ?? pl.positions[0];
  const imagery = `Battlegroup drone imagery, ${hhmm(new Date(nowT.getTime() - 90 * 60_000), tz)} today`;
  if (info === 'rich') {
    const ech = L.options.dispersed ? 'team' : 'section';
    for (const pl of fwdPl) {
      const ps = pl.positions.filter((x) => x.kind !== 'outpost').slice(0, 2);
      enemy.push({ text: `Fresh trenches and firing positions at ${ps.map((x) => ref(x.point)).join(' and ')}.`, source: imagery, reliability: 'good' });
      for (const x of ps) sightings.push({ phase: 1, point: x.point, echelon: ech, label: '' });
    }
    // Dummies show up in imagery exactly like real positions.
    for (const d of L.dummies.slice(0, 2)) {
      enemy.push({ text: `Further trenches at ${ref(d.point)}.`, source: imagery, reliability: 'good' });
      sightings.push({ phase: 1, point: d.point, echelon: ech, label: '' });
    }
    if (depthPl) {
      enemy.push({ text: `Probable further positions in grid square ${square(depthPl.centre)}; vehicle tracks lead into it.`, source: imagery, reliability: 'fair' });
      sightings.push({ phase: 1, point: squareCentre(depthPl.centre), echelon: 'platoon', label: '?' });
    }
    if (L.mines) {
      enemy.push({ text: `Disturbed ground across the track ahead, possibly mines.`, source: imagery, reliability: 'fair' });
      minefields.push({ phase: 1, outline: mineOutline(), label: 'Suspected minefield' });
    }
    if (L.options.isrFires) enemy.push({ text: 'Enemy drones have been seen over the area since first light; artillery has fallen within minutes of our vehicles being seen.', source: 'Battlegroup HQ', reliability: 'good' });
    if (reservePl) enemy.push({ text: `Two or three armoured vehicles, probably BMPs, seen moving into cover near ${ref(squareCentre(reservePl.centre))}, behind the enemy position.`, source: imagery, reliability: 'fair' });
  } else if (info === 'partial') {
    enemy.push({
      text: `A patrol was fired on last night from the area of grid square ${square(firstPos(blocking).point)}: at least one machine gun. Strength unknown.`,
      source: 'B Company patrol, 0200 today',
      reliability: 'fair',
    });
    sightings.push({ phase: 1, point: squareCentre(firstPos(blocking).point), echelon: 'section', label: 'MG' });
    if (L.mines) enemy.push({ text: 'The enemy laid mines along the track last week.', source: 'A local farmer', reliability: 'doubtful' });
    if (reservePl) enemy.push({ text: `Tracked vehicles were heard moving behind the enemy position during the night, in the area of grid square ${square(reservePl.centre)}.`, source: 'B Company patrol, 0200 today', reliability: 'fair' });
  } else {
    enemy.push({
      text: `The enemy is believed to be holding the ground about ${km(Math.round(frontLine / 100) * 100)} ahead, between grid squares ${square(fwdPl[0].centre)} and ${square(fwdPl[fwdPl.length - 1].centre)}.`,
      source: "Your company commander's assessment",
      reliability: 'fair',
    });
  }
  const enemyGaps =
    info === 'rich'
      ? 'any positions under trees or overhead cover, which would not show in imagery.'
      : info === 'partial'
        ? `what lies on either side of grid square ${square(firstPos(blocking).point)}, and in depth.`
        : "the enemy's positions, strength and depth.";

  // ---- Ground facts not on the map (G7) ----------------------------------
  const ground: string[] = [];
  if (lay) {
    let inWood = 0, open = 0, water: Point | null = null;
    for (const p of main) {
      const i = cellOf(p);
      if (i < 0) continue;
      if (lay.cover[i] === COVER.wood) inWood++;
      if (!water && (lay.stream[i] || lay.river[i])) water = p;
      if (base.obstacles) {
        const c = pointToCell(cg, p);
        let near = false;
        for (let dr = -2; dr <= 2 && !near; dr++)
          for (let dc = -2; dc <= 2; dc++) {
            const rr = c.row + dr, cc = c.col + dc;
            if (rr >= 0 && cc >= 0 && rr < cg.height && cc < cg.width && base.obstacles.heightM[rr * cg.width + cc] >= 1) {
              near = true;
              break;
            }
          }
        if (!near) open++;
      }
    }
    if (base.obstacles) ground.push(`The obvious route ${dir} runs in the open, with no hedge, wall or trees within 20 m, for about ${pct(open / main.length)} of its length.`);
    if (inWood) ground.push(`It passes through woods for about ${km(inWood * cg.cellM)}.`);
    if (water) ground.push(`It crosses a stream or ditch at ${ref(water)}.`);
  }
  {
    // What can be seen from the start, of the ground the enemy holds.
    const vs = viewshed(cg, start, { obsHeightM: 2, targetHeightM: 1.5, maxRangeM: 2500, obstacles: base.obstacles });
    let seen = 0, total = 0;
    for (const pl of fwdPl)
      for (const x of pl.positions) {
        const i = cellOf(x.point);
        if (i < 0) continue;
        total++;
        seen += vs[i];
      }
    ground.push(
      total && seen / total > 0.6
        ? 'From where you stand you can see most of the ground ahead where the enemy is thought to be.'
        : total && seen / total > 0.2
          ? 'From where you stand you can see some, but not all, of the ground ahead.'
          : 'From where you stand you cannot see the ground where the enemy is thought to be: it lies beyond a crest or behind cover.',
    );
  }

  // ---- Own troops (G8) and weather (G9) ---------------------------------------
  // 1 Pl goes on the side of the other enemy forward platoon, which it is to fix (PO, 15 Nov 2026);
  // in the screen task 1 Pl takes the main route and you screen the flank towards the other platoon.
  const sOther = Math.sign(lat(other.centre) - lat(blocking.centre)) || 1;
  const onePlSide = task === 'screen' ? -sOther : sOther;
  const ownTroops = `1 Platoon is advancing on your ${onePlSide > 0 ? 'right' : 'left'}. 3 Platoon (the company reserve) and Company HQ are with you at ${ref(start)}.`;
  const weather = pick([
    'Bright and dry; visibility good. Drones will fly.',
    'Low cloud and light rain; visibility about 800 m. Drones will struggle to fly.',
    'Mist in the low ground, clearing by mid-morning; visibility poor at first.',
    'Overcast and dry; visibility good.',
  ]);

  // ---- Questions (G10) ----------------------------------------------------------
  const questions: string[] = [];
  if (info !== 'rich') questions.push('Where do you expect the enemy to be, and why? Mark the positions you expect.');
  questions.push(
    {
      secure: `How will you secure ${objCode || objective.name}? Walk the route you would take and mark your key positions.`,
      neutralise: `How will you neutralise ${objCode || objective.name}? Mark your fire support position and your assault route, and walk your approach.`,
      findFix: 'How will you find the enemy and fix them? Mark where you will observe from and where you will fix them.',
      screen: 'Where will you place your screen? Walk to and mark your observation posts.',
    }[task],
  );
  questions.push('Give your outline orders to your section commanders.');

  // ---- Phase 2: the situation develops (G11) ------------------------------------------
  const messages: { time: string; from: string; text: string }[] = [];
  const at = (mins: number) => hhmm(new Date(t2.getTime() + mins * 60_000), tz);
  const mineOnRoute = L.mines && chosen.direct ? chosen.direct.path.find((p) => L.mines![cellOf(p)]) : undefined;
  const events: (() => void)[] = [];
  if (L.options.isrFires && info !== 'rich') {
    events.push(() => {
      const hit = chosen.direct?.path[Math.floor((chosen.direct?.path.length ?? 2) / 3)] ?? start;
      messages.push({ time: at(-10), from: 'Company HQ', text: 'Enemy drone seen overhead, heading back east.' });
      messages.push({ time: at(-2), from: 'Company HQ', text: `Six rounds of enemy artillery landed at ${ref(hit)}, on the route. No casualties.` });
    });
  }
  if (mineOnRoute) {
    events.push(() => {
      messages.push({ time: at(0), from: 'Your lead section', text: `Anti-personnel mines found on the track at ${ref(mineOnRoute)}. One man slightly injured.` });
      const r = 60;
      minefields.push({
        phase: 2,
        outline: [0, 1, 2, 3].map((k) => ({ x: mineOnRoute.x + r * Math.cos((k * Math.PI) / 2 + Math.PI / 4), y: mineOnRoute.y + r * Math.sin((k * Math.PI) / 2 + Math.PI / 4) })),
        label: 'Mines found',
      });
    });
  }
  if (L.dummies.length && info === 'rich') {
    events.push(() => {
      const d = L.dummies[0];
      const realNear = real.filter((x) => x.kind !== 'hq').sort((a, b) => distance(a.point, d.point) - distance(b.point, d.point))[0];
      messages.push({ time: at(0), from: '1 Platoon', text: `The trenches at ${ref(d.point)} are empty: a dummy. We are being fired on from about ${ref(realNear.point)}.` });
      sightings.push({ phase: 2, point: d.point, echelon: L.options.dispersed ? 'team' : 'section', label: '', dummy: true });
      sightings.push({ phase: 2, point: realNear.point, echelon: L.options.dispersed ? 'team' : 'section', label: '' });
    });
  }
  if (outposts.length) {
    events.push(() => {
      messages.push({ time: at(0), from: 'Your lead section', text: `Under machine-gun fire from about ${ref(outposts[0].point)}. Two or three men seen. We are in cover.` });
      sightings.push({ phase: 2, point: outposts[0].point, echelon: 'team', label: 'MG' });
    });
  }
  events.push(() => {
    const p = firstPos(other).point;
    messages.push({ time: at(5), from: '1 Platoon', text: `Pinned down by fire from about ${ref(p)}. Unable to move forward.` });
    sightings.push({ phase: 2, point: p, echelon: L.options.dispersed ? 'team' : 'section', label: '' });
  });
  // One or two events, in a random order.
  const nEv = Math.min(events.length, 1 + (random() < 0.5 ? 1 : 0));
  events.sort(() => random() - 0.5).slice(0, nEv).forEach((e) => e());
  messages.sort((a, b) => a.time.localeCompare(b.time));
  // Friendly units and effects arrows (always shown).
  const onePl = { x: start.x + v.x * onePlSide * spacing, y: start.y + v.y * onePlSide * spacing };
  const behind = (d: number, l = 0) => ({ x: start.x - u.x * d + v.x * l, y: start.y - u.y * d + v.y * l });
  const friendly: ScenarioMarkers['friendly'] = [
    { label: '2 Pl (you)', designation: '2', higher: 'B', point: start, echelon: 'platoon', own: true, kind: infKind },
    { label: '1 Pl', designation: '1', higher: 'B', point: onePl, echelon: 'platoon', kind: infKind },
    { label: '3 Pl', designation: '3', higher: 'B', point: behind(400, -onePlSide * 200), echelon: 'platoon', kind: infKind },
    { label: 'B Coy HQ', designation: 'B', higher: '', point: behind(550, onePlSide * 250), echelon: 'company', hq: true, kind: infKind },
  ];
  const axisEnd = (from: Point, to: Point, short: number) => {
    const d = distance(from, to) || 1;
    short = Math.min(short, d * 0.5); // never let the arrow turn back on itself on close objectives
    return { x: to.x - ((to.x - from.x) / d) * short, y: to.y - ((to.y - from.y) / d) * short };
  };
  const axes: ScenarioMarkers['axes'] = [
    { label: '2 Pl', path: [start, axisEnd(start, objective.point, task === 'secure' ? 180 : task === 'findFix' ? 550 : 250)], own: true },
    { label: '1 Pl', path: [onePl, { x: onePl.x + u.x * Math.max(400, frontLine - 300), y: onePl.y + u.y * Math.max(400, frontLine - 300) }], own: false },
  ];
  const taskMarker: ScenarioMarkers['task'] = {
    kind: task,
    objective: objective.point,
    from: axes[0].path[1],
    across: v,
    label: { secure: 'S', neutralise: 'N', findFix: 'F', screen: 'S' }[task],
    code: objCode || undefined,
  };

  // ---- Friendly forces 2 up and 1 up (PO, 15 Nov 2026) --------------------------
  // A Coy is beyond 1 Pl; the other flank (towards the second enemy forward
  // platoon) is the battlegroup's open flank. C Coy is the battlegroup reserve.
  const onePlSideWord = onePlSide > 0 ? 'right' : 'left';
  const openSideWord = onePlSide > 0 ? 'left' : 'right';
  const bgObjFwd = Math.max(fwd(objective.point), depthPl ? fwd(depthPl.centre) : frontLine + 500) + 600;
  // On the main route if it reaches that far, otherwise straight on along the advance.
  const bgObjQ = main.find((p) => fwd(p) >= bgObjFwd) ?? { x: u.x * bgObjFwd, y: u.y * bgObjFwd };
  const bgObjOnMap = Math.abs(bgObjQ.x) <= half && Math.abs(bgObjQ.y) <= half && distance(bgObjQ, objective.point) > 450;
  const bgObjective = { point: bgObjQ, name: bgObjName, onMap: bgObjOnMap };
  const aCoyLat = onePlSide * spacing * 2.5;
  const aCoyRaw = { x: start.x + v.x * aCoyLat, y: start.y + v.y * aCoyLat };
  const aCoy = clampBox(aCoyRaw);
  // With wide mechanised frontages A Coy can lie beyond the edge of the map: then it is not drawn.
  const onMap = (p: Point) => Math.abs(p.x) <= half && Math.abs(p.y) <= half;
  const aCoyOnMap = onMap(aCoyRaw);
  const cCoy = clampBox(behind(1400, -onePlSide * 150));
  if (aCoyOnMap) friendly.push({ label: 'A Coy', designation: 'A', higher: '', point: aCoy, echelon: 'company', kind: infKind });
  friendly.push({ label: 'C Coy', designation: 'C', higher: '', point: cCoy, echelon: 'company', kind: infKind });
  if (aCoyOnMap) axes.push({ label: 'A Coy', path: [aCoy, clampBox({ x: aCoy.x + u.x * Math.max(500, frontLine), y: aCoy.y + u.y * Math.max(500, frontLine) })], own: false });
  const across = (f: number, l0: number, l1: number): Point[] => [l0, l1].map((l) => clampBox({ x: u.x * f + v.x * l, y: u.y * f + v.y * l }));
  // The B/A boundary follows lines on the ground where it can (PO, 15 Nov
  // 2026): roads, tracks, streams, hedges, railways and wood edges, within
  // maxDev of the straight line, so it stays between the units either side.
  // Your lane (PO, 15 Nov 2026): centred on you at the start line, then bending
  // towards the enemy you are tasked against. How much of that enemy it takes in
  // varies (PO, 20 Nov 2026; DECISIONS.md 203): all of it, most of it, or only part
  // of it, with the rest in 1 Pl's lane or across the battlegroup boundary.
  const target = task === 'screen' ? [objective.point] : blocking.positions.map((x) => x.point);
  const rl = rng(input.seed ^ 0xb0d);
  const rollLane = rl();
  let laneMode: LaneMode =
    task === 'screen' ? 'most' : input.lane ?? (rollLane < LANE_WEIGHTS.whole ? 'whole' : rollLane < LANE_WEIGHTS.whole + LANE_WEIGHTS.most ? 'most' : 'part');
  const tLats = target.map(lat).sort((a2, b2) => a2 - b2);
  const tMean = tLats.reduce((a2, b2) => a2 + b2, 0) / tLats.length;
  const tFwds = target.map(fwd);
  const tFwdMin = Math.min(...tFwds), tFwdMax = Math.max(...tFwds);
  const baseDev = Math.min(300, spacing * 0.35);
  // Near the enemy the boundaries keep close to their line, so they do not clip
  // a position in or out by accident; elsewhere they follow the ground as before.
  let nearDev = baseDev;
  let halfW = spacing / 2;
  let laneC1 = tMean;
  let partSide = 0; // for 'part': +1 if the lane lies to the right of the cut (looking forward)
  if (laneMode === 'whole') {
    nearDev = Math.min(baseDev, 80);
    halfW = Math.max(spacing / 2, (tLats[tLats.length - 1] - tLats[0]) / 2 + nearDev + 60);
    laneC1 = (tLats[0] + tLats[tLats.length - 1]) / 2;
  } else if (laneMode === 'part' && tLats.length >= 2) {
    // Leave a third to a half of the positions outside, on a side chosen at random.
    const n = tLats.length;
    const want = n * (0.33 + rl() * 0.17);
    // Cut only where there is a real gap across the front between positions (not
    // through positions side by side), leaving 20–60% outside, as near as possible
    // to the share wanted; on the side chosen at random if it allows a cut.
    const cutFor = (side: number) => {
      const sorted = side > 0 ? tLats : [...tLats].reverse(); // excluded positions first
      let k0 = 0;
      for (let k = 1; k < n; k++)
        if (Math.abs(sorted[k] - sorted[k - 1]) >= 40 && k / n >= 0.2 && k / n <= 0.6 && (!k0 || Math.abs(k - want) < Math.abs(k0 - want))) k0 = k;
      return k0 ? { side, a: sorted[k0 - 1], b: sorted[k0] } : null;
    };
    const first = rl() < 0.5 ? 1 : -1;
    const c = cutFor(first) ?? cutFor(-first);
    if (c) {
      partSide = c.side;
      nearDev = Math.max(15, Math.min(baseDev, Math.abs(c.b - c.a) / 2 - 15));
      laneC1 = (c.a + c.b) / 2 + partSide * halfW;
    } else laneMode = 'most'; // every position on one line across the front: no clean cut
  }
  const laneF1 = laneMode === 'most'
    ? Math.max(300, tFwds.reduce((a2, b2) => a2 + b2, 0) / tFwds.length)
    : Math.max(300, tFwdMin - 200);
  const laneC = (f: number) => (f <= 0 ? 0 : f >= laneF1 ? laneC1 : (laneC1 * f) / laneF1);
  const devAt = (f: number) => (f >= tFwdMin - 250 && f <= tFwdMax + 250 ? nearDev : baseDev);
  const followGround = (offset: number) => {
    const nominal = (f: number) => laneC(f) + offset;
    const f0 = -1200, f1 = bgObjFwd + 300;
    const a = clampBox({ x: u.x * f0 + v.x * nominal(f0), y: u.y * f0 + v.y * nominal(f0) });
    const b = clampBox({ x: u.x * f1 + v.x * nominal(f1), y: u.y * f1 + v.y * nominal(f1) });
    // Without map features: the nominal line itself, so it still bends onto the enemy.
    const straight = () => {
      const pts: Point[] = [];
      for (let f = f0; f < f1; f += 100) pts.push(clampBox({ x: u.x * f + v.x * nominal(f), y: u.y * f + v.y * nominal(f) }));
      pts.push(b);
      return { path: pts, follows: '' };
    };
    if (!lay) return straight();
    const W = cg.width, Hh = cg.height;
    const woodEdge = (i: number) => {
      if (lay.cover[i] !== COVER.wood) return false;
      const c = i % W;
      return (c > 0 && lay.cover[i - 1] !== COVER.wood) || (c < W - 1 && lay.cover[i + 1] !== COVER.wood) ||
        (i >= W && lay.cover[i - W] !== COVER.wood) || (i < W * (Hh - 1) && lay.cover[i + W] !== COVER.wood);
    };
    const featureAt = (i: number): string => {
      if (lay.route[i] >= 3) return 'road';
      if (lay.route[i] >= 1) return 'track';
      if (lay.stream[i] || lay.river[i]) return 'stream';
      if (lay.railway[i]) return 'railway';
      if (lay.hedge[i]) return 'hedge line';
      if (woodEdge(i)) return 'wood edge';
      return '';
    };
    const cost = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const q = cellToPoint(cg, i % W, Math.floor(i / W));
      const maxDev = devAt(fwd(q));
      const dev = Math.abs(lat(q) - nominal(fwd(q)));
      if (dev > maxDev) { cost[i] = Infinity; continue; }
      cost[i] = (featureAt(i) ? 0.15 : 1) + (dev / maxDev) ** 2 * 0.5;
    }
    const s0 = cellOf(a), e0 = cellOf(b);
    if (s0 < 0 || e0 < 0) return straight();
    const { prev } = costDistance(cg, cost, [s0]);
    const cells: number[] = [];
    for (let i = e0; i >= 0; i = prev[i]) cells.push(i);
    if (cells[cells.length - 1] !== s0) return straight();
    cells.reverse();
    const tally: Record<string, number> = {};
    for (const i of cells) { const f = featureAt(i); if (f) tally[f] = (tally[f] ?? 0) + 1; }
    const top = Object.entries(tally).sort((x, y) => y[1] - x[1])[0];
    const path = cells.filter((_, k) => k % 5 === 0 || k === cells.length - 1).map((i) => cellToPoint(cg, i % W, Math.floor(i / W)));
    return { path, follows: top && top[1] * cg.cellM >= 400 ? top[0] : '' };
  };
  // Boundaries (PO, 15 Nov 2026): B/A company boundary beyond 1 Pl; the 1 Pl / 2 Pl platoon
  // boundary between you and 1 Pl; the battlegroup boundary on your open flank.
  const boundary = followGround(onePlSide * (halfW + spacing));
  const plBoundary = followGround(onePlSide * halfW);
  const bgBoundary = followGround(-onePlSide * halfW);
  const baNominal = (f: number) => ({ x: u.x * f + v.x * (laneC(f) + onePlSide * (halfW + spacing)), y: u.y * f + v.y * (laneC(f) + onePlSide * (halfW + spacing)) });
  const baOnMap = onMap(baNominal(0)) && onMap(baNominal(Math.max(400, frontLine)));
  // A Coy has two platoons up, so its frontage is two platoon frontages; beyond it is the
  // battlegroup boundary with the battlegroup on that flank.
  const farOffset = onePlSide * (halfW + 3 * spacing);
  const farNominal = (f: number) => ({ x: u.x * f + v.x * (laneC(f) + farOffset), y: u.y * f + v.y * (laneC(f) + farOffset) });
  const farOnMap = onMap(farNominal(0)) && onMap(farNominal(Math.max(400, frontLine)));
  const farBoundary = farOnMap ? followGround(farOffset) : null;
  const lineEnds = [0, laneC1].flatMap((c0) => [c0 - onePlSide * halfW, c0 + aCoyLat + onePlSide * spacing]);
  const lineLo = Math.min(...lineEnds) - 300;
  const lineHi = Math.max(...lineEnds) + 300;
  const control: ScenarioMarkers['control'] = [
    // B Coy / A Coy boundary; sides are [left, right] looking forward: B on our side, A on theirs.
    // Drawn only if it lies on the map (wide mechanised frontages can put it off the edge).
    ...(baOnMap ? [{ kind: 'boundary' as const, path: boundary.path, label: 'I', sides: (onePlSide > 0 ? ['B', 'A'] : ['A', 'B']) as [string, string] }] : []),
    { kind: 'boundary', path: plBoundary.path, label: '•••', sides: onePlSide > 0 ? ['2', '1'] : ['1', '2'] },
    { kind: 'boundary', path: bgBoundary.path, label: 'II', sides: onePlSide > 0 ? [neighbour.short, bn.short] : [bn.short, neighbour.short] },
    ...(farBoundary
      ? [{ kind: 'boundary' as const, path: farBoundary.path, label: 'II', sides: (onePlSide > 0 ? [bn.short, farNeighbour.short] : [farNeighbour.short, bn.short]) as [string, string] }]
      : []),
    { kind: 'phaseLine', path: across(150, lineLo, lineHi), label: 'SL' },
  ];
  const coyMission = {
    secure: `B Coy is to break through the enemy's forward line on the main route and secure ${objective.name} in order to allow ${bg} to pass through to ${bgObjName}.`,
    neutralise: `B Coy is to destroy the enemy on the main route in order to open the way for ${bg} to ${bgObjName}.`,
    findFix: `B Coy is to find and destroy the enemy's forward positions across the company's front in order to open the way for ${bg} to ${bgObjName}.`,
    screen: `B Coy is to break through the enemy's forward line on the main route in order to open the way for ${bg} to ${bgObjName}.`,
  }[task];
  const coyScheme = {
    secure: `2 Pl (main effort) secures ${objCode || objective.name}. 1 Pl advances on the ${onePlSideWord} and fixes the enemy in front of it so that he cannot turn on 2 Pl. 3 Pl (company reserve) is ready to reinforce 2 Pl or to meet a threat from the open ${openSideWord} flank.`,
    neutralise: `2 Pl (main effort) neutralises ${objCode || 'the enemy on the main route'}. 1 Pl advances on the ${onePlSideWord} and fixes the enemy in front of it. 3 Pl (company reserve) then passes through to exploit ${dir}.`,
    findFix: `2 Pl finds the enemy's forward positions and fixes them. 3 Pl (main effort) then attacks them in the flank. 1 Pl advances on the ${onePlSideWord} and holds the enemy in front of it.`,
    screen: `1 Pl (main effort) attacks along the main route, with 3 Pl following ready to pass through. 2 Pl screens the company's open ${openSideWord} flank.`,
  }[task];
  const friendlyForces = [
    {
      element: `2 up: ${bg}`,
      detail:
        (bgType === 'light'
          ? `A light role infantry battlegroup: three rifle companies on foot, with mortar, anti-tank and reconnaissance platoons. `
          : `A mechanised infantry battlegroup in Boxer, with a squadron of Challenger 3 tanks from ${/^(The|1st)\b/.test(tankRegt.name) ? '' : 'the '}${tankRegt.name} (${tankRegt.abbr}), mortars and engineers. `) +
        `Mission: ${bg} is to seize ${bgObjName} (${ref(bgObjective.point)}${bgObjOnMap ? '' : `, about ${km(bgObjFwd)} beyond the start line, off this map`}) in order to allow the brigade to pass through ${dir}. ` +
        `CO's intent: to break the enemy's forward line quickly on the main route, before he can reinforce or bring his artillery to bear. ` +
        `Main effort: B Coy. A Coy advances on B Coy's ${onePlSideWord} to fix the enemy in front of it; C Coy (battlegroup reserve) then passes through to ${bgObjName}. ` +
        `End state: the enemy ahead destroyed or withdrawn, the route open ${dir}, and ${bg} firm on ${bgObjName}.`,
    },
    {
      element: '1 up: B Coy',
      detail:
        `Mission: ${coyMission} OC's intent: to move fast and use the ground, and not to fight the enemy where he expects us. Scheme: ${coyScheme} ` +
        `Start line: ${ref(start)}. Platoon frontage is about ${km(2 * halfW)}; your boundary with 1 Pl is shown on the map${plBoundary.follows ? `, mostly along the ${plBoundary.follows}` : ''}.`,
    },
    {
      element: 'Flanks',
      detail:
        `${onePlSideWord[0].toUpperCase() + onePlSideWord.slice(1)}: A Coy, about ${km(Math.abs(aCoyLat))} away beyond 1 Pl; ${baOnMap ? `the B/A boundary is shown on the map${boundary.follows ? `, mostly along the ${boundary.follows}` : ''}` : 'the B/A boundary lies beyond the edge of this map'}. ` +
        `Beyond A Coy is the battlegroup boundary with ${farNeighbour.short} BG, about ${km(Math.abs(farOffset))} away${farBoundary ? `, shown on the map${farBoundary.follows ? `, mostly along the ${farBoundary.follows}` : ''}` : ', beyond the edge of this map'}; ${farNeighbour.short} BG is advancing level with ${bn.short} BG. ` +
        `${openSideWord[0].toUpperCase() + openSideWord.slice(1)}: the battlegroup boundary, about ${km(halfW)} away${bgBoundary.follows ? `, mostly along the ${bgBoundary.follows}` : ''}. Beyond it is ${neighbour.short} BG, whose nearest troops are about 5 km away and out of contact. ` +
        `Rear: C Coy (battlegroup reserve) at ${ref(cCoy)}.`,
    },
  ];

  const phase2 = {
    time: `${hhmm(t2, tz)}. Your platoon has moved off as you planned.`,
    messages,
    questions: ['What do you conclude from these reports?', 'What do you now do? Give your orders.'],
  };

  // ---- DS (G13) ------------------------------------------------------------------
  const ds: string[] = [];
  ds.push(...L.reasons);
  const posList = (xs: EnemyPosition[], pl: string) => xs.map((x) => `${x.label.replace(pl + ' ', '')} ${ref(x.point, 4)}`).join('; ');
  for (const p of L.platoons) ds.push(`${p.name}: ${posList(p.positions, p.name)}.`);
  if (L.hq) ds.push(`Coy HQ ${ref(L.hq.point, 4)}.`);
  if (L.dummies.length) ds.push(`Dummies (no enemy): ${L.dummies.map((d) => ref(d.point)).join('; ')}.`);
  // Ground truth only: the obvious route is a fact of the ground. The computed
  // best covered route and the gate's reasoning are not shown, so this never
  // reads as a school solution (PO, 15 Nov 2026); the gate still uses them.
  if (chosen.direct) {
    const d = chosen.direct;
    ds.push(
      `The obvious route to ${objective.name} (the easiest going): ${km(d.lengthM)}, ${pct(d.underFire)} of it under enemy fire` +
        `${d.minesCrossed ? `, crossing mines` : ''}.`,
    );
  }
  if (task !== 'screen') {
    // How much of the enemy you were tasked against lay inside your boundaries.
    const latAt = (path: Point[], f: number) => {
      let best = path[0];
      for (const q of path) if (Math.abs(fwd(q) - f) < Math.abs(fwd(best) - f)) best = q;
      return lat(best);
    };
    const outPl: EnemyPosition[] = [], outBg: EnemyPosition[] = [];
    for (const x of blocking.positions) {
      const lp = lat(x.point), a2 = latAt(plBoundary.path, fwd(x.point)), b2 = latAt(bgBoundary.path, fwd(x.point));
      if ((lp - a2) * onePlSide > 0) outPl.push(x);
      else if ((lp - b2) * -onePlSide > 0) outBg.push(x);
    }
    const n = blocking.positions.length, nIn = n - outPl.length - outBg.length;
    const where = [
      outPl.length ? `${outPl.length} lay in 1 Pl's lane, across your platoon boundary` : '',
      outBg.length ? `${outBg.length} lay across the battlegroup boundary, in the area of ${neighbour.short}` : '',
    ].filter(Boolean).join(', and ');
    const nOut = n - nIn;
    ds.push(
      nIn === n
        ? `Your boundaries took in all ${n} of ${blocking.name}'s positions.`
        : `Your boundaries took in ${nIn} of ${blocking.name}'s ${n} positions; ${where}. Who was to deal with ${nOut > 1 ? 'those' : 'that one'}, and could you fire across the boundary, or did you need to ask for it to be moved?`,
    );
  }
  if (L.gaps[0]) ds.push(`The gap between the enemy forward platoons is about ${km(L.gaps[0].widthM)} wide, centred on ${ref(L.gaps[0].centre)}.`);
  ds.push(
    'There is no school solution. Judge your decision by the ground and the enemy as they really were: what the enemy could and ' +
      'could not see, where their fire fell, and whether your orders gave your intent and left your section commanders free to act on it.',
  );

  const m = g.meta;
  const dataNote =
    `Ground: ${m.source}, about ${m.sourceResolutionM} m; enemy layout computed from it at ${L.maskCellM} m. ` +
    'Check access on the ground before walking to any position.';

  return {
    problemType: 'attack' as const,
    task, info,
    title: `${TASK_LABEL[task]}: 2 Platoon, B Company, ${bn.short}`,
    you, force, situation, bgType, friendlyForces, task_text, enemy, enemyGaps, time, ground, ownTroops, weather, questions,
    timeAllowed: '30 minutes for your plan; 10 minutes when the situation develops.',
    startMs: nowT.getTime(),
    phase2, ds,
    objective: objective.point,
    markers: { friendly, control, bgObjective, axes, task: taskMarker, sightings, minefields },
    direct: chosen.direct, covered: chosen.covered,
    gate: `${chosen.ok ? 'Passed' : 'Weak'}: ${chosen.why}`,
    dataNote,
  };
}
