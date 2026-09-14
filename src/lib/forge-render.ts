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
