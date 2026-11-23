/**
 * Platoon defence (PO, 23 Nov 2026): the first of the new problem types. You
 * are given a platoon area on the ground where you stand and an enemy who will
 * attack it (enemyAttack.ts). You site your sections, Platoon HQ, OP, killing
 * area and obstacle; the situation then develops from where you put them.
 *
 * Written to the same guidelines as the attack (docs/SCENARIO_GUIDELINES.md,
 * G1–G13), and in the same shape (PlatoonScenario), so the app shows it the
 * same way.
 *
 * The quality gate (core principle 2) asks for a real dilemma in the ground:
 * - forward or reverse slope: the places in your area with the widest view
 *   over the enemy's approaches are overlooked from his overwatch, while
 *   others, out of his view, still see a good part of them; or
 * - dead ground close in: an approach stays out of sight of your whole area
 *   until within 250 m of it, so covering it costs you elsewhere.
 * The best positions it finds are used only by the gate, never shown (no school
 * solution, DECISIONS.md 149–150).
 */
import { bearingVector, distance, elevationAtPoint, pointToCell, type Grid, type Point } from '../terrain/grid';
import { localToLatLon, latLonToLocal } from '../terrain/elevation';
import { lineOfSight, type Obstacles } from '../terrain/viewshed';
import { fromBNG, fromUTM, gridMils, gridRef, inGreatBritain, milsText, toBNG, toUTM } from '../geo/gridref';
import { COVER, type FeatureLayers } from '../features/layers';
import { ATTACK, attackGrids, planEnemyAttack, seenFromArea, type AttackOptions, type EnemyAttack } from './enemyAttack';
import { hhmm } from './sun';
import {
  CAVALRY, INFANTRY, OWN_ARTILLERY, OWN_BATTALION, TASK_LABEL, lightText,
  type BgType, type DefenceTask, type InfoLevel, type PlatoonScenario, type ScenarioMarkers, type TaskType,
} from './platoonScenario';

/**
 * Frontage of a platoon in defence, metres (first figures, PO to confirm):
 * narrower than in the attack, as each section must cover its neighbours.
 */
export const DEF_FRONTAGE: Record<BgType, readonly [number, number]> = { light: [400, 800], mechanised: [600, 1200] };

/** The defence quality gate (first figures, PO to tune). */
export const DEFENCE_GATE = {
  /** Candidate positions in your area every this many metres. */
  candidateStepM: 50,
  /** Fields of fire are counted out to this range (GPMG). */
  fireRangeM: 600,
  /** A concealed alternative must see at least this share of what the best-view position sees… */
  minAltShare: 0.6,
  /** …and be at least this far from it. */
  minAltApartM: 100,
  /** Dead ground on an approach within this of the forward edge of your area is a dilemma in itself. */
  closeDeadM: 250,
  /** Directions tried before settling for the best weak one. */
  maxTries: 6,
};

/** How long you have to prepare, minutes (made tight or generous at random). */
export const DEF_TIMING = { prepMin: [60, 240] as const, enemyAfterMin: [20, 90] as const };

export interface DefenceInput {
  grid: Grid;
  layers: FeatureLayers | null;
  obstacles?: Obstacles | null;
  task?: TaskType;
  info?: InfoLevel;
  seed: number;
  now?: Date;
  timeZone?: string;
  /** Force the threat bearing (degrees), e.g. in tests. */
  threatBearingDeg?: number;
  options?: Partial<AttackOptions>;
}

export interface DefenceResult {
  scenario: PlatoonScenario;
  attack: EnemyAttack;
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
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Gate facts for one threat direction: where in your area sees most of the approaches, and who sees it. */
export function defenceDilemma(cg: Grid, obstacles: Obstacles | undefined, a: EnemyAttack) {
  const G = DEFENCE_GATE;
  const u = bearingVector(a.threatBearingDeg);
  const v = { x: u.y, y: -u.x };
  const h = a.frontageM / 2;
  // Samples along the dismounted approaches, every 20 m.
  const axisPts: Point[] = [];
  for (const ax of a.axes) {
    if (ax.kind === 'mounted') continue;
    for (let k = 0; k < ax.path.length; k += 2) axisPts.push(ax.path[k]);
  }
  const cands: { p: Point; fof: number; exposed: boolean }[] = [];
  for (let l = -h; l <= h + 1; l += G.candidateStepM)
    for (let f = -h; f <= h + 1; f += G.candidateStepM) {
      const p = { x: a.centre.x + u.x * f + v.x * l, y: a.centre.y + u.y * f + v.y * l };
      let fof = 0;
      for (const q of axisPts)
        if (distance(p, q) <= G.fireRangeM && lineOfSight(cg, p, q, ATTACK.ourEyeM, ATTACK.attackerM, false, obstacles)) fof++;
      const exposed = a.overwatch.some((o) => lineOfSight(cg, o.point, p, ATTACK.overwatchEyeM, ATTACK.positionShowsM, false, obstacles));
      cands.push({ p, fof, exposed });
    }
  const best = cands.reduce((x, y) => (y.fof > x.fof ? y : x), cands[0]);
  const alt = cands
    .filter((c) => !c.exposed && c.fof >= best.fof * G.minAltShare && distance(c.p, best.p) >= G.minAltApartM)
    .sort((x, y) => y.fof - x.fof)[0];
  const slope = best.fof > 0 && best.exposed && !!alt;
  const closeDead = a.axes.filter((x) => x.kind !== 'mounted' && x.lastDeadM <= a.frontageM / 2 + G.closeDeadM);
  // How much of the approaches the forward and rear halves of the area see.
  const half = (fwdHalf: boolean) => {
    const xs = cands.filter((c) => ((c.p.x - a.centre.x) * u.x + (c.p.y - a.centre.y) * u.y > 0) === fwdHalf);
    return xs.length ? xs.reduce((s, c) => s + c.fof, 0) / xs.length : 0;
  };
  const exposedShare = cands.filter((c) => c.exposed).length / cands.length;
  return { best, alt, slope, closeDead, fwdHalf: half(true), rearHalf: half(false), exposedShare, axisSamples: axisPts.length };
}

export function writeDefenceScenario(input: DefenceInput): DefenceResult | null {
  const random = rng(input.seed ^ 0xde4);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
  const g = input.grid;
  const base = attackGrids(input);
  const cg = base.cg;
  const lay = base.layers;
  const obstacles = base.obstacles;
  const centre = { x: 0, y: 0 };
  const cellOf = (p: Point) => {
    const c = pointToCell(cg, p);
    return c.col >= 0 && c.row >= 0 && c.col < cg.width && c.row < cg.height ? c.row * cg.width + c.col : -1;
  };
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
  const c0 = g.meta.centre;
  const mils = (deg: number) => (c0 ? gridMils(deg, c0.lat, c0.lon) : milsText(deg));

  // ---- Battlegroup type and frontage (own random streams) ----
  const r2 = rng(input.seed ^ 0x5eed3);
  const pick2 = <T>(xs: T[]) => xs[Math.floor(r2() * xs.length)];
  const bgType: BgType = r2() < 0.5 ? 'light' : 'mechanised';
  const [fLo, fHi] = DEF_FRONTAGE[bgType];
  const frontageM = Math.round((fLo + rng(input.seed ^ 0xf41)() * (fHi - fLo)) / 50) * 50;

  // ---- Threat direction: try several; keep the first with a real dilemma ----
  const seen = seenFromArea(cg, centre, frontageM, obstacles);
  const bearings = input.threatBearingDeg !== undefined
    ? [input.threatBearingDeg]
    : Array.from({ length: 16 }, (_, k) => k * 22.5).sort(() => random() - 0.5).slice(0, DEFENCE_GATE.maxTries);
  type Try = { a: EnemyAttack; d: ReturnType<typeof defenceDilemma>; score: number };
  let chosen: Try | null = null;
  for (const b of bearings) {
    const a = planEnemyAttack({ grid: g, layers: input.layers, obstacles: input.obstacles, threatBearingDeg: b, centre, frontageM, seed: input.seed, options: input.options, seen });
    if (!a) continue;
    const d = defenceDilemma(cg, obstacles, a);
    const score = (d.slope ? 2 : 0) + (d.closeDead.length ? 1 : 0);
    if (!chosen || score > chosen.score) chosen = { a, d, score };
    if (d.slope) break;
  }
  if (!chosen) return null;
  const { a: attack, d: dil } = chosen;
  const u = bearingVector(attack.threatBearingDeg);
  const v = { x: u.y, y: -u.x }; // to the right, looking towards the enemy
  const at = (f: number, l: number): Point => ({ x: centre.x + u.x * f + v.x * l, y: centre.y + u.y * f + v.y * l });
  const half = (cg.width * cg.cellM) / 2 - 150;
  const clampBox = (p: Point) => ({ x: Math.max(-half, Math.min(half, p.x)), y: Math.max(-half, Math.min(half, p.y)) });
  const fromDir = `from ${mils(attack.threatBearingDeg)}`;
  const towardsUs = `on ${mils((attack.threatBearingDeg + 180) % 360)}`;

  // ---- Task ----
  const mountedAxis = attack.axes.find((x) => x.kind === 'mounted');
  const task: DefenceTask = input.task === 'defend' || input.task === 'block' ? input.task : mountedAxis && random() < 0.5 ? 'block' : 'defend';
  const blockAxis = mountedAxis ?? attack.axes[0];
  const blockPt = blockAxis.path.find((p) => distance(p, centre) <= frontageM / 2) ?? blockAxis.path[blockAxis.path.length - 1];
  const routeWord = (() => {
    if (!lay) return 'route';
    let road = 0, track = 0;
    for (const p of blockAxis.path) {
      const i = cellOf(p);
      if (i < 0) continue;
      if (lay.route[i] >= 3) road++;
      else if (lay.route[i] === 2) track++;
    }
    return road / blockAxis.path.length > 0.3 ? 'road' : (road + track) / blockAxis.path.length > 0.3 ? 'track' : 'route';
  })();
  const info: InfoLevel = input.info ?? pick(['rich', 'partial', 'partial', 'poor'] as InfoLevel[]);

  // ---- Units ----
  const bn = OWN_BATTALION;
  const nb = pick2(INFANTRY);
  const neighbour = { short: `1 ${nb.abbr}` };
  const tankRegt = pick2(CAVALRY.filter((c) => c.tanks));
  const battery = pick2(OWN_ARTILLERY.batteries);
  const bg = `${bn.short} BG`;
  const infKind = bgType === 'mechanised' ? ('mechanisedInfantry' as const) : ('infantry' as const);

  // ---- Time (G6): ready by, and when the enemy really moves ----
  const tz = input.timeZone;
  const nowT = input.now ?? new Date();
  const tenMin = 10 * 60_000;
  const rt = rng(input.seed ^ 0x71f);
  const prepMin = DEF_TIMING.prepMin[0] + rt() * (DEF_TIMING.prepMin[1] - DEF_TIMING.prepMin[0]);
  const byT = new Date(Math.round((nowT.getTime() + prepMin * 60_000) / tenMin) * tenMin);
  const enemyMovesMs = byT.getTime() + Math.round((DEF_TIMING.enemyAfterMin[0] + rt() * (DEF_TIMING.enemyAfterMin[1] - DEF_TIMING.enemyAfterMin[0])) / 5) * 5 * 60_000;
  const centreLL = c0 ?? { lat: 51.5, lon: -1 };
  const dateStr = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: tz }).format(nowT);
  const time = `${dateStr}. Time now ${hhmm(nowT, tz)}. ${lightText(centreLL.lat, centreLL.lon, nowT, tz)} You are to be in position and ready by ${hhmm(byT, tz)}.`;

  // ---- Who you are and your force (G2–G3) ----
  const you = `You command 2 Platoon, B Company, ${bn.full}${bgType === 'mechanised' ? ' (mechanised, in Boxer)' : ''}. Your company commander is with Company HQ.`;
  const force = [
    { element: '3 sections', detail: `Eight men each, in two fire teams, with a general-purpose machine gun (GPMG)${bgType === 'mechanised' ? '; mounted in Boxer' : ''}.` },
    ...(bgType === 'mechanised' ? [{ element: 'Vehicles', detail: 'Four Boxers with remote weapon stations. Dug in or hidden, they can fire from the position; in the open they will be seen and engaged.' }] : []),
    { element: 'Platoon HQ', detail: "Platoon commander, platoon sergeant and signaller, with a small reconnaissance drone (about 30 minutes' endurance)." },
    { element: 'Defence stores', detail: 'Picks, shovels and sandbags; one roll of wire and a few trip flares per section. No mines of your own.' },
    { element: 'Fire support', detail: `Battlegroup mortars, and ${battery}, ${OWN_ARTILLERY.full}. You may register up to two defensive fire (DF) targets through your company commander.` },
  ];

  // ---- Situation and friendly forces (G4, 2 up and 1 up) ----
  const onePlSide = random() < 0.5 ? 1 : -1;
  const sideWord = (s: number) => (s > 0 ? 'right' : 'left');
  const situation =
    `${bg} has halted and is to hold the ground here. The enemy has been probing ${fromDir} and is expected to attack ` +
    `within hours, to break through ${towardsUs}.`;
  const coyCentre = at(0, (onePlSide * frontageM) / 2);
  const friendlyForces = [
    {
      element: `2 up: ${bg}`,
      detail:
        (bgType === 'light'
          ? 'A light role infantry battlegroup: three rifle companies, with mortar, anti-tank and reconnaissance platoons. '
          : `A mechanised infantry battlegroup in Boxer, with a squadron of Challenger 3 tanks from ${/^(The|1st)\b/.test(tankRegt.name) ? '' : 'the '}${tankRegt.name} (${tankRegt.abbr}) in reserve. `) +
        `Mission: ${bg} is to defend the ground about ${ref(coyCentre)} in order to stop the enemy breaking through ${towardsUs}. ` +
        "CO's intent: to hold the enemy forward of the battlegroup, kill him in the open ground in front of it, and keep a reserve to strike any penetration. " +
        'Main effort: B Coy, astride the most likely enemy approach. C Coy is the battlegroup reserve.',
    },
    {
      element: '1 up: B Coy',
      detail:
        `Mission: B Coy is to defend the area around ${ref(coyCentre)} in order to stop the enemy breaking through ${towardsUs}. ` +
        `Scheme: two platoons forward: 2 Pl (you) and 1 Pl on your ${sideWord(onePlSide)}; 3 Pl in depth, ready to counter-attack. ` +
        `Your platoon area is shown on the map, about ${km(frontageM)} across. Be ready by ${hhmm(byT, tz)}.`,
    },
    {
      element: 'Flanks',
      detail:
        `${sideWord(onePlSide)[0].toUpperCase() + sideWord(onePlSide).slice(1)}: 1 Pl, then A Coy beyond it; the platoon and company boundaries are shown on the map. ` +
        `${sideWord(-onePlSide)[0].toUpperCase() + sideWord(-onePlSide).slice(1)}: the battlegroup boundary, at the edge of your area. Beyond it is ${neighbour.short} BG, whose nearest troops are about 2 km away.`,
    },
  ];
  const task_text = task === 'defend'
    ? `Defend your platoon area at ${ref(centre)} in order to stop the enemy breaking through ${towardsUs}. Be ready by ${hhmm(byT, tz)}.`
    : `Block the ${routeWord} at ${ref(blockPt)} in order to stop enemy vehicles using it to break through ${towardsUs}. Your platoon area is shown on the map. Be ready by ${hhmm(byT, tz)}.`;

  // ---- Enemy information (G5) ----
  const enemy: PlatoonScenario['enemy'] = [];
  const sightings: ScenarioMarkers['sightings'] = [];
  const imagery = `Battlegroup drone imagery, ${hhmm(new Date(nowT.getTime() - 60 * 60_000), tz)} today`;
  const reportedAxes = new Set<number>();
  if (info === 'rich') {
    enemy.push({ text: `About ten vehicles, BMPs and trucks, in the area of grid square ${square(attack.assembly)}, about ${km(distance(attack.assembly, centre))} ${fromDir}. Men dismounting.`, source: imagery, reliability: 'good' });
    sightings.push({ phase: 1, point: squareCentre(attack.assembly), echelon: 'platoon', label: '?' });
    if (attack.overwatch[0]) {
      enemy.push({ text: `Two vehicles moving into cover near ${ref(attack.overwatch[0].point)}, facing towards you.`, source: imagery, reliability: 'fair' });
      sightings.push({ phase: 1, point: attack.overwatch[0].point, echelon: 'section', label: attack.options.mounted ? 'BMP' : '' });
    }
    enemy.push({ text: `The enemy is expected to come on foot along the line of ${attack.axes[0].kind === 'mounted' ? 'the route' : 'the ground'} marked on your map.`, source: 'Battlegroup intelligence officer', reliability: 'fair' });
    reportedAxes.add(0);
  } else if (info === 'partial') {
    enemy.push({ text: `Enemy reconnaissance vehicles seen about ${km(Math.round(distance(attack.assembly, centre) / 500) * 500)} ${fromDir}, moving into dead ground.`, source: 'Battlegroup reconnaissance platoon, an hour ago', reliability: 'fair' });
    sightings.push({ phase: 1, point: squareCentre(attack.assembly), echelon: 'section', label: '?' });
  } else {
    enemy.push({ text: `The enemy is expected to attack ${fromDir}. His strength is not known.`, source: "Your company commander's assessment", reliability: 'fair' });
  }
  if (attack.options.drones && info !== 'poor') enemy.push({ text: 'Enemy drones have been over the battlegroup since first light; artillery has followed within minutes when anything was seen.', source: 'Battlegroup HQ', reliability: 'good' });
  const enemyGaps =
    info === 'rich' ? 'when he will attack, and what else he has that imagery did not show.' : info === 'partial' ? 'his strength, his axes and when he will attack.' : 'everything except the general direction of his attack.';

  // ---- Ground (G7) ----
  const ground: string[] = [];
  {
    // What can be seen from your area, out to 1 km towards the enemy.
    let n = 0, s = 0;
    for (let f = frontageM / 2 + 50; f <= frontageM / 2 + 1000; f += 50)
      for (let l = -frontageM; l <= frontageM; l += 50) {
        const i = cellOf(at(f, l));
        if (i < 0) continue;
        n++;
        s += attack.seenFromArea[i];
      }
    ground.push(`From somewhere in your area you can see about ${pct(n ? s / n : 0)} of the ground out to 1 km in front of it; the rest is dead ground.`);
    const hC = elevationAtPoint(g, centre), hF = elevationAtPoint(g, at(frontageM / 2, 0)), hFar = elevationAtPoint(g, at(frontageM / 2 + 800, 0));
    const rel = (d: number) => (Math.abs(d) < 3 ? 'is about level' : d > 0 ? `rises about ${Math.round(d)} m` : `falls about ${Math.round(-d)} m`);
    ground.push(`From the centre of your area the ground ${rel(hF - hC)} to its forward edge, then ${rel(hFar - hF).replace('is about level', 'stays about level')} over the next 800 m towards the enemy.`);
    if (lay) {
      let wood = 0, tot = 0;
      for (let l = -frontageM / 2; l <= frontageM / 2; l += 25)
        for (let f = -frontageM / 2; f <= frontageM / 2; f += 25) {
          const i = cellOf(at(f, l));
          if (i < 0) continue;
          tot++;
          if (lay.cover[i] === COVER.wood) wood++;
        }
      if (wood / Math.max(1, tot) > 0.05) ground.push(`About ${pct(wood / tot)} of your area is wooded: cover from view and from drones, but short fields of fire.`);
      else ground.push('Your area is mostly open: little cover from drones.');
    }
  }

  // ---- Own troops, weather, questions ----
  const ownTroops = `1 Platoon is on your ${sideWord(onePlSide)}. 3 Platoon (company reserve) is about 450 m behind you, at ${ref(at(-450, (onePlSide * frontageM) / 2))}; Company HQ is at ${ref(at(-800, (onePlSide * frontageM) / 2))}.`;
  const weather = pick([
    'Bright and dry; visibility good. Drones will fly.',
    'Low cloud and light rain; visibility about 800 m. Drones will struggle to fly.',
    'Mist in the low ground, clearing by mid-morning; visibility poor at first.',
    'Overcast and dry; visibility good.',
  ]);
  const questions: string[] = [];
  if (info !== 'rich') questions.push('Where do you expect the enemy to come from, and how? Mark where you expect him.');
  questions.push(
    task === 'defend'
      ? 'Where will you site your three sections and Platoon HQ, and why? Walk to each position and mark it.'
      : `Where will you site your sections and Platoon HQ to block the ${routeWord}, and why? Walk to each position and mark it.`,
    'Where will you kill the enemy? Mark your killing area, and your OP and obstacle if you have them.',
    'Give your orders to your section commanders.',
  );

  // ---- Map markers ----
  const aw = frontageM / 2 - 25; // just inside the boundaries, so the area reads as an area
  const area = [at(frontageM / 2, -aw), at(frontageM / 2, aw), at(-frontageM / 2, aw), at(-frontageM / 2, -aw)];
  const line = (l: number): Point[] => [clampBox(at(-1500, l)), clampBox(at(1800, l))];
  const onMap = (p: Point) => Math.abs(p.x) <= half && Math.abs(p.y) <= half;
  const sides = (a: string, b: string): [string, string] => (onePlSide > 0 ? [a, b] : [b, a]); // [left, right] looking at the enemy
  const control: ScenarioMarkers['control'] = [
    { kind: 'boundary', path: line((onePlSide * frontageM) / 2), label: '•••', sides: sides('2', '1') },
    { kind: 'boundary', path: line((-onePlSide * frontageM) / 2), label: 'II', sides: onePlSide > 0 ? [neighbour.short, bn.short] : [bn.short, neighbour.short] },
  ];
  if (onMap(at(0, onePlSide * frontageM * 1.5))) control.push({ kind: 'boundary', path: line(onePlSide * frontageM * 1.5), label: 'I', sides: sides('B', 'A') });
  const friendly: ScenarioMarkers['friendly'] = [
    { label: '2 Pl (you)', designation: '2', higher: 'B', point: centre, echelon: 'platoon', own: true, kind: infKind },
    { label: '1 Pl', designation: '1', higher: 'B', point: clampBox(at(0, onePlSide * frontageM)), echelon: 'platoon', kind: infKind },
    { label: '3 Pl', designation: '3', higher: 'B', point: clampBox(at(-450, (onePlSide * frontageM) / 2)), echelon: 'platoon', kind: infKind },
    { label: 'B Coy HQ', designation: 'B', higher: '', point: clampBox(at(-800, (onePlSide * frontageM) / 2)), echelon: 'company', hq: true, kind: infKind },
    { label: 'C Coy', designation: 'C', higher: '', point: clampBox(at(-1400, 0)), echelon: 'company', kind: infKind },
  ];
  if (onMap(at(0, onePlSide * frontageM * 2.5))) friendly.push({ label: 'A Coy', designation: 'A', higher: '', point: at(0, onePlSide * frontageM * 2.5), echelon: 'company', kind: infKind });
  const thin = (p: Point[]) => p.filter((_, k) => k % 4 === 0 || k === p.length - 1);
  const markers: ScenarioMarkers = {
    friendly,
    control,
    bgObjective: { point: centre, name: '', onMap: false },
    axes: [],
    task: { kind: task, objective: attack.assembly, from: centre, across: v, label: task === 'block' ? 'B' : 'D' },
    sightings,
    minefields: [],
    area: { outline: area, label: '2' },
    enemyAxes: attack.axes.map((x, k) => ({ path: thin(x.path), label: x.name, reported: reportedAxes.has(k), kind: x.kind })),
    enemyOverwatch: attack.overwatch.map((o) => ({ point: o.point, label: o.label })),
    enemyAssembly: attack.assembly,
  };

  // ---- DS: the ground truth (G13: facts, no school solution) ----
  const ds: string[] = [attack.strength, ...attack.reasons];
  for (const ax of attack.axes)
    if (Number.isFinite(ax.lastDeadM)) ds.push(`${ax.name} is last in dead ground at ${ref(ax.lastDead)}, about ${km(ax.lastDeadM)} from the centre of your area.`);
  ds.push(
    `Of the enemy's approaches within ${DEFENCE_GATE.fireRangeM} m, the forward half of your area overlooks on average ${Math.round(dil.fwdHalf * 20)} m, the rear half ${Math.round(dil.rearHalf * 20)} m. ` +
      `${pct(dil.exposedShare)} of your area can be seen from the enemy's overwatch.`,
  );
  if (attack.options.drones) ds.push('Enemy drones were over your area before the attack: anything in the open, or moving, could be seen.');
  if (attack.options.artillery) ds.push('Enemy artillery and mortars were on call: whatever was seen from his overwatch or drones could be shelled.');
  ds.push(
    'There is no school solution. Judge your siting by the ground and the enemy as they really were: what you could see and kill, ' +
      'what the enemy could see of you, where he could close unseen, and whether your sections could support each other.',
  );

  const why = [
    dil.slope ? `the widest views over the approaches are overlooked by the enemy's overwatch, while positions out of its view still see ${pct((dil.alt?.fof ?? 0) / Math.max(1, dil.best.fof))} as much` : '',
    dil.closeDead.length ? `${dil.closeDead.map((x) => x.name).join(' and ')} stay${dil.closeDead.length > 1 ? '' : 's'} in dead ground to within ${km(Math.max(0, Math.min(...dil.closeDead.map((x) => x.lastDeadM)) - frontageM / 2))} of the forward edge of your area` : '',
  ].filter(Boolean);
  const gate = why.length ? `Passed: ${why.join('; ')}.` : 'Weak: the ground offers no clear choice between exposure and fields of fire here.';

  const m = g.meta;
  const dataNote = `Ground: ${m.source}, about ${m.sourceResolutionM} m; the enemy's attack computed from it at ${attack.maskCellM} m. Check access on the ground before walking to any position.`;

  const scenario: PlatoonScenario = {
    problemType: 'defence',
    task, info,
    title: `${TASK_LABEL[task]}: 2 Platoon, B Company, ${bn.short}`,
    you, force, situation, bgType, friendlyForces, task_text, enemy, enemyGaps, time, ground, ownTroops, weather, questions,
    timeAllowed: '30 minutes for your plan; 10 minutes when the situation develops.',
    startMs: nowT.getTime(),
    phase2: { time: '', messages: [], questions: ['What do you conclude from these reports?', 'What do you now do? Give your orders.'] },
    ds,
    enemyMovesMs,
    objective: centre,
    markers,
    direct: null,
    covered: null,
    gate,
    dataNote,
  };
  return { scenario, attack };
}

/** For tests and the developer page: the cell of a point on the attack's grid. */
export const cellIn = (a: EnemyAttack, p: Point) => {
  const c = a.maskCellM;
  const col = Math.floor((p.x + (a.maskWidth * c) / 2) / c);
  const row = Math.floor(((a.maskHeight * c) / 2 - p.y) / c);
  return col >= 0 && row >= 0 && col < a.maskWidth && row < a.maskHeight ? row * a.maskWidth + col : -1;
};
