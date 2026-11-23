/**
 * Tactical graphics for the situation map, as GeoJSON: axes of advance
 * (effects arrows), the objective, the task graphics (secure, neutralise,
 * fix, screen) and minefield outlines. Shapes follow the APP-6 control
 * measures and mission-task graphics in simplified form.
 *
 * Built in local metres and converted to longitude/latitude.
 */
import { localToLatLon } from '../terrain/elevation';
import type { Point } from '../terrain/grid';

type LL = { lat: number; lon: number };
type Feature = { type: 'Feature'; properties: Record<string, unknown>; geometry: object };

const toLL = (c: LL, p: Point): [number, number] => {
  const q = localToLatLon(c, p.x, p.y);
  return [q.lon, q.lat];
};
const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const unit = (a: Point, b: Point): Point => {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
};
const perp = (d: Point): Point => ({ x: d.y, y: -d.x });

function line(c: LL, pts: Point[], props: Record<string, unknown>): Feature {
  return { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map((p) => toLL(c, p)) } };
}
function polygon(c: LL, pts: Point[], props: Record<string, unknown>): Feature {
  const ring = [...pts, pts[0]].map((p) => toLL(c, p));
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
}
function label(c: LL, p: Point, text: string, props: Record<string, unknown>): Feature {
  return { type: 'Feature', properties: { ...props, kind: 'label', text }, geometry: { type: 'Point', coordinates: toLL(c, p) } };
}

/** APP-6 axis of advance: a broad open arrow from `from` to `to`. */
export function axisArrow(c: LL, from: Point, to: Point, side: 'friend' | 'hostile', text: string): Feature[] {
  const d = unit(from, to);
  const n = perp(d);
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const shaft = 35, head = 80, headLen = Math.min(120, len / 3);
  const neck = add(to, d, -headLen);
  const pts = [
    add(from, n, shaft), add(neck, n, shaft), add(neck, n, head), to, add(neck, n, -head), add(neck, n, -shaft), add(from, n, -shaft),
  ];
  return [
    line(c, [...pts, pts[0]], { kind: 'axis', side }),
    label(c, add(add(from, d, len / 2), n, 0), text, { side }),
  ];
}

/** Objective: a rounded outline labelled OBJ (or its name). */
export function objective(c: LL, p: Point, r = 150, name = 'OBJ'): Feature[] {
  const ring: Point[] = [];
  for (let k = 0; k < 36; k++) ring.push({ x: p.x + r * Math.cos((k * Math.PI) / 18), y: p.y + r * Math.sin((k * Math.PI) / 18) });
  return [line(c, [...ring, ring[0]], { kind: 'obj', side: 'friend' }), label(c, add(p, { x: 0, y: r + 40 }), name, { side: 'friend' })];
}

/**
 * Friendly control lines (APP-6): a boundary (solid line with the echelon
 * mark, "I" for company, in the middle and the unit on each side) or a
 * phase line / start line (labelled at both ends).
 */
export function controlLine(c: LL, kind: 'boundary' | 'phaseLine', path: Point[], text: string, sides?: [string, string]): Feature[] {
  const a = path[0], b = path[path.length - 1];
  const d = unit(a, b);
  if (kind !== 'boundary') {
    return [line(c, path, { kind, side: 'friend' }), label(c, add(a, d, 120), text, { side: 'friend' }), label(c, add(b, d, -120), text, { side: 'friend' })];
  }
  // APP-6 boundary (PO, 15 Nov 2026): the line is broken halfway along, and the
  // echelon mark sits in the gap (one bar per "I": company I, battalion II; dots for
  // a platoon •••), with the units' names either side of the line at the mark.
  const lens = path.slice(1).map((q, k) => Math.hypot(q.x - path[k].x, q.y - path[k].y));
  const total = lens.reduce((s, x) => s + x, 0);
  /** The point at a distance along the path, and the index of the segment it is on. */
  const at = (dist: number): { p: Point; k: number } => {
    let k = 0, run = 0;
    while (k < lens.length - 1 && run + lens[k] < dist) run += lens[k++];
    const t = lens[k] ? Math.max(0, Math.min(1, (dist - run) / lens[k])) : 0;
    return { p: { x: path[k].x + (path[k + 1].x - path[k].x) * t, y: path[k].y + (path[k + 1].y - path[k].y) * t }, k };
  };
  const { p: mid, k } = at(total / 2);
  // The line's own direction at the mark, over about 100 m either side.
  const before = path[Math.max(0, k - 3)], after = path[Math.min(path.length - 1, k + 4)];
  const dm = unit(before, after), nm = perp(dm);
  const dots = (text.match(/•/g) ?? []).length;
  const bars = dots ? 0 : Math.max(1, (text.match(/I/g) ?? []).length);
  const half = dots ? 26 * dots : 30 + 14 * bars; // half the gap, metres
  // The line in two parts, with the gap between.
  const g0 = at(total / 2 - half), g1 = at(total / 2 + half);
  const out: Feature[] = [
    line(c, [...path.slice(0, g0.k + 1), g0.p], { kind, side: 'friend' }),
    line(c, [g1.p, ...path.slice(g1.k + 1)], { kind, side: 'friend' }),
  ];
  if (dots) {
    // Platoon (•••): dots in a row along the line, in the gap.
    for (let j = 0; j < dots; j++) {
      const q = add(mid, dm, (j - (dots - 1) / 2) * 34);
      const ring: Point[] = [];
      for (let r = 0; r < 12; r++) ring.push({ x: q.x + 11 * Math.cos((r * Math.PI) / 6), y: q.y + 11 * Math.sin((r * Math.PI) / 6) });
      out.push(polygon(c, ring, { kind: 'dot', side: 'friend' }));
    }
  } else {
    // Company (I) or battalion (II): bars standing across the line, in the gap.
    for (let j = 0; j < bars; j++) {
      const q = add(mid, dm, (j - (bars - 1) / 2) * 25);
      out.push(line(c, [add(q, nm, -60), add(q, nm, 60)], { kind, side: 'friend' }));
    }
  }
  // perp() points to the right of the line's direction (which runs forward); sides = [left, right].
  if (sides) {
    out.push(label(c, add(mid, nm, -130), sides[0], { side: 'friend' }));
    out.push(label(c, add(mid, nm, 130), sides[1], { side: 'friend' }));
  }
  return out;
}

/** Secure: an arrow curving round the objective, labelled S. */
function secure(c: LL, p: Point, r = 220): Feature[] {
  const arc: Point[] = [];
  for (let a = 200; a >= -60; a -= 10) arc.push({ x: p.x + r * Math.cos((a * Math.PI) / 180), y: p.y + r * Math.sin((a * Math.PI) / 180) });
  const end = arc[arc.length - 1], prev = arc[arc.length - 2];
  const d = unit(prev, end), n = perp(d);
  return [
    line(c, arc, { kind: 'task', side: 'friend' }),
    line(c, [add(add(end, d, -40), n, 25), end, add(add(end, d, -40), n, -25)], { kind: 'task', side: 'friend' }),
    label(c, { x: p.x - r - 40, y: p.y }, 'S', { side: 'friend', big: true }),
  ];
}

/** Neutralise (APP-6): a cross through the target with one arm dashed (a solid cross is "destroy"), labelled N. */
function neutralise(c: LL, p: Point, r = 200): Feature[] {
  return [
    line(c, [{ x: p.x - r, y: p.y - r }, { x: p.x + r, y: p.y + r }], { kind: 'task', side: 'friend' }),
    line(c, [{ x: p.x - r, y: p.y + r }, { x: p.x + r, y: p.y - r }], { kind: 'task', side: 'friend', dashed: true }),
    label(c, { x: p.x, y: p.y + r + 50 }, 'N', { side: 'friend', big: true }),
  ];
}

/** Fix: a zig-zag arrow towards the target, labelled F. */
function fix(c: LL, from: Point, to: Point): Feature[] {
  const d = unit(from, to), n = perp(d);
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const pts: Point[] = [from];
  const steps = 6;
  for (let k = 1; k < steps; k++) pts.push(add(add(from, d, (len * k) / steps), n, k % 2 ? 40 : -40));
  pts.push(to);
  return [
    line(c, pts, { kind: 'task', side: 'friend' }),
    line(c, [add(add(to, d, -50), n, 30), to, add(add(to, d, -50), n, -30)], { kind: 'task', side: 'friend' }),
    label(c, add(add(from, d, len / 2), n, 90), 'F', { side: 'friend', big: true }),
  ];
}

/** Screen (APP-6): from the centre outwards, a line to each end with a zig-zag and an arrowhead, and S either side. */
function screen(c: LL, p: Point, along: Point): Feature[] {
  const n = perp(along);
  const out: Feature[] = [];
  for (const s of [-1, 1]) {
    const dir = { x: along.x * s, y: along.y * s };
    const z0 = add(p, dir, 220), z1 = add(add(p, dir, 260), n, 45), z2 = add(add(p, dir, 300), n, -45), end = add(p, dir, 400);
    out.push(line(c, [add(p, dir, 120), z0, z1, z2, add(z2, dir, 30), end], { kind: 'task', side: 'friend' }));
    out.push(line(c, [add(add(end, dir, -40), n, 22), end, add(add(end, dir, -40), n, -22)], { kind: 'task', side: 'friend' }));
    out.push(label(c, add(p, dir, 70), 'S', { side: 'friend', big: true }));
  }
  return out;
}

export function taskGraphic(
  c: LL,
  t: { kind: 'secure' | 'neutralise' | 'findFix' | 'screen'; objective: Point; from: Point; across: Point },
): Feature[] {
  if (t.kind === 'secure') return [...objective(c, t.objective), ...secure(c, t.objective)];
  if (t.kind === 'neutralise') return neutralise(c, t.objective);
  if (t.kind === 'findFix') return fix(c, t.from, t.objective);
  // Screen runs along the line of advance, i.e. perpendicular to "across".
  return screen(c, t.objective, perp(t.across));
}

export type MineType = 'unspecified' | 'ap' | 'mixed';

/**
 * Minefield in APP-6 form: a closed outline (dashed if planned or suspected,
 * solid if known) with mine symbols inside: open circle = mine of unknown
 * type, filled circle = anti-tank, filled circle with two "whiskers" =
 * anti-personnel. A mixed minefield shows both.
 */
export function minefield(c: LL, outline: Point[], type: MineType, side: 'hostile', dashed: boolean): Feature[] {
  if (outline.length < 3) return [];
  const cx = outline.reduce((a, p) => a + p.x, 0) / outline.length;
  const cy = outline.reduce((a, p) => a + p.y, 0) / outline.length;
  // The mine symbols run along the longest side of the outline.
  let along: Point = { x: 1, y: 0 }, longest = 0;
  for (let k = 0; k < outline.length; k++) {
    const a = outline[k], b = outline[(k + 1) % outline.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > longest) { longest = len; along = unit(a, b); }
  }
  const centre = { x: cx, y: cy };
  const icon = (k: number): string =>
    type === 'unspecified' ? 'mine-unk' : type === 'ap' ? 'mine-ap' : k % 2 ? 'mine-ap' : 'mine-at';
  const spots = longest < 200 ? [0] : [-1, 0, 1];
  const step = longest * 0.28;
  const mines: Feature[] = spots.map((k, n) => ({
    type: 'Feature',
    properties: { kind: 'mine', side, icon: icon(n) },
    geometry: { type: 'Point', coordinates: toLL(c, add(centre, along, k * step)) },
  }));
  return [polygon(c, outline, { kind: 'minefield', side, dashed }), ...mines];
}

// ---------- The user's planned positions (APP-6 control measures, friendly blue) ----------
// `dir` is a unit vector from the position towards the enemy / objective.
// Drawn about twice real size, so they read at the zoom a plan is made at.
const K = 2;

/** An area position (FUP, assault position): a rounded outline across the line of advance, labelled inside. */
export function areaPosition(c: LL, p: Point, dir: Point, text: string, w0 = 160, d0 = 90): Feature[] {
  const n = perp(dir);
  const w = w0 * K, d = d0 * K;
  const ring: Point[] = [];
  const r = d / 2;
  // Two straight sides across the advance, joined by half-circles at each end.
  for (const side of [1, -1]) {
    const centre = add(p, n, (side * (w - d)) / 2);
    for (let k = 0; k <= 12; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 12;
      // a sweeps from -90° to +90° around the end, in the frame (n, dir).
      ring.push(add(add(centre, n, side * r * Math.cos(a)), dir, side * r * Math.sin(a)));
    }
  }
  return [line(c, [...ring, ring[0]], { kind: 'plan', side: 'friend' }), label(c, p, text, { side: 'friend' })];
}

/** Support by fire position (APP-6 SBF): a base line; from each end an arrow forward and outward, and a short stub back and outward. */
export function supportByFire(c: LL, p: Point, dir: Point, text = 'SBF'): Feature[] {
  const n = perp(dir);
  const half = 80 * K, len = 80 * K;
  const a = add(p, n, -half), b = add(p, n, half);
  const tipA = add(add(a, dir, len), n, -len * 0.6), tipB = add(add(b, dir, len), n, len * 0.6);
  const stubA = add(add(a, dir, -40 * K), n, -25 * K), stubB = add(add(b, dir, -40 * K), n, 25 * K);
  const head = (from: Point, tip: Point) => {
    const u = unit(from, tip), q = perp(u);
    return [add(add(tip, u, -25 * K), q, 14 * K), tip, add(add(tip, u, -25 * K), q, -14 * K)];
  };
  return [
    line(c, [a, b], { kind: 'plan', side: 'friend' }),
    line(c, [a, tipA], { kind: 'plan', side: 'friend' }),
    line(c, [b, tipB], { kind: 'plan', side: 'friend' }),
    line(c, head(a, tipA), { kind: 'plan', side: 'friend' }),
    line(c, head(b, tipB), { kind: 'plan', side: 'friend' }),
    line(c, [a, stubA], { kind: 'plan', side: 'friend' }),
    line(c, [b, stubB], { kind: 'plan', side: 'friend' }),
    label(c, add(p, dir, -35 * K), text, { side: 'friend' }),
  ];
}

/** Attack by fire position (APP-6 ABF): a base line with its ends bent back, and an arrow forward from the centre. */
export function attackByFire(c: LL, p: Point, dir: Point, text = 'ABF'): Feature[] {
  const n = perp(dir);
  const half = 60 * K, tip = add(p, dir, 130 * K);
  return [
    line(c, [add(add(p, n, -half - 40 * K), dir, -40 * K), add(p, n, -half), add(p, n, half), add(add(p, n, half + 40 * K), dir, -40 * K)], { kind: 'plan', side: 'friend' }),
    line(c, [p, tip], { kind: 'plan', side: 'friend' }),
    line(c, [add(add(tip, dir, -25 * K), n, 14 * K), tip, add(add(tip, dir, -25 * K), n, -14 * K)], { kind: 'plan', side: 'friend' }),
    label(c, add(p, dir, -35 * K), text, { side: 'friend' }),
  ];
}

/** Block (APP-6 mission task), used for a cut-off: a bar across the enemy's line of movement, with a stem from our side, labelled B. */
export function blockGraphic(c: LL, p: Point, dir: Point, text = 'B'): Feature[] {
  const n = perp(dir);
  return [
    line(c, [add(p, n, -70 * K), add(p, n, 70 * K)], { kind: 'plan', side: 'friend' }),
    line(c, [p, add(p, dir, -110 * K)], { kind: 'plan', side: 'friend' }),
    label(c, add(add(p, dir, -60 * K), n, 30 * K), text, { side: 'friend' }),
  ];
}

// ---------- Defence (PO, 23 Nov 2026) ----------

/**
 * An enemy axis along its real path (APP-6 axis of advance, simplified to its
 * centre line): red, dashed while it is only expected, solid in the ground truth;
 * an arrowhead at the end and its name halfway.
 */
export function enemyAxis(c: LL, path: Point[], text: string, dashed: boolean): Feature[] {
  if (path.length < 2) return [];
  const end = path[path.length - 1];
  // Arrowhead from a point about 60 m back along the path.
  let back = path[path.length - 2];
  for (let k = path.length - 2; k >= 0; k--) {
    back = path[k];
    if (Math.hypot(end.x - back.x, end.y - back.y) >= 60) break;
  }
  const d = unit(back, end);
  const n = perp(d);
  const head = [add(add(end, d, -60), n, 35), end, add(add(end, d, -60), n, -35)];
  return [
    line(c, path, { kind: 'axis', side: 'hostile', dashed }),
    line(c, head, { kind: 'axis', side: 'hostile', dashed: false }),
    label(c, path[Math.floor(path.length / 2)], text, { side: 'hostile' }),
  ];
}

/** An area (your platoon area, or the enemy's assembly area): an outline with its name inside. */
export function areaOutline(c: LL, pts: Point[], text: string, side: 'friend' | 'hostile', dashed = false): Feature[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return [line(c, [...pts, pts[0]], { kind: 'area', side, dashed }), label(c, { x: cx, y: cy }, text, { side, big: true })];
}

/** A round area of radius r (assembly area). */
export function roundArea(c: LL, p: Point, r: number, text: string, side: 'friend' | 'hostile'): Feature[] {
  const ring: Point[] = [];
  for (let k = 0; k < 36; k++) ring.push({ x: p.x + r * Math.cos((k * Math.PI) / 18), y: p.y + r * Math.sin((k * Math.PI) / 18) });
  return areaOutline(c, ring, text, side);
}
