/**
 * The page's handle on the analysis worker: each request returns a promise.
 */
import type { PlanFacts, PlanInput } from '../tactics/planFacts';
import type { DevelopedSituation } from '../tactics/planEvents';
import type { Posture } from '../tactics/sectionDefence';
import type { CompanyOptions, LayoutType, SpreadName } from '../tactics/companyDefence';
import type { InfoLevel, LaneMode, ProblemType, TaskType } from '../tactics/platoonScenario';
import { BOX_M } from '../worker/protocol';
import type { CompanyView, ScenarioView, DemoTerrain, Detail, FeaturesView, LoadedGround, ProblemView, SectionView, ViewshedResult, WorkerRequest, WorkerResponse } from '../worker/protocol';

/** Omit that works across each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (m: string) => void };

export class Engine {
  private worker = new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.message);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else if (msg.type === 'loaded') p.resolve(msg.ground);
      else if (msg.type === 'viewshed') p.resolve(msg.result);
      else if (msg.type === 'problem') p.resolve(msg.result);
      else if (msg.type === 'planFacts') p.resolve(msg.result);
      else if (msg.type === 'develop') p.resolve(msg.result);
      else if (msg.type === 'features') p.resolve(msg.result);
      else if (msg.type === 'height') p.resolve(msg.result);
      else if (msg.type === 'section') p.resolve(msg.result);
      else if (msg.type === 'company') p.resolve(msg.result);
      else if (msg.type === 'scenario') p.resolve(msg.result);
    };
  }

  private request<T>(req: DistributiveOmit<WorkerRequest, 'id'>, onProgress?: (m: string) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id });
    });
  }

  load(
    lat: number,
    lon: number,
    opts: { sizeM?: number; cellM?: number; demo?: DemoTerrain; detail?: Detail } = {},
    onProgress?: (m: string) => void,
  ): Promise<LoadedGround> {
    return this.request<LoadedGround>(
      { type: 'load', lat, lon, sizeM: opts.sizeM ?? BOX_M, cellM: opts.cellM ?? 10, demo: opts.demo, detail: opts.detail },
      onProgress,
    );
  }

  /** Place an enemy section blocking the advance from the box centre, and write the scenario. */
  section(posture: Posture, random: number | undefined, onProgress?: (m: string) => void): Promise<SectionView> {
    return this.request<SectionView>({ type: 'section', posture, random }, onProgress);
  }

  /** Generate an enemy company defence across the advance from the box centre (DS view). */
  company(options: Partial<CompanyOptions>, seed: number | undefined, onProgress?: (m: string) => void, layout?: LayoutType): Promise<CompanyView> {
    return this.request<CompanyView>({ type: 'company', options, seed, layout }, onProgress);
  }

  /** Generate an enemy company and an infantry platoon scenario against it. */
  develop(plan: PlanInput, startMs: number): Promise<DevelopedSituation> {
    return this.request<DevelopedSituation>({ type: 'develop', plan, startMs });
  }

  planFacts(plan: PlanInput): Promise<PlanFacts> {
    return this.request<PlanFacts>({ type: 'planFacts', plan });
  }

  scenario(
    req: { task?: TaskType; info?: InfoLevel; options: Partial<CompanyOptions>; seed: number; now?: number; layout?: LayoutType; spread?: SpreadName; lane?: LaneMode; problemType?: ProblemType },
    onProgress?: (m: string) => void,
  ): Promise<ScenarioView> {
    return this.request<ScenarioView>({ type: 'scenario', ...req }, onProgress);
  }

  /** Ground height at a point (local metres), or null outside the loaded box. */
  height(x: number, y: number): Promise<number | null> {
    return this.request<number | null>({ type: 'height', x, y });
  }

  /** Fetch the map features for the loaded ground and draw them. */
  features(onProgress?: (m: string) => void): Promise<FeaturesView> {
    return this.request<FeaturesView>({ type: 'features' }, onProgress);
  }

  /** Read the map features and set a tactical problem on the loaded ground. */
  problem(onProgress?: (m: string) => void): Promise<ProblemView> {
    return this.request<ProblemView>({ type: 'problem' }, onProgress);
  }

  viewshed(
    x: number,
    y: number,
    obsHeightM: number,
    targetHeightM: number,
    maxRangeM: number,
    useObstacles: boolean,
    onProgress?: (m: string) => void,
  ): Promise<ViewshedResult> {
    return this.request<ViewshedResult>({ type: 'viewshed', x, y, obsHeightM, targetHeightM, maxRangeM, useObstacles }, onProgress);
  }
}
