/** Messages between the page and the analysis worker. */
import type { PlanFacts, PlanInput } from '../tactics/planFacts';
import type { DevelopedSituation } from '../tactics/planEvents';
import type { ElevationMeta, Point } from '../terrain/grid';
import type { ProblemText } from '../tactics/problem';
import type { Intel, Posture } from '../tactics/sectionDefence';
import type { LayoutType, PlatoonRole, SpreadName, CompanyOptions, PositionKind } from '../tactics/companyDefence';
import type { InfoLevel, LaneMode, PlatoonScenario, ProblemType, TaskType } from '../tactics/platoonScenario';
import type { AttackOptions } from '../tactics/enemyAttack';
import type { SectionScenarioText } from '../tactics/sectionScenario';
import type { GroundClassification } from '../terrain/classify';
import type { ContourLine } from '../terrain/contours';

export type DemoTerrain = 'ridge' | 'cone' | 'valley' | 'flat';
export type Detail = 'fine' | 'medium' | 'problem' | 'standard';

/** The standard box: 8 km square (PO, 15 Nov 2026; was 4 km). */
export const BOX_M = 8000;

/** Box size and cell size for each LIDAR detail level. */
export const LIDAR_DETAIL: Record<Exclude<Detail, 'standard'>, { sizeM: number; cellM: number; label: string }> = {
  fine: { sizeM: 2000, cellM: 2, label: 'fine (LIDAR 2 m)' },
  medium: { sizeM: BOX_M, cellM: 5, label: 'LIDAR 5 m' },
  problem: { sizeM: 4000, cellM: 10, label: 'LIDAR 10 m' },
};

export type WorkerRequest =
  | {
      type: 'load';
      id: number;
      lat: number;
      lon: number;
      sizeM: number;
      cellM: number;
      /** Use synthetic ground instead of real data (for testing indoors). */
      demo?: DemoTerrain;
      /**
       * Environment Agency LIDAR where it exists (England), else falls back to standard:
       * 'fine' 2 km box at 2 m; 'medium' 8 km at 5 m (the default); 'problem' 4 km at 10 m (what the
       * problem engine is built for). 'standard': ~30 m data, sizeM/cellM as given.
       */
      detail?: Detail;
    }
  | {
      type: 'viewshed';
      id: number;
      /** Local metres from the box centre. */
      x: number;
      y: number;
      obsHeightM: number;
      targetHeightM: number;
      maxRangeM: number;
      /** Let woods, buildings and hedges block sight (fetches map features if needed). */
      useObstacles: boolean;
    }
  | {
      /** Place an enemy section blocking the user's advance from the box centre. */
      type: 'section';
      id: number;
      posture: Posture;
      /** 0–1 to pick among the best few positions for variety; omit for the best. */
      random?: number;
    }
  | {
      /** Generate an enemy company defence across the user's advance from the box centre. */
      type: 'company';
      id: number;
      /** Elements forced on or off; any left out are decided by the generator. */
      options: Partial<CompanyOptions>;
      seed?: number;
      layout?: LayoutType;
    }
  | {
      /** Generate an enemy company and an infantry platoon scenario against it (Moltke guidelines). */
      type: 'scenario';
      id: number;
      task?: TaskType;
      info?: InfoLevel;
      options: Partial<CompanyOptions>;
      seed: number;
      /** Force the enemy's layout (the DS); otherwise the ground decides. */
      layout?: LayoutType;
      /** Force how spread out the enemy is (the DS); otherwise chosen at random. */
      spread?: SpreadName;
      /** Force how much of the enemy lies inside your boundaries (the DS). */
      lane?: LaneMode;
      /** Attack or defence (PO, 23 Nov 2026); otherwise from the task, or chosen at random. */
      problemType?: ProblemType;
      /** The time the problem is set for (ms since 1970), so a resumed problem reads the same. */
      now?: number;
    }
  | {
      /** The situation develops, worked out from the user's plan (local metres). */
      type: 'develop';
      id: number;
      plan: PlanInput;
      startMs: number;
    }
  | {
      /** Facts about the user's plan against the last scenario's enemy (local metres). */
      type: 'planFacts';
      id: number;
      plan: PlanInput;
    }
  | {
      /** Ground height at a point (local metres), or null outside the loaded box. */
      type: 'height';
      id: number;
      x: number;
      y: number;
    }
  | {
      /** Fetch the map features for the loaded ground and draw them. */
      type: 'features';
      id: number;
    }
  | {
      /** Read the features of the loaded ground and set a tactical problem on it. */
      type: 'problem';
      id: number;
    };

export interface LoadedGround {
  /** True if the ground came from LIDAR (fine detail). */
  lidar: boolean;
  /** Why fine detail was not used, if it was asked for and is not available. */
  detailNote: string;
  width: number;
  height: number;
  cellM: number;
  meta: ElevationMeta;
  hillshade: Uint8ClampedArray;
  contours: ContourLine[];
  contourIntervalM: number;
  ground: GroundClassification;
  minM: number;
  maxM: number;
}

export interface ViewshedResult {
  mask: Uint8Array;
  observerGroundM: number;
  visibleShare: number; // share of cells in range that are visible
  timeMs: number;
  /** Whether woods, buildings and hedges were included, or why not. */
  obstaclesNote: string;
}

/** The captured map features, drawn as a see-through picture over the box. */
export interface FeaturesView {
  ok: boolean;
  /** What was loaded, or why it failed. */
  note: string;
  /** RGBA picture, width × height of the grid (only if ok). */
  image?: Uint8ClampedArray;
}

/** An enemy section layout and its scenario, ready to show. Positions in local metres. */
export interface SectionView {
  found: boolean;
  log: string[];
  featureNote: string;
  /** The scenario, written for each level of intelligence the user may be given. */
  text?: Record<Intel, SectionScenarioText>;
  /** The DS solution: shown only when the user asks. */
  ds?: {
    position: Point;
    teams: { label: string; point: Point; gun: boolean; outpost?: boolean }[];
    route: Point[];
    alternatives: Point[];
    maskWidth: number;
    maskHeight: number;
    /** 1 = covered by the section's fire. */
    killZone: Uint8Array;
    /** 1 = dead ground within rifle range in front. */
    deadGround: Uint8Array;
  };
  timeMs: number;
}

/** An enemy company layout for the DS reveal. Positions in local metres. */
export interface CompanyView {
  found: boolean;
  log: string[];
  featureNote: string;
  advanceBearingDeg?: number;
  options?: CompanyOptions;
  /** How the enemy company is laid out (e.g. one up, two back). */
  layout?: LayoutType;
  platoons?: { name: string; role: PlatoonRole; outline: Point[]; positions: { kind: PositionKind; label: string; point: Point; men: number }[] }[];
  hq?: { label: string; point: Point } | null;
  dummies?: { label: string; point: Point }[];
  gaps?: { centre: Point; widthM: number; coveredFromDepth: number; coveredByAny: number }[];
  routes?: Point[][];
  maskWidth?: number;
  maskHeight?: number;
  killZone?: Uint8Array;
  deadGround?: Uint8Array;
  mines?: Uint8Array | null;
  /** The minefields as outlines (local metres), drawn in APP-6. */
  minefields?: { x: number; y: number }[][];
  /** DS notes: reasons and grid references. */
  notes?: string[];
  timeMs: number;
}

/** An infantry scenario and its DS view (the company layout, routes and objective). */
export interface ScenarioView {
  found: boolean;
  log: string[];
  featureNote: string;
  scenario?: Omit<PlatoonScenario, 'direct' | 'covered'> & {
    direct: { path: Point[]; lengthM: number; underFire: number; minesCrossed: number } | null;
    covered: { path: Point[]; lengthM: number; underFire: number; minesCrossed: number } | null;
  };
  company?: CompanyView;
  /** Defence: the enemy's attack, for the ground truth (axes and positions are in the scenario's markers). */
  attack?: { deadFromArea: Uint8Array; maskWidth: number; maskHeight: number; options: AttackOptions };
  timeMs: number;
}

/** A problem, ready to show. Positions are local metres from the box centre. */
export interface ProblemView {
  found: boolean;
  /** Why each enemy direction passed or failed. */
  log: string[];
  /** What map features were loaded, or why they failed. */
  featureNote: string;
  text?: ProblemText;
  nai?: { centre: Point; radiusM: number };
  route?: Point[];
  /** The DS solution: hidden from the user until they ask. */
  ds?: {
    enemyOps: Point[];
    bestOP?: Point;
    altOP?: Point;
    concealedOP?: Point;
    gunAreas: Point[];
    loc?: Point[];
  };
  timeMs: number;
}

export type WorkerResponse =
  | { type: 'progress'; id: number; message: string }
  | { type: 'loaded'; id: number; ground: LoadedGround }
  | { type: 'viewshed'; id: number; result: ViewshedResult }
  | { type: 'problem'; id: number; result: ProblemView }
  | { type: 'features'; id: number; result: FeaturesView }
  | { type: 'height'; id: number; result: number | null }
  | { type: 'section'; id: number; result: SectionView }
  | { type: 'company'; id: number; result: CompanyView }
  | { type: 'scenario'; id: number; result: ScenarioView }
  | { type: 'planFacts'; id: number; result: PlanFacts }
  | { type: 'develop'; id: number; result: DevelopedSituation }
  | { type: 'error'; id: number; message: string };
