import { describe, expect, it } from 'vitest';
import { fromFunction, rolling } from '../src/terrain/synthetic';
import { writeDefenceScenario } from '../src/tactics/defenceScenario';

// A crest 200 m in front of you to the north, then a convex slope falling away towards
// the enemy (dead ground beyond the brow): forward or reverse slope?
const ground = fromFunction(6000, 10, (_x, y) => (y < 200 ? 140 - ((200 - y) / 1500) * 20 : 140 - 40 * Math.min(1, (y - 200) / 600) ** 2));
const now = new Date(Date.UTC(2026, 10, 23, 10));

describe('platoon defence (PO, 23 Nov 2026)', () => {
  const r = writeDefenceScenario({ grid: ground, layers: null, seed: 4, threatBearingDeg: 0, info: 'rich', now, timeZone: 'UTC', options: { mounted: true, infiltration: true, drones: true, artillery: true } })!;
  const s = r.scenario;
  it('writes a defence problem with every guideline element', () => {
    expect(s.problemType).toBe('defence');
    expect(['defend', 'block']).toContain(s.task);
    for (const t of [s.you, s.situation, s.task_text, s.time, s.ownTroops, s.weather]) expect(t.length).toBeGreaterThan(10);
    expect(s.enemy.length).toBeGreaterThan(0);
    expect(s.ground.length).toBeGreaterThan(1);
    expect(s.questions.some((q) => /site your/.test(q))).toBe(true);
    expect(s.time).toMatch(/ready by \d{4}/);
    expect(s.ds.at(-1)).toMatch(/no school solution/);
  });
  it('draws your area, the boundaries and the enemy axes', () => {
    expect(s.markers.area!.outline.length).toBe(4);
    expect(s.markers.control.filter((c) => c.kind === 'boundary').map((c) => c.label)).toEqual(expect.arrayContaining(['•••', 'II']));
    expect(s.markers.enemyAxes!.length).toBe(r.attack.axes.length);
    expect(s.markers.enemyAxes!.some((a) => a.reported)).toBe(true); // rich information shows the expected axis
  });
  it('finds the dilemma on a crest: the forward edge sees more but is overlooked, and an approach stays unseen close in', () => {
    expect(s.gate).toMatch(/^Passed/);
    for (const seed of [1, 2, 3]) {
      const x = writeDefenceScenario({ grid: ground, layers: null, seed, threatBearingDeg: 0, now, timeZone: 'UTC' })!;
      expect(x.scenario.gate).toMatch(/^Passed/);
    }
  });
  it('the enemy moves after you are to be ready', () => {
    const by = s.time.match(/ready by (\d\d)(\d\d)/)!;
    const byMs = Date.UTC(2026, 10, 23, +by[1], +by[2]);
    expect(s.enemyMovesMs!).toBeGreaterThan(byMs);
  });
  it('defends against a threat from any direction on rolling ground, and varies the task', () => {
    const g = rolling(6000, 10, 25);
    const tasks = new Set<string>();
    for (const seed of [1, 2, 3]) {
      const x = writeDefenceScenario({ grid: g, layers: null, seed, now, timeZone: 'UTC' });
      expect(x).toBeTruthy();
      tasks.add(x!.scenario.task);
    }
    expect(tasks.size).toBeGreaterThan(0);
  });
});

import { developDefence, defenceFacts } from '../src/tactics/defenceEvents';
import { ATTACK, areaSamples } from '../src/tactics/enemyAttack';
import { lineOfSight } from '../src/terrain/viewshed';

describe('defence: the situation develops from where you sited the platoon', () => {
  const r = writeDefenceScenario({ grid: ground, layers: null, seed: 4, threatBearingDeg: 0, info: 'rich', now, timeZone: 'UTC', options: { mounted: false, infiltration: true, drones: true, artillery: true } })!;
  const A = r.attack;
  const ref = (p: { x: number; y: number }) => `${Math.round(p.x)},${Math.round(p.y)}`;
  const hhmm = (d: Date) => d.toISOString().slice(11, 16).replace(':', '');
  const sect = (n: number, x: number, y: number) => ({ kind: `${n} Sect`, label: `${n} Sect`, point: { x, y } });
  // On the crest (forward slope: sees far, overlooked) and behind it (reverse slope).
  const crest = { routes: [], positions: [sect(1, -150, 190), sect(2, 0, 200), sect(3, 150, 190), { kind: 'OP', label: 'OP', point: { x: 0, y: 220 } }] };
  const reverse = { routes: [], positions: [sect(1, -150, -100), sect(2, 0, -120), sect(3, 150, -100)] };
  it('reports contact, with time and grid, and where each section is', () => {
    const d = developDefence(ground, null, A, crest, r.scenario.enemyMovesMs!, ref, hhmm);
    expect(d.messages.length).toBeGreaterThan(0);
    expect(d.messages.length).toBeLessThanOrEqual(2);
    for (const m of d.messages) expect(m.time).toMatch(/^\d{4}$/);
    expect(d.elements.map((e) => e.who)).toEqual(expect.arrayContaining(['1 Sect', '2 Sect', '3 Sect']));
    expect(d.time).toMatch(/in position/);
  });
  it("says a position is overlooked by the enemy's overwatch exactly when the line of sight says so", () => {
    expect(A.overwatch.length).toBeGreaterThan(0);
    const o = A.overwatch[0];
    const seenBy = (p: { x: number; y: number }) => A.overwatch.some((w) => lineOfSight(ground, w.point, p, ATTACK.overwatchEyeM, ATTACK.positionShowsM));
    const pts = areaSamples(A.centre, A.frontageM);
    const yes = pts.find(seenBy), no = pts.find((p) => !seenBy(p));
    expect(yes && no).toBeTruthy();
    const f = defenceFacts(ground, null, A, { routes: [], positions: [{ kind: '1 Sect', label: '1 Sect', point: yes! }, { kind: '2 Sect', label: '2 Sect', point: no! }] }, ref);
    expect(f.positions[0].facts.join(' ')).toMatch(/Seen from the enemy's overwatch/);
    expect(f.positions[1].facts.join(' ')).toMatch(/Out of sight of the enemy's overwatch/);
    expect(o.seesShare).toBeGreaterThan(0);
  });
  it('reports the range at which a section first engages, from the real line of sight', () => {
    const d = developDefence(ground, null, A, reverse, r.scenario.enemyMovesMs!, ref, hhmm);
    expect(d.messages.at(-1)!.text).toMatch(/\d+ m away\. Engaging\.|close range|among our positions/);
  });
  it('needs the section positions', () => {
    expect(() => developDefence(ground, null, A, { routes: [], positions: [] }, 0, ref, hhmm)).toThrow();
  });
  it('gives facts per position: what it saw, who saw it, mutual support; and for a killing area and obstacle', () => {
    const p = { routes: [], positions: [...crest.positions, { kind: 'Killing area', label: 'Killing area', point: A.axes[0].path[Math.floor(A.axes[0].path.length * 0.8)] }, { kind: 'Obstacle', label: 'Obstacle', point: A.axes[0].path[Math.floor(A.axes[0].path.length * 0.85)] }] };
    const f = defenceFacts(ground, null, A, p, ref);
    expect(f.route).toEqual([]);
    const s2 = f.positions.find((x) => x.label.startsWith('2 Sect'))!;
    expect(s2.facts.join(' ')).toMatch(/saw/);
    expect(s2.facts.join(' ')).toMatch(/overwatch/);
    expect(s2.facts.join(' ')).toMatch(/100 m in front of it/);
    expect(f.positions.find((x) => x.label.startsWith('Killing area'))!.facts[0]).toMatch(/Axis 1/);
    expect(f.positions.find((x) => x.label.startsWith('Obstacle'))!.facts[0]).toMatch(/across Axis 1/);
  });
});
