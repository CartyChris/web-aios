/* ────────────────────────────────────────────────────────────────────────────
   Scene edits for Forge 3D and Asset Studio: snapping, aligning, duplicating,
   and cleaning up whatever parts a model sent back.

   PURE. Plain number tuples; no three.js, so every rule here is tested
   without a GPU. Rotation is deliberately ignored by the bounds maths — the
   honest result for a rotated part is an approximation, and the UI says so.
   ──────────────────────────────────────────────────────────────────────────── */

export type V3 = [number, number, number];

const clean = (n: number) => Math.round(n * 1e6) / 1e6 || 0; // never -0

export function snapValue(v: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(v)) return v;
  return clean(Math.round(v / step) * step);
}

export const snapVec = (v: V3, step: number): V3 => [snapValue(v[0], step), snapValue(v[1], step), snapValue(v[2], step)];

export interface PartLike {
  shape?: string;
  position?: number[];
  scale?: number[];
}

const at = (a: number[] | undefined, i: number, d: number) => {
  const n = a?.[i];
  return typeof n === "number" && Number.isFinite(n) ? n : d;
};

/** Lowest point of an entity in its own space, from its parts' unit boxes
 *  scaled. Every primitive the Forge draws fits a unit cube before scale. */
export function localMinY(parts: readonly PartLike[]): number {
  if (!parts.length) return 0;
  let min = Infinity;
  for (const p of parts) {
    const y = at(p.position, 1, 0);
    const h = Math.abs(at(p.scale, 1, 1) || 1);
    const half = p.shape === "plane" ? 0 : h / 2;
    min = Math.min(min, y - half);
  }
  return min;
}

/** The entity position that rests its lowest point on y = 0. */
export function dropToGround(position: V3, parts: readonly PartLike[], scale: V3): V3 {
  const sy = Math.abs(scale[1] || 1);
  return [position[0], clean(-localMinY(parts) * sy), position[2]];
}

/** Where a duplicate goes: `step` metres along +x from the original, pushed
 *  further until no other entity sits within `clearance` of the spot. */
export function duplicatePosition(from: V3, others: readonly V3[], step = 2, clearance = 0.75): V3 {
  for (let k = 1; k < 200; k++) {
    const cand: V3 = [clean(from[0] + step * k), from[1], from[2]];
    const busy = others.some((o) => Math.hypot(o[0] - cand[0], o[1] - cand[1], o[2] - cand[2]) < clearance);
    if (!busy) return cand;
  }
  return [clean(from[0] + step), from[1], from[2]];
}

export type AlignAxis = 0 | 1 | 2;

/** Put every listed position on the reference's coordinate for one axis. */
export function alignTo(positions: readonly V3[], reference: V3, axis: AlignAxis): V3[] {
  return positions.map((p) => {
    const n = [...p] as V3;
    n[axis] = reference[axis];
    return n;
  });
}

/* ── parts from a model ──────────────────────────────────────────────────── */

export const PART_SHAPES = ["box", "sphere", "cylinder", "cone", "plane", "capsule"] as const;
export type PartShape = (typeof PART_SHAPES)[number];

export interface CleanPart {
  id: string;
  name: string;
  shape: PartShape;
  position: V3;
  scale: V3;
  rotation?: V3;
  color?: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
}

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function vec(raw: unknown, d: V3, lim: number): V3 | null {
  if (raw === undefined) return d;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const n = Number(raw[i]);
    if (!Number.isFinite(n)) return null;
    out.push(clamp(n, -lim, lim));
  }
  return out as V3;
}

/**
 * Keep the parts that can be drawn, and say how many could not.
 *
 * A model that sends twelve parts with one NaN in the ninth should produce an
 * eleven-part asset and a note, not a thrown error and nothing. An unknown
 * shape becomes a box (it still occupies the space the model meant) rather
 * than being dropped.
 */
export function sanitizeParts(raw: unknown, maxParts = 200): { parts: CleanPart[]; dropped: number; reshaped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const parts: CleanPart[] = [];
  let dropped = 0;
  let reshaped = 0;
  list.forEach((item, i) => {
    if (parts.length >= maxParts || !item || typeof item !== "object") { dropped++; return; }
    const p = item as Record<string, unknown>;
    const position = vec(p.position, [0, 0, 0], 1000);
    const scale = vec(p.scale, [1, 1, 1], 1000);
    const rotation = p.rotation === undefined ? undefined : vec(p.rotation, [0, 0, 0], 3600);
    if (!position || !scale || rotation === null) { dropped++; return; }
    if (scale.some((s) => s === 0)) { dropped++; return; }
    let shape = String(p.shape ?? "box").toLowerCase() as PartShape;
    if (!PART_SHAPES.includes(shape)) { shape = "box"; reshaped++; }
    const part: CleanPart = {
      id: typeof p.id === "string" && p.id ? p.id.slice(0, 40) : `p${i}`,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 60) : `Part ${i + 1}`,
      shape, position, scale,
    };
    if (rotation) part.rotation = rotation;
    if (typeof p.color === "string" && HEX.test(p.color.trim())) part.color = p.color.trim().toLowerCase();
    if (typeof p.emissive === "string" && HEX.test(p.emissive.trim())) part.emissive = p.emissive.trim().toLowerCase();
    if (typeof p.roughness === "number" && Number.isFinite(p.roughness)) part.roughness = clamp(p.roughness, 0, 1);
    if (typeof p.metalness === "number" && Number.isFinite(p.metalness)) part.metalness = clamp(p.metalness, 0, 1);
    parts.push(part);
  });
  return { parts, dropped, reshaped };
}
