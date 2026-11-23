/**
 * Defence: the situation develops from where the user sited the platoon (PO,
 * 23 Nov 2026), and the computed facts about that siting. The counterpart of
 * planEvents.ts and planFacts.ts for the attack.
 *
 * The enemy's assault groups leave their assembly area at the time set by the
 * problem and walk their axes (2.5 km/h; BMPs 12 km/h). What happens is worked
 * out from line of sight on the ground, never guessed:
 * - drones (if the enemy has them) find positions in the open, not in woods;
 * - artillery (if he has it) then falls on a position the drones found, or one
 *   his overwatch can see;
 * - the OP reports the enemy first if it can see him (out to 1.5 km);
 * - a section opens fire when an assault group comes into its view within its
 *   gun range (600 m), or an obstacle the user placed holds them where a
 *   section can see;
 * - an assault group that reaches within 120 m of a section unseen attacks it
 *   at close range out of the dead ground.
 * The first contact becomes the new situation, with the event just before it.
 */
import { distance, pointToCell, type Grid, type Point } from '../terrain/grid';
import { lineOfSight, type Obstacles } from '../terrain/viewshed';
import { ATTACK, type EnemyAttack } from './enemyAttack';
import type { DevelopedSituation } from './planEvents';
import type { PlanFacts, PlanInput } from './planFacts';

export const DEFENCE_EVENTS = {
  /** Observation from the OP; sections open fire within gun range. */
  opRangeM: 1500,
  fireRangeM: 600,
  /** Unseen to within this of a section: a close assault. */
  closeAssaultM: 120,
  /** The enemy is held at an obstacle placed within this of his axis. */
  obstacleOnAxisM: 75,
  /** A killing area takes in an axis passing within this of its centre. */
  killingAreaM: 150,
  /** Drones are over the position this long before the enemy moves; artillery this long before. */
  droneBeforeMin: 40,
  artilleryBeforeMin: 15,
  /** The event shown with the first contact, if it came within this many minutes before it. */
  withinMin: 40,
};

const isSection = (k: string) => /^\d Sect$/.test(k);
const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

export function developDefence(
  grid: Grid,
  obstacles: Obstacles | null,
  A: EnemyAttack,
  plan: PlanInput,
  enemyMovesMs: number,
  ref: (p: Point) => string,
  hhmm: (d: Date) => string,
): DevelopedSituation {
  const C = DEFENCE_EVENTS;
  const obs = obstacles ?? undefined;
  const sections = plan.positions.filter((m) => isSection(m.kind));
  if (!sections.length) throw new Error('No section positions marked');
  const posts = plan.positions.filter((m) => isSection(m.kind) || m.kind === 'Pl HQ');
  const op = plan.positions.find((m) => m.kind === 'OP');
  const obstaclesMarked = plan.positions.filter((m) => m.kind === 'Obstacle');
  const killing = plan.positions.find((m) => m.kind === 'Killing area');
  const inWood = (p: Point) => {
    if (!obs) return false;
    const c = pointToCell(grid, p);
    return c.col >= 0 && c.row >= 0 && c.col < grid.width && c.row < grid.height && obs.wood[c.row * grid.width + c.col] === 1;
  };
  const sees = (from: Point, to: Point, range: number) => distance(from, to) <= range && lineOfSight(grid, from, to, ATTACK.ourEyeM, ATTACK.attackerM, false, obs);
  const overwatchSees = (p: Point) => A.overwatch.find((o) => lineOfSight(grid, o.point, p, ATTACK.overwatchEyeM, ATTACK.positionShowsM, false, obs));

  type Ev = { t: number; contact: boolean; who?: string; state?: 'in contact' | 'under shellfire'; apply: () => void };
  const events: Ev[] = [];
  const out: DevelopedSituation = { time: '', messages: [], sightings: [], minefields: [], reached: sections[0].point, elements: [], asAt: '' };
  const say = (t: number, from: string, text: string) => out.messages.push({ time: hhmm(new Date(t)), from, text });

  // Drones, then artillery, before the assault.
  const spotted = A.options.drones ? posts.filter((m) => !inWood(m.point)) : [];
  if (A.options.drones) {
    const t = enemyMovesMs - C.droneBeforeMin * 60_000;
    events.push({
      t, contact: false,
      apply: () => say(t, 'Platoon HQ', spotted.length ? `Enemy drone circling over the position for about ten minutes, low over ${spotted[0].label}.` : 'Enemy drone heard overhead for about ten minutes; it did not stay over any of our positions.'),
    });
  }
  if (A.options.artillery) {
    const target = spotted[0] ?? posts.find((m) => overwatchSees(m.point));
    if (target) {
      const t = enemyMovesMs - C.artilleryBeforeMin * 60_000;
      events.push({ t, contact: false, who: target.label, state: 'under shellfire', apply: () => say(t, target.label, `About twenty rounds of artillery on our position at ${ref(target.point)}. Two men wounded.`) });
    }
  }

  // Each assault group along its axis.
  for (const ax of A.axes) {
    const kmh = ax.kind === 'mounted' ? ATTACK.mountedKmh : ATTACK.footKmh;
    const mps = (kmh * 1000) / 3600;
    let run = 0;
    let seenBySection = false, reportedByOp = false;
    const what = ax.kind === 'mounted' ? 'two or three BMPs' : ax.kind === 'infiltration' ? 'four or five enemy on foot' : 'about ten enemy on foot';
    const echelon: 'team' | 'section' = ax.kind === 'infiltration' ? 'team' : 'section';
    for (let k = 1; k < ax.path.length && !seenBySection; k++) {
      const p = ax.path[k];
      run += distance(ax.path[k - 1], p);
      const t = enemyMovesMs + (run / mps) * 1000;
      // An obstacle on the axis holds them there.
      const held = obstaclesMarked.find((o) => distance(o.point, p) <= C.obstacleOnAxisM);
      if (op && !reportedByOp && sees(op.point, p, C.opRangeM)) {
        reportedByOp = true;
        const d = distance(op.point, p);
        events.push({ t, contact: false, apply: () => { say(t, op.label, `${what[0].toUpperCase() + what.slice(1)} moving towards us at ${ref(p)}, ${metres(d)} from the OP.`); out.sightings.push({ point: p, echelon, label: '' }); } });
      }
      const firer = sections.find((s) => sees(s.point, p, C.fireRangeM));
      if (firer) {
        seenBySection = true;
        const d = distance(firer.point, p);
        const inKA = killing && distance(killing.point, p) <= C.killingAreaM * 2;
        const heldWord = held ? `, held at our obstacle at ${ref(held.point)}` : '';
        events.push({
          t, contact: true, who: firer.label, state: 'in contact',
          apply: () => {
            say(t, firer.label, `${what[0].toUpperCase() + what.slice(1)} at ${ref(p)}, ${metres(d)} away${heldWord}${inKA ? ', in our killing area' : ''}. Engaging.`);
            out.sightings.push({ point: p, echelon, label: ax.kind === 'mounted' ? 'BMP' : '' });
          },
        });
        break;
      }
      const near = sections.find((s) => distance(s.point, p) <= C.closeAssaultM);
      if (near) {
        seenBySection = true;
        events.push({
          t, contact: true, who: near.label, state: 'in contact',
          apply: () => {
            say(t, near.label, `Attacked at close range from ${ref(p)}, out of dead ground: grenades and rifle fire. In close combat.`);
            out.sightings.push({ point: p, echelon, label: '' });
          },
        });
        break;
      }
      if (distance(p, A.centre) <= A.frontageM / 4) {
        // Into the middle of the area without being seen by any section.
        seenBySection = true;
        events.push({
          t, contact: true,
          apply: () => {
            say(t, 'Platoon HQ', `Enemy among our positions at ${ref(p)}: ${what} got in without any section being able to engage them. Platoon HQ engaging.`);
            out.sightings.push({ point: p, echelon, label: '' });
          },
        });
        break;
      }
    }
  }
  // Fire from the overwatch, once the assault is under way.
  for (const o of A.overwatch) {
    const target = posts.find((m) => lineOfSight(grid, o.point, m.point, ATTACK.overwatchEyeM, ATTACK.positionShowsM, false, obs));
    if (!target) continue;
    const t = enemyMovesMs + 20 * 60_000;
    events.push({
      t, contact: false, who: target.label, state: 'in contact',
      apply: () => {
        say(t, target.label, `Under fire from ${A.options.mounted ? 'BMPs' : 'machine guns and an anti-tank missile'} at about ${ref(o.point)}, ${metres(distance(o.point, target.point))} away. We cannot reach them.`);
        out.sightings.push({ point: o.point, echelon: 'section', label: A.options.mounted ? 'BMP' : '' });
      },
    });
    break;
  }

  events.sort((a, b) => a.t - b.t);
  const first = events.find((e) => e.contact) ?? events[events.length - 1];
  if (!first) throw new Error('Nothing happens');
  const before = events.filter((e) => e !== first && e.t <= first.t && first.t - e.t <= C.withinMin * 60_000).pop();
  const chosen = before ? [before, first] : [first];
  for (const e of chosen) e.apply();
  out.messages.sort((a, b) => a.time.localeCompare(b.time));
  const nowT = new Date(first.t);
  out.time = `${hhmm(nowT)}. Your platoon is in position as you sited it.`;
  out.asAt = hhmm(nowT);
  for (const m of posts) {
    const hit = chosen.filter((e) => e.who === m.label).pop();
    out.elements.push({ who: m.label, point: m.point, state: hit?.state ?? 'in position' });
  }
  out.reached = sections[0].point;
  return out;
}

/** Facts about the user's siting against the enemy's real attack (no verdict). */
export function defenceFacts(grid: Grid, obstacles: Obstacles | null, A: EnemyAttack, plan: PlanInput, ref: (p: Point) => string): PlanFacts {
  const C = DEFENCE_EVENTS;
  const obs = obstacles ?? undefined;
  const sections = plan.positions.filter((m) => isSection(m.kind));
  const inWood = (p: Point) => {
    if (!obs) return false;
    const c = pointToCell(grid, p);
    return c.col >= 0 && c.row >= 0 && c.col < grid.width && c.row < grid.height && obs.wood[c.row * grid.width + c.col] === 1;
  };
  const toward = (p: Point, m: number): Point => {
    const d = distance(p, A.assembly) || 1;
    return { x: p.x + ((A.assembly.x - p.x) / d) * m, y: p.y + ((A.assembly.y - p.y) / d) * m };
  };
  const positions = plan.positions.map((m) => {
    const facts: string[] = [];
    if (isSection(m.kind) || m.kind === 'Pl HQ' || m.kind === 'OP') {
      const range = m.kind === 'OP' ? C.opRangeM : C.fireRangeM;
      const per: string[] = [];
      for (const ax of A.axes) {
        let len = 0;
        for (let k = 1; k < ax.path.length; k++) {
          const q = ax.path[k];
          if (distance(m.point, q) > range) continue;
          if (lineOfSight(grid, m.point, q, ATTACK.ourEyeM, ATTACK.attackerM, false, obs)) {
            len += distance(ax.path[k - 1], q);
          }
        }
        if (len > 0) per.push(`${ax.name} ${metres(len)}`);
      }
      facts.push(per.length ? `Within ${metres(range)} it saw: ${per.join('; ')}.` : `It saw none of the enemy's approaches within ${metres(range)}.`);
      const seenBy = A.overwatch.filter((o) => lineOfSight(grid, o.point, m.point, ATTACK.overwatchEyeM, ATTACK.positionShowsM, false, obs));
      facts.push(seenBy.length ? `Seen from the enemy's overwatch: ${seenBy.map((o) => `${o.label} at ${ref(o.point)} (${metres(distance(o.point, m.point))})`).join('; ')}.` : "Out of sight of the enemy's overwatch.");
      if (A.options.drones) facts.push(inWood(m.point) ? 'In woods: hidden from drones.' : 'In the open: visible to drones.');
      // The closest an approach came to it without being seen from it.
      let close = Infinity, where: Point | null = null, which = '';
      for (const ax of A.axes)
        for (const q of ax.path) {
          const d = distance(m.point, q);
          if (d < close && d <= C.fireRangeM && !lineOfSight(grid, m.point, q, ATTACK.ourEyeM, ATTACK.attackerM, false, obs)) [close, where, which] = [d, q, ax.name];
        }
      if (where) facts.push(`${which} came within ${metres(close)} of it unseen from it, at ${ref(where)}.`);
      if (isSection(m.kind)) {
        // Mutual support: which other sections can see the ground 100 m in front of it.
        const front = toward(m.point, 100);
        const support = sections.filter((s) => s !== m && lineOfSight(grid, s.point, front, ATTACK.ourEyeM, ATTACK.attackerM, false, obs)).map((s) => s.label);
        facts.push(support.length ? `The ground 100 m in front of it could be covered by: ${support.join(', ')}.` : 'No other section could see the ground 100 m in front of it.');
      }
    } else if (m.kind === 'Killing area') {
      const through = A.axes.filter((ax) => ax.path.some((q) => distance(q, m.point) <= C.killingAreaM)).map((ax) => ax.name);
      facts.push(through.length ? `Enemy axes through it: ${through.join(', ')}.` : 'No enemy axis passed through it.');
      const by = sections.filter((s) => distance(s.point, m.point) <= C.fireRangeM && lineOfSight(grid, s.point, m.point, ATTACK.ourEyeM, ATTACK.attackerM, false, obs)).map((s) => s.label);
      facts.push(by.length ? `Seen and in range from: ${by.join(', ')}.` : 'No section could see it within 600 m.');
    } else if (m.kind === 'Obstacle') {
      const on = A.axes.filter((ax) => ax.path.some((q) => distance(q, m.point) <= C.obstacleOnAxisM)).map((ax) => ax.name);
      facts.push(on.length ? `It lay across ${on.join(', ')}.` : 'No enemy axis crossed it.');
      const by = sections.filter((s) => distance(s.point, m.point) <= C.fireRangeM && lineOfSight(grid, s.point, m.point, ATTACK.ourEyeM, ATTACK.attackerM, false, obs)).map((s) => s.label);
      facts.push(by.length ? `Covered by fire from: ${by.join(', ')}.` : 'No section could see it: an obstacle not covered by fire.');
    }
    return { label: `${m.label} (${ref(m.point)})`, facts };
  });
  return { route: [], positions };
}
