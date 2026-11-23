import { describe, expect, it } from 'vitest';
import { straightRidge } from '../src/terrain/synthetic';
import { placeEnemyCompany } from '../src/tactics/companyDefence';
import { writePlatoonScenario, type TaskType } from '../src/tactics/platoonScenario';

const ground = straightRidge(4000, 10, { ridgeY: 1000, heightM: 40, halfWidthM: 900, base: 100 });
for (let i = 0; i < ground.data.length; i++) ground.data[i] += 4 * Math.sin((i % ground.width) / 25);
ground.meta = { ...ground.meta, centre: { lat: 51.25, lon: -1.9 } };
const layout = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: true, dummies: true, dispersed: false, droneConcealment: false, isrFires: true } })!;
const now = new Date(Date.UTC(2026, 10, 15, 12));

describe('platoon scenario (Moltke guidelines G1–G13)', () => {
  it('contains every guideline element', () => {
    const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 3, now, timeZone: 'Europe/London' });
    expect(s.you).toMatch(/You command 2 Platoon/); // G2
    expect(s.force.length).toBeGreaterThanOrEqual(3); // G3
    expect(s.situation).toMatch(/advancing on 0000 mils|advancing on 6390 mils|advancing on 0010 mils/); // G4: grid bearing in mils
    expect(s.task_text.length).toBeGreaterThan(20);
    expect(s.enemy.length).toBeGreaterThan(0); // G5
    for (const e of s.enemy) expect(e.source.length).toBeGreaterThan(3);
    expect(s.enemyGaps.length).toBeGreaterThan(10);
    expect(s.time).toMatch(/Time now \d{4}/); // G6
    expect(s.ground.length).toBeGreaterThan(0); // G7
    expect(s.ownTroops).toMatch(/1 Platoon/); // G8
    expect(s.weather.length).toBeGreaterThan(5); // G9
    expect(s.questions.length).toBeGreaterThanOrEqual(2); // G10
    expect(s.questions.length).toBeLessThanOrEqual(3);
    expect(s.phase2.messages.length).toBeGreaterThan(0); // G11
    expect(s.ds.join(' ')).toMatch(/no school solution/); // G13
    expect(s.ds.join(' ')).not.toMatch(/best covered route|quality gate/i); // never shown as an answer
    // G1: the visible problem is short.
    const words = [s.you, s.situation, s.task_text, ...s.enemy.map((e) => e.text), s.enemyGaps, s.time, ...s.ground, s.ownTroops, s.weather, ...s.questions]
      .join(' ').split(/\s+/).length;
    expect(words).toBeLessThan(400);
  });

  it('writes each task type', () => {
    for (const task of ['secure', 'neutralise', 'findFix', 'screen'] as TaskType[]) {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 5, task, info: 'partial', now, timeZone: 'Europe/London' });
      expect(s.task).toBe(task);
      expect(s.direct).not.toBeNull();
      expect(s.covered).not.toBeNull();
      expect(s.gate).toMatch(/^(Passed|Weak)/);
    }
  });

  it('gives more, and more reliable, information at richer levels', () => {
    const rich = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 9, info: 'rich', now });
    const poor = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 9, info: 'poor', now });
    expect(rich.enemy.length).toBeGreaterThan(poor.enemy.length);
    expect(rich.enemy.some((e) => e.reliability === 'good')).toBe(true);
    // Poor information asks the user to find the enemy first.
    expect(poor.questions[0]).toMatch(/Where do you expect the enemy/);
  });

  it('keeps the covered route out of fire better than the obvious one', () => {
    const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 2, task: 'secure', now });
    expect(s.covered!.underFire).toBeLessThanOrEqual(s.direct!.underFire + 1e-9);
  });
});

describe('time and light (PO, 15 Nov 2026)', () => {
  const at = (h: number, m: number) =>
    writePlatoonScenario({ grid: ground, layers: null, layout, seed: 3, now: new Date(Date.UTC(2026, 10, 15, h, m)), timeZone: 'Europe/London' }).time;
  it('uses the time given, and rounds "complete by" to the nearest ten minutes', () => {
    expect(at(10, 7)).toMatch(/Time now 1007\./);
    expect(at(10, 7)).toMatch(/complete by \d\d\d0\./);
  });
  it('describes the light for the time of day', () => {
    // Mid-November on Salisbury Plain: first light about 0650, sunrise about 0725, sunset about 1615.
    expect(at(6, 21)).toMatch(/It is dark\. First light 06\d\d, sunrise 07\d\d\./);
    expect(at(10, 7)).toMatch(/Sunset 16\d\d, last light 16\d\d: about \d+ hours?( \d+ minutes)? of light remains?\./);
    expect(at(20, 0)).toMatch(/It is dark: last light was 16\d\d\. First light tomorrow 06\d\d/);
    expect(at(16, 30)).toMatch(/Sunset was 16\d\d, last light 16\d\d: about \d+ minutes of light remain\./);
  });
});

describe('objectives and boundaries (PO, 15 Nov 2026)', () => {
  it('names your objective as well as the battlegroup objective', () => {
    const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 3, task: 'secure', info: 'partial', now, timeZone: 'Europe/London' });
    expect(s.markers.task.code).toMatch(/^OBJ [A-Z]+$/);
    expect(s.markers.task.code).not.toBe(s.markers.bgObjective.name);
    expect(s.task_text).toContain(s.markers.task.code!);
  });
  it('draws a platoon boundary with 1 Pl and the battlegroup boundary, and the B/A company boundary when it lies on the map', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed, now, timeZone: 'Europe/London' });
      const b = s.markers.control.filter((c) => c.kind === 'boundary').map((c) => c.label);
      expect(b).toContain('•••');
      expect(b).toContain('II');
      if (b.includes('I')) seen.add('I');
      else expect(s.friendlyForces.map((f) => f.detail).join(' ')).toContain('B/A boundary lies beyond the edge of this map');
    }
    expect(seen.has('I')).toBe(true);
  });
  it('draws the battlegroup boundary beyond A Coy, with the battlegroup on that flank, when it lies on the map (PO, 23 Nov 2026)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed, now, timeZone: 'Europe/London' });
      const flanks = s.friendlyForces.find((f) => f.element === 'Flanks')!.detail;
      const m = flanks.match(/Beyond A Coy is the battlegroup boundary with (1 [A-Z ]+?) BG/)!;
      expect(m).toBeTruthy();
      const far = s.markers.control.filter((c) => c.label === 'II' && c.sides!.includes(m[1]));
      if (far.length) {
        expect(far[0].sides).toContain('1 SR');
      } else expect(flanks).toContain('beyond the edge of this map');
      // Never the same battalion on both flanks.
      const near = s.markers.control.filter((c) => c.label === 'II').map((c) => c.sides!.find((x) => x !== '1 SR'));
      expect(new Set(near).size).toBe(near.length);
    }
  });
  it('platoon frontages vary within 800–1,500 m (light role) and 1,500–3,000 m (mechanised) (PO, 20 Nov 2026)', () => {
    const got: Record<string, Set<number>> = { light: new Set(), mechanised: new Set() };
    for (let seed = 1; seed <= 40; seed++) {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed, task: 'secure', lane: 'most', now, timeZone: 'UTC' });
      const m = s.friendlyForces.map((f) => f.detail).join(' ').match(/Platoon frontage is about ([\d.]+) (km|m)/)!;
      const metres = m[2] === 'km' ? +m[1] * 1000 : +m[1];
      const [lo, hi] = s.bgType === 'light' ? [800, 1500] : [1500, 3000];
      expect(metres).toBeGreaterThanOrEqual(lo);
      expect(metres).toBeLessThanOrEqual(hi);
      got[s.bgType].add(metres);
    }
    expect(got.light.size).toBeGreaterThan(2);
    expect(got.mechanised.size).toBeGreaterThan(2);
  });
});

describe('time allowed varies (PO, 15 Nov 2026)', () => {
  it('gives different completion times for different problems, always to ten minutes and within 45 minutes to 6 hours', () => {
    const t0 = Date.UTC(2026, 10, 15, 10, 7);
    const mins = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed, now: new Date(t0), timeZone: 'UTC' });
      const m = s.time.match(/complete by (\d\d)(\d\d)\./)!;
      const by = Date.UTC(2026, 10, 15, +m[1], +m[2]);
      const allowed = (by - t0) / 60_000;
      expect(+m[2] % 10).toBe(0);
      expect(allowed).toBeGreaterThanOrEqual(40);
      expect(allowed).toBeLessThanOrEqual(365);
      mins.add(allowed);
    }
    expect(mins.size).toBeGreaterThan(2);
  });
});

describe('how much of your enemy lies inside your boundaries (PO, 15 and 20 Nov 2026)', () => {
  const u = { x: Math.sin((layout.advanceBearingDeg * Math.PI) / 180), y: Math.cos((layout.advanceBearingDeg * Math.PI) / 180) };
  const v = { x: u.y, y: -u.x };
  const fwd = (p: { x: number; y: number }) => p.x * u.x + p.y * u.y;
  const lat = (p: { x: number; y: number }) => p.x * v.x + p.y * v.y;
  /** The lateral position of a boundary line at a given distance forward. */
  const latAt = (path: { x: number; y: number }[], f: number) => {
    let best = path[0];
    for (const q of path) if (Math.abs(fwd(q) - f) < Math.abs(fwd(best) - f)) best = q;
    return lat(best);
  };
  const insideShare = (s: ReturnType<typeof writePlatoonScenario>) => {
    const pl = s.markers.control.find((c) => c.label === '•••')!.path;
    const bg = s.markers.control.find((c) => c.label === 'II')!.path;
    return layout.platoons
      .filter((p) => p.role === 'forward')
      .map((p) => {
        const inside = p.positions.filter((x) => {
          const a = latAt(pl, fwd(x.point)), b = latAt(bg, fwd(x.point));
          return lat(x.point) >= Math.min(a, b) && lat(x.point) <= Math.max(a, b);
        });
        return inside.length / p.positions.length;
      });
  };
  for (const task of ['secure', 'neutralise', 'findFix'] as TaskType[]) {
    it(`${task}, "most of it": at least 60% of one forward enemy platoon is in your lane`, () => {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 7, task, info: 'rich', lane: 'most', now, timeZone: 'UTC' });
      expect(Math.max(...insideShare(s))).toBeGreaterThanOrEqual(0.6);
    });
    it(`${task}, "all of it": every position of one forward enemy platoon is in your lane`, () => {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 7, task, info: 'rich', lane: 'whole', now, timeZone: 'UTC' });
      expect(Math.max(...insideShare(s))).toBe(1);
      expect(s.ds.join(' ')).toMatch(/took in all \d+ of/);
    });
    it(`${task}, "only part of it": a boundary cuts the enemy platoon you are tasked against`, () => {
      for (const seed of [7, 8, 9]) {
        const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed, task, info: 'rich', lane: 'part', now, timeZone: 'UTC' });
        const note = s.ds.find((d) => /Your boundaries took in/.test(d))!;
        const [, nIn, n] = note.match(/took in (\d+) of .*'s (\d+) positions/)!;
        expect(+nIn).toBeGreaterThan(0);
        expect(+nIn).toBeLessThan(+n);
        expect(+nIn / +n).toBeGreaterThanOrEqual(0.4);
      }
    });
  }
  it('without a DS choice, problems vary in how much of the enemy is inside', () => {
    const notes = new Set<string>();
    for (let seed = 1; seed <= 16; seed++) {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed, task: 'secure', info: 'rich', now, timeZone: 'UTC' });
      notes.add(/took in all/.test(s.ds.join(' ')) ? 'all' : 'some');
    }
    expect(notes.size).toBe(2);
  });
});
