/**
 * Web Worker: loads elevation and runs the analysis off the main thread so
 * the map stays responsive. The loaded ground is kept here, so later
 * requests (e.g. a viewshed from a tapped point) need no new download.
 */
import { planFacts } from '../tactics/planFacts';
import { developFromPlan } from '../tactics/planEvents';
import { hhmm } from '../tactics/sun';
import {
  classifyGround,
  countMask,
  elevationAtPoint,
  hillshade,
  inRangeMask,
  loadElevation,
  viewshed,
  pointToCell,
  type Grid,
} from '../terrain';
import { contours, chooseInterval } from '../terrain/contours';
import { coneHill, convexRidge, flatPlane, fromFunction, vValley } from '../terrain/synthetic';
import { browserTileSource } from '../terrain/tiles-browser';
import { LIDAR_DETAIL, type CompanyView, type ScenarioView, type DemoTerrain, type FeaturesView, type ProblemView, type SectionView, type WorkerRequest, type WorkerResponse } from './protocol';
import { featureImage } from '../features/render';
import { fetchFeatures } from '../features/osm';
import { buildLayers, type FeatureLayers } from '../features/layers';
import { generateProblem } from '../tactics/problem';
import { fetchCombinedFeatures } from '../features/osVector';
import { buildObstacles, type Obstacles } from '../features/obstacles';
import { loadLidar } from '../terrain/lidar';
import { placeEnemySection } from '../tactics/sectionDefence';
import { writeSectionScenario } from '../tactics/sectionScenario';
import { placeEnemyCompany, type CompanyLayout } from '../tactics/companyDefence';
import { problemTypeOf, writePlatoonScenario } from '../tactics/platoonScenario';
import { writeDefenceScenario } from '../tactics/defenceScenario';
import { developDefence, defenceFacts } from '../tactics/defenceEvents';
import type { EnemyAttack } from '../tactics/enemyAttack';
import { localToLatLon } from '../terrain/elevation';
import { gridRef } from '../geo/gridref';
import { inGreatBritain } from '../geo/gridref';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let grid: Grid | null = null;
let isDemo = false;
/** Map features for the loaded ground: fetched once, on the first problem request. */
let layers: FeatureLayers | null = null;
let obstacles: Obstacles | null = null;
/** Measured height of hedges, trees and buildings (LIDAR DSM − DTM), when fine detail is loaded. */
let lidarSurface: Float32Array | null = null;
let featureNote = '';
/** The enemy of the last scenario set, for facts about the user's plan. */
let lastScenarioLayout: CompanyLayout | null = null;
/** Defence (PO, 23 Nov 2026): the last problem's attack, and when the enemy moves. */
let lastAttack: { attack: EnemyAttack; enemyMovesMs: number } | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

function demoGrid(kind: DemoTerrain, sizeM: number, cellM: number, lat: number, lon: number): Grid {
  let g: Grid;
  switch (kind) {
    case 'cone':
      g = coneHill(sizeM, cellM, { radiusM: 900, peak: 70 });
      break;
    case 'valley':
      g = vValley(sizeM, cellM, { gradient: 0.04 });
      break;
    case 'flat':
      g = flatPlane(sizeM, cellM, 60);
      break;
    case 'ridge':
    default: {
      // A rounded ridge across the box with a knoll on its northern slope.
      const ridge = convexRidge(sizeM, cellM, { heightM: 60, widthM: 900 });
      const knoll = coneHill(sizeM, cellM, { cx: 700, cy: 900, radiusM: 350, peak: 25, base: 0 });
      g = fromFunction(sizeM, cellM, () => 0);
      for (let i = 0; i < g.data.length; i++) g.data[i] = ridge.data[i] + knoll.data[i];
    }
  }
  g.meta = {
    source: `DEMO: synthetic ${kind} terrain (not the real ground)`,
    sourceResolutionM: cellM,
    surfaceModel: false,
    attribution: '',
    notes: ['Demo mode: this ground is invented, for testing indoors.'],
    centre: { lat, lon },
  };
  return g;
}

/** The DS view of a company layout, with grid references. */
function companyView(g: Grid, L: CompanyLayout, ms: number): CompanyView {
  const ref = (p: { x: number; y: number }) => {
    const c = g.meta.centre;
    if (!c) return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
    const ll = localToLatLon(c, p.x, p.y);
    return gridRef(ll.lat, ll.lon, 4).ref;
  };
  const notes: string[] = [...L.reasons];
  for (const p of L.platoons) notes.push(`${p.name}: ${p.positions.map((x) => `${x.label.replace(p.name + ' ', '')} ${ref(x.point)}`).join('; ')}.`);
  if (L.hq) notes.push(`Coy HQ ${ref(L.hq.point)}.`);
  if (L.dummies.length) notes.push(`Dummies: ${L.dummies.map((d) => ref(d.point)).join('; ')}.`);
  if (L.gaps[0]) notes.push(`Gap centred ${ref(L.gaps[0].centre)}.`);
  notes.push(`How the direction was chosen: ${L.log.join(' ')}`);
  const keep = (_: unknown, k: number, a: unknown[]) => k % 4 === 0 || k === a.length - 1;
  return {
    found: true,
    log: L.log,
    featureNote,
    advanceBearingDeg: L.advanceBearingDeg,
    options: L.options,
    layout: L.layout,
    platoons: L.platoons.map((p) => ({ name: p.name, role: p.role, outline: p.outline, positions: p.positions })),
    hq: L.hq,
    dummies: L.dummies,
    gaps: L.gaps,
    routes: L.routes.map((r) => r.filter(keep)),
    maskWidth: L.maskWidth,
    maskHeight: L.maskHeight,
    killZone: L.killZone,
    deadGround: L.deadGround,
    mines: L.mines,
    minefields: L.minefields,
    notes,
    timeMs: Math.round(ms),
  };
}

/** Fetch and draw the map features for the loaded ground, once per box. */
async function ensureLayers(progress: (m: string) => void): Promise<void> {
  if (!grid || isDemo || layers) return;
  progress('Fetching woods, water, roads and paths…');
  try {
    const centre = grid.meta.centre!;
    const sizeM = grid.width * grid.cellM;
    const combined = await fetchCombinedFeatures(centre, sizeM, {
      osKey: import.meta.env.VITE_OS_KEY ?? '',
      inGB: inGreatBritain(centre.lat, centre.lon),
      fetchOsm: (pathsAndHedgesOnly) => fetchFeatures(centre, sizeM, { pathsAndHedgesOnly }),
    });
    layers = buildLayers(grid, combined.set);
    obstacles = buildObstacles(grid, layers, lidarSurface ?? undefined);
    const c = layers.counts;
    const roads = (c['major-road'] ?? 0) + (c['minor-road'] ?? 0) + (c.motorway ?? 0);
    featureNote =
      `${combined.sources.join(' ')} Loaded: ${roads} roads, ${c.track ?? 0} tracks, ${c.path ?? 0} paths, ` +
      `${c.wood ?? 0} woods, ${c.scrub ?? 0} areas of scrub, ${(c.water ?? 0) + (c.river ?? 0) + (c.stream ?? 0)} water features, ` +
      `${c.hedge ?? 0} hedges, ${c['built-up'] ?? 0} built-up areas, ${c.building ?? 0} buildings, ${c.railway ?? 0} railway lines.`;
  } catch (err) {
    featureNote = `Map features could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
  }
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'load') {
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      isDemo = !!req.demo;
      layers = null;
      obstacles = null;
      lidarSurface = null;
      featureNote = '';
      let detailNote = '';
      let lidar = false;
      grid = null;
      if (!req.demo && req.detail && req.detail !== 'standard') {
        const d = LIDAR_DETAIL[req.detail];
        if (!inGreatBritain(req.lat, req.lon)) detailNote = 'LIDAR detail is only available in England, so standard detail is used.';
        else {
          try {
            const l = await loadLidar({ lat: req.lat, lon: req.lon }, d.sizeM, d.cellM, { onProgress: progress });
            if (l) {
              grid = l.grid;
              lidar = true;
              if (l.surfaceM.length) {
                lidarSurface = l.surfaceM;
                obstacles = buildObstacles(grid, null, lidarSurface);
              }
            } else detailNote = 'No LIDAR here (it covers most of England only), so standard detail is used.';
          } catch (err) {
            detailNote = `LIDAR could not be loaded (${err instanceof Error ? err.message : String(err)}), so standard detail is used.`;
          }
        }
      }
      if (!grid) {
        grid = req.demo
          ? demoGrid(req.demo, req.sizeM, req.cellM, req.lat, req.lon)
          : await loadElevation(req.lat, req.lon, req.sizeM, req.cellM, {
              source: browserTileSource(),
              onProgress: progress,
            });
      }
      progress('Analysing the ground…');
      const hs = hillshade(grid);
      const interval = chooseInterval(grid);
      let minM = Infinity;
      let maxM = -Infinity;
      for (const v of grid.data) {
        if (v < minM) minM = v;
        if (v > maxM) maxM = v;
      }
      post(
        {
          type: 'loaded',
          id: req.id,
          ground: {
            lidar,
            detailNote,
            width: grid.width,
            height: grid.height,
            cellM: grid.cellM,
            meta: grid.meta,
            hillshade: hs,
            contours: contours(grid, interval),
            contourIntervalM: interval,
            ground: classifyGround(grid),
            minM,
            maxM,
          },
        },
        [hs.buffer],
      );
    } else if (req.type === 'viewshed') {
      if (!grid) throw new Error('No ground loaded yet');
      if (req.useObstacles) await ensureLayers((message) => post({ type: 'progress', id: req.id, message }));
      const t0 = performance.now();
      const p = { x: req.x, y: req.y };
      const useObs = req.useObstacles && !!obstacles;
      const obstaclesNote = !req.useObstacles
        ? 'Woods, buildings and hedges ignored (bare ground).'
        : useObs && lidarSurface
          ? 'Hedges, trees, walls and buildings block sight at their measured (LIDAR) heights; you see 15 m into mapped woods.'
          : useObs
          ? 'Woods (15 m, seen 15 m in), buildings (8 m) and hedges (2 m) block sight.'
          : isDemo
            ? 'Demo ground has no woods or buildings.'
            : 'Woods and buildings could not be loaded, so they are ignored.';
      // Warn if the observer is standing in or right beside something taller
      // than their eye (trees, a building): it will block most of the view.
      let blockedNote = '';
      if (useObs) {
        const oc = pointToCell(grid, p);
        const R = Math.max(1, Math.round(6 / grid.cellM));
        let tallest = 0;
        for (let dr = -R; dr <= R; dr++)
          for (let dc = -R; dc <= R; dc++) {
            const r = oc.row + dr;
            const c = oc.col + dc;
            if (r >= 0 && c >= 0 && r < grid.height && c < grid.width) tallest = Math.max(tallest, obstacles!.heightM[r * grid.width + c]);
          }
        if (tallest > req.obsHeightM)
          blockedNote = ` Warning: you are standing in or right beside something about ${Math.round(tallest)} m tall (trees or a building), which blocks your view. Move clear of it.`;
      }
      const opts = {
        obsHeightM: req.obsHeightM,
        targetHeightM: req.targetHeightM,
        maxRangeM: req.maxRangeM,
        obstacles: useObs ? obstacles! : undefined,
      };
      const mask = viewshed(grid, p, opts);
      const inRange = countMask(inRangeMask(grid, [{ point: p }], req.maxRangeM));
      post(
        {
          type: 'viewshed',
          id: req.id,
          result: {
            mask,
            observerGroundM: elevationAtPoint(grid, p),
            visibleShare: inRange ? countMask(mask) / inRange : 0,
            timeMs: Math.round(performance.now() - t0),
            obstaclesNote: obstaclesNote + blockedNote,
          },
        },
        [mask.buffer],
      );
    } else if (req.type === 'section') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      const t0 = performance.now();
      await ensureLayers(progress);
      progress('Reading the ground for a likely enemy position…');
      const layout = placeEnemySection({ grid, layers, obstacles, posture: req.posture, random: req.random });
      const keep = (_: unknown, k: number, a: unknown[]) => k % 4 === 0 || k === a.length - 1;
      const view: SectionView = {
        found: !!layout,
        log: layout?.log ?? ['No position ahead of you covers enough of any route across the box.'],
        featureNote,
        text: layout
          ? {
              exact: writeSectionScenario(grid, layout, 'exact'),
              area: writeSectionScenario(grid, layout, 'area'),
              direction: writeSectionScenario(grid, layout, 'direction'),
            }
          : undefined,
        ds: layout
          ? {
              position: layout.position,
              teams: layout.teams,
              route: layout.route.filter(keep),
              alternatives: layout.alternatives.map((a) => a.point),
              maskWidth: layout.maskWidth,
              maskHeight: layout.maskHeight,
              killZone: layout.killZone,
              deadGround: layout.deadGround,
            }
          : undefined,
        timeMs: Math.round(performance.now() - t0),
      };
      post({ type: 'section', id: req.id, result: view }, view.ds ? [view.ds.killZone.buffer, view.ds.deadGround.buffer] : []);
    } else if (req.type === 'scenario') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      const t0 = performance.now();
      await ensureLayers(progress);
      // Attack or defence: as asked, else from the task, else at random (seeded, so a problem can be set again).
      const type = req.problemType ?? (req.task ? problemTypeOf(req.task) : ((req.seed * 2654435761) >>> 0) % 2 ? 'defence' : 'attack');
      lastAttack = null;
      lastScenarioLayout = null;
      if (type === 'defence') {
        progress('Working out how the enemy will attack…');
        const r = writeDefenceScenario({ grid, layers, obstacles, task: req.task, info: req.info, seed: req.seed, now: req.now ? new Date(req.now) : undefined });
        if (!r) {
          post({ type: 'scenario', id: req.id, result: { found: false, log: ['No enemy attack fits this ground.'], featureNote, timeMs: Math.round(performance.now() - t0) } });
          return;
        }
        lastAttack = { attack: r.attack, enemyMovesMs: r.scenario.enemyMovesMs! };
        const A = r.attack;
        const view: ScenarioView = {
          found: true,
          log: A.reasons,
          featureNote,
          scenario: r.scenario,
          attack: { deadFromArea: A.deadFromArea.slice(), maskWidth: A.maskWidth, maskHeight: A.maskHeight, options: A.options },
          timeMs: Math.round(performance.now() - t0),
        };
        post({ type: 'scenario', id: req.id, result: view });
        return;
      }
      const L = placeEnemyCompany({ grid, layers, obstacles, options: req.options, seed: req.seed, layout: req.layout, spread: req.spread, progress });
      if (!L) {
        post({ type: 'scenario', id: req.id, result: { found: false, log: ['No sensible enemy defence fits ahead of you in any direction.'], featureNote, timeMs: Math.round(performance.now() - t0) } });
        return;
      }
      lastScenarioLayout = L;
      progress('Writing the problem…');
      const sc = writePlatoonScenario({ grid, layers, obstacles, layout: L, task: req.task, info: req.info, seed: req.seed, lane: req.lane, now: req.now ? new Date(req.now) : undefined });
      const keep = (_: unknown, k: number, a: unknown[]) => k % 3 === 0 || k === a.length - 1;
      const company = companyView(grid, L, performance.now() - t0);
      const view: ScenarioView = {
        found: true,
        log: L.log,
        featureNote,
        scenario: {
          ...sc,
          direct: sc.direct ? { ...sc.direct, path: sc.direct.path.filter(keep) } : null,
          covered: sc.covered ? { ...sc.covered, path: sc.covered.path.filter(keep) } : null,
        },
        company,
        timeMs: Math.round(performance.now() - t0),
      };
      // The masks are copied, not transferred: the worker keeps the layout for plan facts.
      post({ type: 'scenario', id: req.id, result: view });
    } else if (req.type === 'develop' && lastAttack) {
      if (!grid) throw new Error('No ground loaded yet');
      const g = grid;
      const ref = (p: { x: number; y: number }) => {
        const c = g.meta.centre;
        if (!c) return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
        const ll = localToLatLon(c, p.x, p.y);
        return gridRef(ll.lat, ll.lon, 3).ref;
      };
      post({ type: 'develop', id: req.id, result: developDefence(g, obstacles, lastAttack.attack, req.plan, lastAttack.enemyMovesMs, ref, (d) => hhmm(d)) });
    } else if (req.type === 'planFacts' && lastAttack) {
      if (!grid) throw new Error('No ground loaded yet');
      const g = grid;
      const ref = (p: { x: number; y: number }) => {
        const c = g.meta.centre;
        if (!c) return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
        const ll = localToLatLon(c, p.x, p.y);
        return gridRef(ll.lat, ll.lon, 3).ref;
      };
      post({ type: 'planFacts', id: req.id, result: defenceFacts(g, obstacles, lastAttack.attack, req.plan, ref) });
    } else if (req.type === 'develop') {
      if (!grid || !lastScenarioLayout) throw new Error('No problem set yet');
      const g = grid;
      const ref = (p: { x: number; y: number }) => {
        const c = g.meta.centre;
        if (!c) return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
        const ll = localToLatLon(c, p.x, p.y);
        return gridRef(ll.lat, ll.lon, 3).ref;
      };
      post({ type: 'develop', id: req.id, result: developFromPlan(g, obstacles, lastScenarioLayout, req.plan, req.startMs, ref, (d) => hhmm(d)) });
    } else if (req.type === 'planFacts') {
      if (!grid || !lastScenarioLayout) throw new Error('No problem set yet');
      const g = grid;
      const ref = (p: { x: number; y: number }) => {
        const c = g.meta.centre;
        if (!c) return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
        const ll = localToLatLon(c, p.x, p.y);
        return gridRef(ll.lat, ll.lon, 3).ref;
      };
      post({ type: 'planFacts', id: req.id, result: planFacts(g, obstacles, lastScenarioLayout, req.plan, ref) });
    } else if (req.type === 'company') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      const t0 = performance.now();
      await ensureLayers(progress);
      const L = placeEnemyCompany({ grid, layers, obstacles, options: req.options, seed: req.seed, layout: req.layout, progress });
      const g = grid;
      const ref = (p: { x: number; y: number }) => {
        const c = g.meta.centre;
        if (!c) return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
        const ll = localToLatLon(c, p.x, p.y);
        return gridRef(ll.lat, ll.lon, 4).ref;
      };
      const notes: string[] = [];
      if (L) {
        notes.push(...L.reasons);
        for (const p of L.platoons) notes.push(`${p.name}: ${p.positions.map((x) => `${x.label.replace(p.name + ' ', '')} ${ref(x.point)}`).join('; ')}.`);
        if (L.hq) notes.push(`Coy HQ ${ref(L.hq.point)}.`);
        if (L.dummies.length) notes.push(`Dummies: ${L.dummies.map((d) => ref(d.point)).join('; ')}.`);
        if (L.gaps[0]) notes.push(`Gap centred ${ref(L.gaps[0].centre)}.`);
        notes.push(`How the direction was chosen: ${L.log.join(' ')}`);
      }
      const keep = (_: unknown, k: number, a: unknown[]) => k % 4 === 0 || k === a.length - 1;
      const view: CompanyView = L
        ? {
            found: true,
            log: L.log,
            featureNote,
            advanceBearingDeg: L.advanceBearingDeg,
            options: L.options,
            platoons: L.platoons.map((p) => ({ name: p.name, role: p.role, outline: p.outline, positions: p.positions })),
            hq: L.hq,
            dummies: L.dummies,
            gaps: L.gaps,
            routes: L.routes.map((r) => r.filter(keep)),
            maskWidth: L.maskWidth,
            maskHeight: L.maskHeight,
            killZone: L.killZone,
            deadGround: L.deadGround,
            mines: L.mines,
            notes,
            timeMs: Math.round(performance.now() - t0),
          }
        : { found: false, log: ['No sensible company defence fits ahead of you in any direction.'], featureNote, timeMs: Math.round(performance.now() - t0) };
      const transfer: Transferable[] = [];
      if (L) {
        transfer.push(L.killZone.buffer, L.deadGround.buffer);
        if (L.mines) transfer.push(L.mines.buffer);
      }
      post({ type: 'company', id: req.id, result: view }, transfer);
    } else if (req.type === 'height') {
      const half = grid ? (grid.width * grid.cellM) / 2 : 0;
      const inside = !!grid && Math.abs(req.x) <= half && Math.abs(req.y) <= half;
      post({ type: 'height', id: req.id, result: inside ? elevationAtPoint(grid!, { x: req.x, y: req.y }) : null });
    } else if (req.type === 'features') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      await ensureLayers(progress);
      let view: FeaturesView;
      if (isDemo) view = { ok: false, note: 'Demo ground has no map features.' };
      else if (!layers) view = { ok: false, note: featureNote };
      else view = { ok: true, note: featureNote, image: featureImage(grid.width, grid.height, layers) };
      post({ type: 'features', id: req.id, result: view }, view.image ? [view.image.buffer] : []);
    } else if (req.type === 'problem') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      const t0 = performance.now();
      await ensureLayers(progress);
      if (isDemo) featureNote = 'Demo ground: no map features. Public access is not checked.';
      const out = generateProblem(grid, { layers, obstacles, progress });
      const p = out.problem;
      const r = p?.result;
      const view: ProblemView = {
        found: !!p,
        log: out.log,
        featureNote,
        text: p?.text,
        nai: r ? { centre: r.approach.nai.centre, radiusM: r.approach.nai.radiusM } : undefined,
        route: r?.approach.route.filter((_, k, a) => k % 5 === 0 || k === a.length - 1),
        ds: r
          ? {
              enemyOps: r.enemyOps.map((o) => o.point),
              bestOP: r.bestViewOP?.point,
              altOP: r.alternativeOP?.point,
              concealedOP: r.concealedOP?.point,
              gunAreas: r.gunAreas.slice(0, 3).map((g) => g.centre),
              loc: r.locToBestOP?.path.filter((_, k, a) => k % 5 === 0 || k === a.length - 1),
            }
          : undefined,
        timeMs: Math.round(performance.now() - t0),
      };
      post({ type: 'problem', id: req.id, result: view });
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
