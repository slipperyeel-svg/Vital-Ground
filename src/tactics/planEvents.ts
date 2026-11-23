/**
 * "The situation develops" worked out from the user's own plan (PO, 15 Nov
 * 2026), instead of written in advance. The platoon is moved along the marked
 * route at 2 km/h from the time it moves off; the first one or two things that
 * would really happen on that route become the new situation:
 *
 * - an enemy outpost or fighting position that sees the platoon within its gun
 *   range opens fire (the report gives the platoon's position and roughly
 *   where the fire came from);
 * - mined ground entered on the route;
 * - if the enemy has drones and artillery: a long stretch in the enemy's view
 *   at longer range draws a drone and then artillery;
 * - if the route reaches its end unseen: an enemy platoon is seen moving (the
 *   depth platoon), so there is still a decision to make.
 *
 * A fire support position or OP the user marked reports what can really be
 * seen from it, including dummies that show no movement.
 *
 * Facts only, from the computed layout: nothing here decides what can be seen
 * except the line-of-sight calculation (core principle 1).
 */
import { bearingVector, distance, type Grid, type Point } from '../terrain/grid';
import { lineOfSight, type Obstacles } from '../terrain/viewshed';
import type { CompanyLayout, EnemyPosition } from './companyDefence';
import { POSTURES, SECTION_SCORING } from './sectionDefence';
import type { PlanInput } from './planFacts';

export const PLAN_EVENTS = {
  /** Tactical pace along the route (PO, 15 Nov 2026): 2 km/h. */
  paceKmh: 2,
  /** Time from the problem being set to the platoon moving off (the planning time allowed). */
  moveOffAfterMin: 30,
  /** Route sampling step, metres. */
  stepM: 10,
  /** Enemy fire reaches this far (machine gun). */
  fireRangeM: POSTURES.prepared.gunRangeM,
  /** Enemy observation (with drones and artillery) reaches this far. */
  observeRangeM: 1500,
  /** In view at longer range for this far before drones and artillery come. */
  exposedForFiresM: 300,
  /** A second event is reported only if it comes within this many minutes of the first. */
  secondWithinMin: 15,
  /** Mines found: the outline drawn around the find. */
  mineFindRadiusM: 60,
};

export interface DevelopedSituation {
  /** "0742. Your platoon moved off at 0712 by the route you marked." */
  time: string;
  messages: { time: string; from: string; text: string }[];
  /** New enemy to draw as suspected (or as a dummy, if shown to be one). */
  sightings: { point: Point; echelon: 'team' | 'section' | 'platoon'; label: string; dummy?: boolean }[];
  minefields: { outline: Point[]; label: string }[];
  /** Where the platoon is when the situation develops (the lead element). */
  reached: Point;
  /**
   * Where each element is when the situation develops (PO, 15 Nov 2026): halted
   * where something happened to it, otherwise as far along its route as 2 km/h
   * has taken it.
   */
  elements: { who: string; point: Point; state: 'in contact' | 'at mines' | 'under shellfire' | 'moving' | 'at the end of its route' | 'in position' }[];
  /** The time the positions are given for, e.g. "0749". */
  asAt: string;
}

type Ev = { atM: number; point: Point; apply: (msgTime: string) => void; kind?: 'fires'; /** The element it happens to: it halts there. */ who?: string; stop?: 'in contact' | 'at mines' | 'under shellfire' };

export function developFromPlan(
  grid: Grid,
  obstacles: Obstacles | null,
  L: CompanyLayout,
  plan: PlanInput,
  startMs: number,
  ref: (p: Point) => string,
  hhmm: (d: Date) => string,
): DevelopedSituation {
  const C = PLAN_EVENTS;
  const obs = obstacles ?? undefined;
  const eyeE = POSTURES.prepared.eyeM, showE = POSTURES.prepared.exposedM, ours = SECTION_SCORING.attackerHeightM;
  const mps = (C.paceKmh * 1000) / 3600;
  const moveOff = startMs + C.moveOffAfterMin * 60_000;
  const timeAt = (m: number) => new Date(moveOff + (m / mps) * 1000);
  const echelon: 'team' | 'section' = L.options.dispersed ? 'team' : 'section';
  const real: EnemyPosition[] = [...L.platoons.flatMap((p) => p.positions), ...(L.hq ? [L.hq] : [])];
  const fighting = real.filter((x) => x.kind !== 'hq');
  const maskCell = (p: Point) => {
    const c = L.maskCellM;
    const col = Math.floor((p.x + (L.maskWidth * c) / 2) / c);
    const row = Math.floor(((L.maskHeight * c) / 2 - p.y) / c);
    return col >= 0 && row >= 0 && col < L.maskWidth && row < L.maskHeight ? row * L.maskWidth + col : -1;
  };
  const sees = (e: EnemyPosition, p: Point, range: number) => distance(e.point, p) <= range && lineOfSight(grid, e.point, p, eyeE, ours, false, obs);

  // Sample each element's route.
  type Sample = { p: Point; m: number };
  const sampleRoute = (pts: Point[]): Sample[] => {
    const out: Sample[] = [];
    let run = 0;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const d = distance(a, b);
      const n = Math.max(1, Math.ceil(d / C.stepM));
      for (let s = k === 1 ? 0 : 1; s <= n; s++) out.push({ p: { x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n }, m: run + (d * s) / n });
      run += d;
    }
    return out;
  };
  const routes = plan.routes.filter((r) => r.points.length >= 2).map((r) => ({ who: r.who, samples: sampleRoute(r.points), points: r.points }));
  if (!routes.length) throw new Error('No route marked');

  const lastRoute = routes[routes.length - 1];
  const out: DevelopedSituation = { time: '', messages: [], sightings: [], minefields: [], reached: lastRoute.points[lastRoute.points.length - 1], elements: [], asAt: '' };
  const events: (Ev & { route: boolean })[] = [];

  for (const r of routes) {
    const samples = r.samples;
    // First fire from an enemy position (outposts first, as they are forward).
    for (const s of samples) {
      const i = maskCell(s.p);
      if (i < 0 || !L.killZone[i]) continue;
      const firing = fighting.filter((e) => sees(e, s.p, C.fireRangeM));
      if (!firing.length) continue;
      const outpost = firing.find((e) => e.kind === 'outpost');
      const shooter = outpost ?? [...firing].sort((a, b) => distance(a.point, s.p) - distance(b.point, s.p))[0];
      events.push({
        route: true, who: r.who, stop: 'in contact',
        atM: s.m,
        point: s.p,
        apply: (t) => {
          out.messages.push({
            time: t,
            from: r.who,
            text: outpost
              ? `At ${ref(s.p)}: under machine-gun fire from about ${ref(shooter.point)}, ${Math.round(distance(shooter.point, s.p) / 10) * 10} m away. Two or three men seen. We are in cover.`
              : `At ${ref(s.p)}: under heavy fire from about ${ref(shooter.point)}${firing.length > 1 ? `, and from at least one more position` : ''}. We are in cover; one man wounded.`,
          });
          out.sightings.push({ point: shooter.point, echelon: outpost ? 'team' : echelon, label: outpost ? 'MG' : '' });
          if (!outpost && firing.length > 1) out.sightings.push({ point: firing.find((e) => e !== shooter)!.point, echelon, label: '' });
        },
      });
      break;
    }

    // Mined ground on the route.
    if (L.mines) {
      const hit = samples.find((s) => {
        const i = maskCell(s.p);
        return i >= 0 && L.mines![i];
      });
      if (hit)
        events.push({
          route: true, who: r.who, stop: 'at mines',
          atM: hit.m,
          point: hit.p,
          apply: (t) => {
            out.messages.push({ time: t, from: r.who, text: `Anti-personnel mines found at ${ref(hit.p)}. One man slightly injured. We have stopped.` });
            const rr = C.mineFindRadiusM;
            out.minefields.push({
              outline: [0, 1, 2, 3].map((k) => ({ x: hit.p.x + rr * Math.cos((k * Math.PI) / 2 + Math.PI / 4), y: hit.p.y + rr * Math.sin((k * Math.PI) / 2 + Math.PI / 4) })),
              label: 'Mines found',
            });
          },
        });
    }

    // Drones and artillery: a long stretch in the enemy's view at longer range.
    if (L.options.isrFires) {
      let inView = 0;
      for (let k = 0; k < samples.length; k += 5) {
        const s = samples[k];
        const seen = real.some((e) => sees(e, s.p, C.observeRangeM));
        inView = seen ? inView + C.stepM * 5 : 0;
        if (inView >= C.exposedForFiresM) {
          events.push({
            route: true, who: r.who, stop: 'under shellfire',
            kind: 'fires',
            atM: s.m,
            point: s.p,
            apply: (t) => {
              const before = hhmm(new Date(timeAt(s.m).getTime() - 8 * 60_000));
              out.messages.push({ time: before, from: r.who, text: 'Enemy drone overhead, watching us.' });
              out.messages.push({ time: t, from: r.who, text: `Six rounds of enemy artillery landed close to us at ${ref(s.p)}. Two men wounded.` });
            },
          });
          break;
        }
      }
    }
  }

  // What the user's fire support position or OP can really see.
  const watch = plan.positions.find((m) => /fire support/i.test(m.kind)) ?? plan.positions.find((m) => /^OP/i.test(m.kind));
  if (watch) {
    const seenReal = fighting.filter((e) => distance(e.point, watch.point) <= C.observeRangeM && lineOfSight(grid, watch.point, e.point, ours, showE, false, obs));
    const seenDummy = L.dummies.filter((d) => distance(d.point, watch.point) <= C.observeRangeM && lineOfSight(grid, watch.point, d.point, ours, showE, false, obs));
    // Reached first by the element whose route passes nearest it: distance along its route, then across to it, at 2 km/h.
    const atM = Math.min(...routes.flatMap((r) => r.samples.map((x) => x.m + distance(x.p, watch.point))));
    events.push({
      route: false,
      atM,
      point: watch.point,
      apply: (t) => {
        const from = `${watch.label} at ${ref(watch.point)}`;
        if (seenReal.length) {
          const near = [...seenReal].sort((a, b) => distance(a.point, watch.point) - distance(b.point, watch.point)).slice(0, 2);
          out.messages.push({
            time: t,
            from,
            text: `In position. Enemy seen dug in at ${near.map((e) => ref(e.point)).join(' and ')}${seenReal.length > 2 ? `, and movement at ${seenReal.length - 2} more places` : ''}.`,
          });
          for (const e of near) out.sightings.push({ point: e.point, echelon, label: '' });
        } else if (seenDummy.length) {
          const d = seenDummy[0];
          out.messages.push({ time: t, from, text: `In position. Trenches at ${ref(d.point)}, but no movement there in 15 minutes.` });
          out.sightings.push({ point: d.point, echelon, label: '?' });
        } else {
          out.messages.push({ time: t, from, text: 'In position. No enemy seen from here.' });
        }
      },
    });
  }

  // Counter-attack (PO, 19 Nov 2026): if the enemy holds a mounted reserve back, it
  // counter-attacks when the first of your elements closes to within 150 m of the
  // enemy's forward line.
  const reserve = L.platoons.find((p) => p.role === 'reserve');
  if (reserve) {
    const adv = bearingVector(L.advanceBearingDeg);
    const fwdOf = (p: Point) => p.x * adv.x + p.y * adv.y;
    const front = Math.min(...L.platoons.filter((p) => p.role === 'forward').flatMap((p) => p.positions.filter((x) => x.kind !== 'outpost').map((x) => fwdOf(x.point))));
    let first: { r: (typeof routes)[number]; s: Sample } | null = null;
    for (const r of routes) {
      const hit = r.samples.find((x) => fwdOf(x.p) >= front - 150);
      if (hit && (!first || hit.m < first.s.m)) first = { r, s: hit };
    }
    if (first) {
      const { r, s } = first;
      events.push({
        route: true, who: r.who, stop: 'in contact',
        atM: s.m,
        point: s.p,
        apply: (t) => {
          out.messages.push({
            time: t,
            from: 'Company HQ',
            text: `Enemy counter-attack: about a platoon in three BMPs moving fast from about ${ref(reserve.centre)} towards ${r.who} at ${ref(s.p)}. Engage and report.`,
          });
          out.sightings.push({ point: reserve.centre, echelon: 'platoon', label: 'BMP' });
        },
      });
    }
  }

  // Drones and artillery come once, onto whichever element is seen first.
  const fires = events.filter((e) => e.kind === 'fires').sort((a, b) => a.atM - b.atM);
  for (const e of fires.slice(1)) events.splice(events.indexOf(e), 1);

  // Nothing happened on any route: the enemy reacts instead.
  if (!events.some((e) => e.route)) {
    const depth = L.platoons.find((p) => p.role === 'reserve') ?? L.platoons.find((p) => p.role === 'depth');
    const lead = routes.reduce((a, b) => (a.samples[a.samples.length - 1].m >= b.samples[b.samples.length - 1].m ? a : b));
    const endM = lead.samples[lead.samples.length - 1].m;
    const end = lead.points[lead.points.length - 1];
    events.push({
      route: true,
      atM: endM,
      point: end,
      apply: (t) => {
        out.messages.push({ time: t, from: lead.who, text: `At ${ref(end)}, not fired on. No enemy seen close.` });
        if (depth) {
          out.messages.push({
            time: hhmm(new Date(timeAt(endM).getTime() + 4 * 60_000)),
            from: 'Company HQ',
            text: `About 20 enemy seen moving from ${ref(depth.centre)} towards you. 1 Platoon is in contact on your flank.`,
          });
          out.sightings.push({ point: depth.centre, echelon: 'platoon', label: '' });
        }
      },
    });
  }

  // The first event, and a second if it follows soon after.
  events.sort((a, b) => a.atM - b.atM);
  const firstRoute = events.find((e) => e.route) ?? events[0];
  const chosen = [firstRoute];
  const second = events.find((e) => e !== firstRoute && (e.atM - firstRoute.atM) / mps / 60 <= C.secondWithinMin && e.atM >= 0);
  if (second) chosen.push(second);
  for (const e of chosen) e.apply(hhmm(timeAt(e.atM)));
  out.messages.sort((a, b) => a.time.localeCompare(b.time));

  // Where the lead element is: the furthest point reached on the route by the first route event.
  out.reached = firstRoute.point;
  const nowM = Math.max(...chosen.map((e) => e.atM));
  const nowT = timeAt(nowM);
  out.time = `${hhmm(nowT)}. Your platoon moved off at ${hhmm(new Date(moveOff))} by the routes you marked.`;

  // Where each element is now: halted where a reported event struck it, else
  // as far along its route as the time allows (all moved off together at 2 km/h).
  out.asAt = hhmm(nowT);
  for (const r of routes) {
    // The latest thing that happened to it: where it is now (it may have gone on after being shelled).
    const hit = chosen.filter((e) => e.who === r.who && e.stop && e.atM <= nowM).sort((a, b) => b.atM - a.atM)[0];
    if (hit) {
      out.elements.push({ who: r.who, point: hit.point, state: hit.stop ?? 'in contact' });
      continue;
    }
    const end = r.samples[r.samples.length - 1];
    const at = r.samples.find((x) => x.m >= nowM) ?? end;
    out.elements.push({ who: r.who, point: at.p, state: at === end && end.m <= nowM ? 'at the end of its route' : 'moving' });
  }
  return out;
}
