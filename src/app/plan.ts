/**
 * The user's plan for a problem (PO, 15 Nov 2026): a route, marked positions
 * and written answers. Kept on the phone (browser storage) so a reload or a
 * long walk does not lose it, and exportable as plain text for an instructor
 * or syndicate.
 */

import type { DevelopedSituation } from '../tactics/planEvents';

export type LatLon = { lat: number; lon: number };

export interface PlanMarkLL extends LatLon {
  kind: string;
  label: string;
}

/** One route for each element of the platoon (PO, 15 Nov 2026). */
export const ROUTE_WHO = ['1 Sect', '2 Sect', '3 Sect', 'Pl HQ'] as const;
export type RouteWho = (typeof ROUTE_WHO)[number];
/** How a report from each element is signed. */
export const WHO_NAME: Record<RouteWho, string> = { '1 Sect': '1 Section', '2 Sect': '2 Section', '3 Sect': '3 Section', 'Pl HQ': 'Platoon HQ' };

export interface PlanState {
  routes: Record<RouteWho, LatLon[]>;
  marks: PlanMarkLL[];
  /** Answers to the requirement questions, in order. */
  answers: string[];
  /** Answers to the questions when the situation develops. */
  answers2: string[];
  /** What was added, in order, for Undo: 'mark', or the route a point was added to. */
  history: ('mark' | RouteWho)[];
  /** The situation as it developed on the route marked (worked out once, then fixed). */
  developed?: DevelopedSituation;
  /** The ground truth has been revealed: the plan is then fixed. */
  revealed?: boolean;
}

/** Enough to set exactly the same problem again (same ground, enemy, task and times). */
export interface ProblemKey {
  lat: number;
  lon: number;
  seed: number;
  task: string;
  info: string;
  detail: string;
  /** The "now" the problem was written for (ms since 1970). */
  now: number;
  /** A full problem, a Quick problem (read and answer) or the Problem of the day. */
  kind?: 'normal' | 'quick' | 'daily';
  /** For the Problem of the day: its date and site. */
  label?: string;
  /** The enemy layout the DS chose, if any ('' or absent: the ground decided). */
  layout?: string;
  /** The enemy spacing the DS chose, if any. */
  spread?: string;
  /** How much of the enemy lies inside your boundaries, if the DS chose. */
  lane?: string;
  /** Attack or defence, if chosen ('' or absent: at random). */
  type?: string;
}

export interface SavedPlan {
  v: 1;
  problem: ProblemKey;
  plan: PlanState;
  savedAt: number;
}

const noRoutes = () => Object.fromEntries(ROUTE_WHO.map((w) => [w, []])) as unknown as Record<RouteWho, LatLon[]>;
export const emptyPlan = (): PlanState => ({ routes: noRoutes(), marks: [], answers: [], answers2: [], history: [] });

/** Routes with at least two points, in platoon order. */
export const drawnRoutes = (plan: PlanState) => ROUTE_WHO.filter((w) => plan.routes[w].length >= 2).map((w) => ({ who: w, points: plan.routes[w] }));
/** Elements with no route yet. */
export const missingRoutes = (plan: PlanState) => ROUTE_WHO.filter((w) => plan.routes[w].length < 2);

const KEY = 'ground-truth.plan.v2'; // v2: one route per element (key kept from the app's old name, so saved plans survive the rename)

export function savePlan(problem: ProblemKey, plan: PlanState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, problem, plan, savedAt: Date.now() } satisfies SavedPlan));
  } catch {
    // Storage blocked (private browsing etc.): the plan still works, it just is not kept.
  }
}

export function loadSavedPlan(): SavedPlan | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedPlan;
    return s && s.v === 1 && s.problem && s.plan ? s : null;
  } catch {
    return null;
  }
}

/** Label for a new mark: "OP", then "OP 2", "OP 3"… */
export function nextLabel(plan: PlanState, kind: string): string {
  const n = plan.marks.filter((m) => m.kind === kind).length;
  return n ? `${kind} ${n + 1}` : kind;
}

export function addRoutePoint(plan: PlanState, who: RouteWho, p: LatLon): void {
  plan.routes[who].push({ lat: p.lat, lon: p.lon });
  plan.history.push(who);
}

export function addMark(plan: PlanState, kind: string, p: LatLon): PlanMarkLL {
  const m = { kind, label: nextLabel(plan, kind), lat: p.lat, lon: p.lon };
  plan.marks.push(m);
  plan.history.push('mark');
  return m;
}

export function undo(plan: PlanState): void {
  const last = plan.history.pop();
  if (last === 'mark') plan.marks.pop();
  else if (last) plan.routes[last].pop();
}

export function removeMark(plan: PlanState, index: number): void {
  plan.marks.splice(index, 1);
  // Drop the matching history entry (the index-th 'mark') so Undo stays in step.
  let seen = -1;
  const h = plan.history.findIndex((x) => x === 'mark' && ++seen === index);
  if (h >= 0) plan.history.splice(h, 1);
}

export function isEmpty(plan: PlanState): boolean {
  return ROUTE_WHO.every((w) => !plan.routes[w].length) && !plan.marks.length && !plan.answers.some((a) => a.trim()) && !plan.answers2.some((a) => a.trim());
}

/** The plan as a plain-text record, with the problem it answers. */
export function planReport(args: {
  title: string;
  problemText: { heading: string; lines: string[] }[];
  questions: string[];
  questions2: string[] | null;
  plan: PlanState;
  ref: (p: LatLon) => string;
  facts: { route: string[]; positions: { label: string; facts: string[] }[] } | null;
  when: Date;
}): string {
  const { plan, ref } = args;
  const out: string[] = [];
  out.push(`VITAL GROUND: ${args.title}`);
  out.push(`Recorded ${args.when.toLocaleString('en-GB')}`);
  out.push('');
  for (const block of args.problemText) {
    out.push(block.heading.toUpperCase());
    for (const l of block.lines) out.push(l);
    out.push('');
  }
  out.push('MY PLAN');
  for (const w of ROUTE_WHO)
    out.push(`${WHO_NAME[w]} route: ${plan.routes[w].length >= 2 ? plan.routes[w].map(ref).join(' → ') : 'not marked'}`);
  if (plan.marks.length) for (const m of plan.marks) out.push(`${m.label}: ${ref(m)}`);
  else out.push('Positions: none marked');
  out.push('');
  out.push('MY ANSWERS');
  args.questions.forEach((q, i) => {
    out.push(`${i + 1}. ${q}`);
    out.push(plan.answers[i]?.trim() || '(no answer)');
    out.push('');
  });
  if (args.questions2) {
    out.push('WHEN THE SITUATION DEVELOPED');
    args.questions2.forEach((q, i) => {
      out.push(`${i + 1}. ${q}`);
      out.push(plan.answers2[i]?.trim() || '(no answer)');
      out.push('');
    });
  }
  if (args.facts) {
    out.push('MY PLAN AGAINST THE GROUND TRUTH (computed facts)');
    for (const f of args.facts.route) out.push(f);
    for (const p of args.facts.positions) {
      out.push(`${p.label}:`);
      for (const f of p.facts) out.push(`  ${f}`);
    }
    out.push('');
  }
  return out.join('\n');
}
