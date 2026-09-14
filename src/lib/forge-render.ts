/* ────────────────────────────────────────────────────────────────────────────
   The Forge 3D viewport: projection, lighting and particles.

   Pulled out of the app component for one reason that is not tidiness — it
   runs at 60fps, and everything here has to be callable from a render loop
   that does not touch React state. The old viewport called setScene() from
   inside its draw function to advance physics, which meant every simulated
   frame re-rendered the whole app and tore down the loop's effect. This module
   is pure functions over plain data; the app hands it refs and gets pixels.

   The renderer is a software painter — sort by depth, draw back to front. No
   WebGL, deliberately: it adds zero bytes to an OS that has to boot fast, and
   it behaves identically on a phone. What it gives up is per-pixel shading,
   which at this fidelity nobody misses. What it keeps is real lighting: every
   face has a true normal and is lit by the actual light set, so moving a lamp
   changes the picture instead of changing a number.
   ──────────────────────────────────────────────────────────────────────────── */

export type Vec3 = [number, number, number];

/** The geometry this renderer needs from a part.
 *
 *  Declared structurally rather than imported from the Asset model on purpose:
 *  this module is pure maths over plain data, which is what lets it be tested
 *  without a DOM and reused by the asset thumbnails, the viewport and anything
 *  else that has to draw a pile of boxes. */
export interface RenderPart {
  position?: Vec3 | number[];
  scale?: Vec3 | number[];
  color?: string;
  emissive?: string;
}

export interface Light {
  id: string;
  name: string;
  /** A directional light shines FROM its position toward the origin. */
  kind: "directional" | "point";
  position: Vec3;
  color: string;
  intensity: number;
  range: number;
  on?: boolean;
}

export interface Emitter {
  id: string;
  name: string;
  position: Vec3;
  color: string;
  color2: string;
  rate: number;
  life: number;
  speed: number;
  spread: number;
  size: number;
  gravity: number;
  blend: "add" | "normal";
  on?: boolean;
}

export interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; emitter: number }

export interface Camera { yaw: number; pitch: number; zoom: number; panX: number; panY: number }

/* ── Colour ───────────────────────────────────────────────────────────────── */

export function hexToRgb(hex: string): [number, number, number] {
  let c = (hex || "#888888").replace("#", "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const n = parseInt(c, 16);
  return Number.isNaN(n) ? [136, 136, 136] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbCss = (r: number, g: number, b: number) =>
  `rgb(${Math.max(0, Math.min(255, r | 0))},${Math.max(0, Math.min(255, g | 0))},${Math.max(0, Math.min(255, b | 0))})`;

/** Lighten or darken a hex colour by a signed fraction. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbCss(r * (1 + amount), g * (1 + amount), b * (1 + amount));
}

/* ── Projection ───────────────────────────────────────────────────────────── */

export interface Projected { x: number; y: number; depth: number }

export function makeProjector(cam: Camera, w: number, h: number) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const halfW = w / 2 + cam.panX;
  const halfH = h / 2 + cam.panY;
  // Hoisted out of the per-vertex path: a busy scene projects tens of
  // thousands of points a frame, and four trig calls inside that loop is the
  // difference between a smooth orbit and a stuttering one.
  return (x: number, y: number, z: number): Projected => {
    const rx = x * cy - z * sy;
    const rz = x * sy + z * cy;
    return {
      x: rx * cam.zoom + halfW,
      y: (rz * cp - y) * cam.zoom * 0.62 + halfH,
      depth: rz * cp + y * sp,
    };
  };
}

/* ── Lighting ─────────────────────────────────────────────────────────────── */

/** The six axis-aligned face normals, in the order faces() emits them. */
const NORMALS: Vec3[] = [
  [0, 1, 0],   // top
  [0, 0, -1],  // back
  [1, 0, 0],   // right
  [0, 0, 1],   // front
  [-1, 0, 0],  // left
];

/** Accumulated light at a point, as an RGB multiplier.
 *
 *  Values above 1 are allowed and then clamped at the pixel — that is what
 *  lets a bright key light blow a surface out toward white instead of merely
 *  making it its own colour again. */
export function lightAt(normal: Vec3, px: number, py: number, pz: number, lights: Light[], ambient: number): [number, number, number] {
  let r = ambient, g = ambient, b = ambient;

  for (const l of lights) {
    if (l.on === false || l.intensity <= 0) continue;
    let lx: number, ly: number, lz: number, atten = 1;

    if (l.kind === "directional") {
      lx = l.position[0]; ly = l.position[1]; lz = l.position[2];
    } else {
      lx = l.position[0] - px; ly = l.position[1] - py; lz = l.position[2] - pz;
      const dist = Math.hypot(lx, ly, lz);
      const range = l.range || 12;
      // Inverse-square, softened. True 1/d² makes anything past the first
      // metre black, which looks broken rather than dramatic.
      atten = 1 / (1 + (dist / range) * (dist / range) * 3);
      if (atten < 0.004) continue;
    }

    const len = Math.hypot(lx, ly, lz) || 1;
    const ndl = (normal[0] * lx + normal[1] * ly + normal[2] * lz) / len;
    if (ndl <= 0) continue;

    const [cr, cg, cb] = hexToRgb(l.color);
    const k = ndl * l.intensity * atten;
    r += (cr / 255) * k;
    g += (cg / 255) * k;
    b += (cb / 255) * k;
  }
  return [r, g, b];
}

/* ── Particles ────────────────────────────────────────────────────────────── */

/** Advance the particle system one step and spawn from every live emitter.
 *
 *  Mutates `pool` in place and returns it: a system that allocates a new array
 *  sixty times a second is a system that stutters every few seconds when the
 *  collector runs. */
export function stepParticles(pool: Particle[], emitters: Emitter[], dt: number, budget = 1200): Particle[] {
  // Compact in place rather than filter(): same cost, no garbage.
  let write = 0;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    p.age += dt;
    if (p.age >= p.life) continue;
    p.vy += (emitters[p.emitter]?.gravity ?? 0) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    pool[write++] = p;
  }
  pool.length = write;

  emitters.forEach((e, index) => {
    if (e.on === false) return;
    const want = Math.min(e.rate * dt, 40);
    let n = Math.floor(want);
    if (Math.random() < want - n) n++;
    for (let i = 0; i < n && pool.length < budget; i++) {
      // Spread 0 is a vertical beam, 1 is the full sphere; lerping the cosine
      // keeps the distribution even instead of bunching at the pole.
      const theta = Math.random() * Math.PI * 2;
      const cosPhi = 1 - Math.random() * e.spread * 2;
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      const speed = e.speed * (0.6 + Math.random() * 0.8);
      pool.push({
        x: e.position[0], y: e.position[1], z: e.position[2],
        vx: Math.cos(theta) * sinPhi * speed,
        vy: cosPhi * speed,
        vz: Math.sin(theta) * sinPhi * speed,
        age: 0,
        life: e.life * (0.7 + Math.random() * 0.6),
        emitter: index,
      });
    }
  });

  return pool;
}

/* ── Geometry ─────────────────────────────────────────────────────────────── */

export interface Face { pts: Projected[]; depth: number; color: string; normal: Vec3; cx: number; cy: number; cz: number; emissive?: string }

/** Expand one part into its drawable faces.
 *
 *  Every primitive is drawn as a box here; the shape field is carried through
 *  to export, where a real engine will honour it. Approximating a sphere with
 *  its bounding box in the *editor* is a deliberate trade: layout, scale and
 *  lighting all read correctly, and it costs five quads instead of a few
 *  hundred triangles per object. */
export function partFaces(
  part: RenderPart,
  origin: Vec3,
  entityScale: Vec3,
  project: (x: number, y: number, z: number) => Projected,
): Face[] {
  const px = origin[0] + (part.position?.[0] ?? 0) * entityScale[0];
  const py = origin[1] + (part.position?.[1] ?? 0) * entityScale[1];
  const pz = origin[2] + (part.position?.[2] ?? 0) * entityScale[2];
  const s = part.scale ?? [1, 1, 1];
  const hx = (s[0] * entityScale[0]) / 2;
  const hy = (s[1] * entityScale[1]) / 2;
  const hz = (s[2] * entityScale[2]) / 2;

  const c: Vec3[] = [
    [px - hx, py - hy, pz - hz], [px + hx, py - hy, pz - hz], [px + hx, py - hy, pz + hz], [px - hx, py - hy, pz + hz],
    [px - hx, py + hy, pz - hz], [px + hx, py + hy, pz - hz], [px + hx, py + hy, pz + hz], [px - hx, py + hy, pz + hz],
  ];
  const proj = c.map(([x, y, z]) => project(x, y, z));
  const quads = [[4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

  return quads.map((idx, i) => {
    const pts = idx.map((j) => proj[j]);
    const cen = idx.reduce((a, j) => [a[0] + c[j][0], a[1] + c[j][1], a[2] + c[j][2]] as Vec3, [0, 0, 0] as Vec3);
    return {
      pts,
      depth: pts.reduce((a, p) => a + p.depth, 0) / 4,
      color: part.color ?? "#8b8b95",
      normal: NORMALS[i],
      cx: cen[0] / 4, cy: cen[1] / 4, cz: cen[2] / 4,
      emissive: part.emissive,
    };
  });
}
