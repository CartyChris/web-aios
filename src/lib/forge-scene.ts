import * as THREE from "three";
import { geometryFor } from "./forge-geometry";
import { stepParticles, type Emitter, type Particle, type Light, type Vec3 } from "./forge-render";

/* ────────────────────────────────────────────────────────────────────────────
   Turning the scene document into a three.js scene graph.

   Forge used to draw with a software painter: project every face, sort by
   average depth, fill back to front. That is fine for a handful of boxes and
   wrong the moment a scene has a large flat surface — a ground plane's
   centroid can be further away than a river lying on top of it, so the ground
   gets painted last and the river vanishes. Which is exactly what happened,
   and only from some camera angles, because it depends entirely on where the
   centroids land. No amount of tuning fixes that; a per-pixel depth test does,
   and that is what the GPU is for.

   Moving to WebGL also ends the other complaint. Every primitive is now the
   shape it says it is instead of its bounding box, parts can rotate, materials
   are real PBR with roughness and metalness, and there are shadows — so a
   generated village reads as a place rather than as a pile of cubes.

   This module builds and updates the graph. It is deliberately free of React
   and of any canvas: given a scene document it returns objects, which makes
   the whole thing testable in Node without a GL context.
   ──────────────────────────────────────────────────────────────────────────── */

const DEG = Math.PI / 180;

export interface ScenePart {
  id?: string;
  name?: string;
  shape?: string;
  position?: number[];
  rotation?: number[];
  scale?: number[];
  color?: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  /** 0-1; anything below 1 turns on transparency. Glass, water, ghosts. */
  opacity?: number;
}

export interface SceneEntity {
  id: string;
  name: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  parts: ScenePart[];
}

export interface SceneDoc {
  entities: SceneEntity[];
  lights: Light[];
  fx: Emitter[];
  ambient: number;
  sky: string;
  /** Distance fog, which is most of what makes a large scene feel large. */
  fog?: number;
}

/* ── Materials ────────────────────────────────────────────────────────────── */

/** Materials are cached on their own description.
 *
 *  A generated village has two hundred parts and maybe fifteen distinct
 *  materials; building one per part costs a shader compile each and stutters
 *  the first frame after every generation. */
const materials = new Map<string, THREE.MeshStandardMaterial>();

function materialFor(p: ScenePart): THREE.MeshStandardMaterial {
  const color = p.color ?? "#8b8b95";
  const rough = clamp(p.roughness ?? 0.72, 0, 1);
  const metal = clamp(p.metalness ?? 0.05, 0, 1);
  const emissive = p.emissive ?? "";
  const opacity = clamp(p.opacity ?? 1, 0.02, 1);
  const key = `${color}|${rough}|${metal}|${emissive}|${opacity}`;

  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: safeColor(color, 0x8b8b95),
      roughness: rough,
      metalness: metal,
      transparent: opacity < 1,
      opacity,
      // Generated geometry is not reliably wound consistently, and a model
      // that writes a negative scale flips a face inside out. Drawing both
      // sides costs nothing here and avoids holes in things.
      side: THREE.DoubleSide,
    });
    if (emissive) {
      m.emissive = safeColor(emissive, 0x000000);
      m.emissiveIntensity = 1.1;
    }
    materials.set(key, m);
  }
  return m;
}

function safeColor(value: string, fallback: number): THREE.Color {
  try {
    return new THREE.Color(value);
  } catch {
    return new THREE.Color(fallback);
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const v3 = (a: number[] | undefined, d: Vec3): Vec3 =>
  Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n)) ? (a as Vec3) : d;

/* ── Entities ─────────────────────────────────────────────────────────────── */

/** One entity as a group of meshes.
 *
 *  Rotations in the document are DEGREES. Models are markedly better at "45"
 *  than at "0.7853981633974483", and every one of them will eventually write
 *  90 meaning a quarter turn. */
export function buildEntity(entity: SceneEntity): THREE.Group {
  const group = new THREE.Group();
  group.name = entity.name;
  group.userData.entityId = entity.id;

  const pos = v3(entity.position, [0, 0, 0]);
  const rot = v3(entity.rotation, [0, 0, 0]);
  const scl = v3(entity.scale, [1, 1, 1]);
  group.position.set(pos[0], pos[1], pos[2]);
  group.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);
  group.scale.set(scl[0] || 1, scl[1] || 1, scl[2] || 1);
  group.visible = entity.visible !== false;

  for (const part of entity.parts ?? []) {
    const mesh = new THREE.Mesh(geometryFor(part.shape ?? "box"), materialFor(part));
    const pp = v3(part.position, [0, 0, 0]);
    const pr = v3(part.rotation, [0, 0, 0]);
    const ps = v3(part.scale, [1, 1, 1]);
    mesh.position.set(pp[0], pp[1], pp[2]);
    mesh.rotation.set(pr[0] * DEG, pr[1] * DEG, pr[2] * DEG);
    // A zero scale renders nothing and breaks normals; treat it as "unset".
    mesh.scale.set(ps[0] || 1, ps[1] || 1, ps[2] || 1);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = part.name ?? "part";
    group.add(mesh);
  }
  return group;
}

/* ── Lights ───────────────────────────────────────────────────────────────── */

export function buildLight(light: Light): THREE.Light | null {
  if (light.on === false) return null;
  const color = safeColor(light.color ?? "#ffffff", 0xffffff);
  const intensity = clamp(light.intensity ?? 1, 0, 8);
  const p = v3(light.position as number[], [0, 5, 0]);

  if (light.kind === "point") {
    const l = new THREE.PointLight(color, intensity * 6, clamp(light.range || 14, 0.5, 400), 1.6);
    l.position.set(p[0], p[1], p[2]);
    l.castShadow = false; // six shadow maps per lamp is not worth it here
    return l;
  }

  const l = new THREE.DirectionalLight(color, intensity);
  // A directional light's position is a DIRECTION in the document, so push it
  // far enough out that its shadow frustum covers the whole scene.
  const len = Math.hypot(p[0], p[1], p[2]) || 1;
  l.position.set((p[0] / len) * 60, (p[1] / len) * 60, (p[2] / len) * 60);
  l.castShadow = true;
  l.shadow.mapSize.set(2048, 2048);
  l.shadow.bias = -0.0009;
  l.shadow.normalBias = 0.02;
  const cam = l.shadow.camera;
  cam.near = 1;
  cam.far = 200;
  cam.left = -45; cam.right = 45; cam.top = 45; cam.bottom = -45;
  cam.updateProjectionMatrix();
  return l;
}

/* ── Particles ────────────────────────────────────────────────────────────── */

/** One Points object per emitter, so each keeps its own blend mode and size.
 *  Positions and colours live in buffers that are rewritten in place each
 *  frame — allocating per frame is what makes particle systems stutter. */
export class ParticleField {
  readonly object = new THREE.Points();
  private pool: Particle[] = [];
  private positions: Float32Array;
  private colors: Float32Array;
  private alphas: Float32Array;
  private geometry = new THREE.BufferGeometry();
  private capacity: number;

  constructor(private emitter: Emitter, capacity = 600) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.alphas = new Float32Array(capacity);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute("alpha", new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, 0);

    const material = new THREE.PointsMaterial({
      size: Math.max(0.02, emitter.size ?? 0.12) * 2,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: emitter.blend === "add" ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
      opacity: emitter.blend === "add" ? 0.9 : 0.75,
    });
    this.object.geometry = this.geometry;
    this.object.material = material;
    this.object.frustumCulled = false;
  }

  update(emitter: Emitter, dt: number) {
    this.emitter = emitter;
    stepParticles(this.pool, [emitter], dt, this.capacity);
    const from = new THREE.Color(emitter.color ?? "#ffb347");
    const to = new THREE.Color(emitter.color2 ?? "#000000");
    const c = new THREE.Color();
    const n = Math.min(this.pool.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const p = this.pool[i];
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
      const t = Math.min(1, p.age / p.life);
      c.copy(from).lerp(to, t);
      // Fade by dimming the colour: PointsMaterial has one opacity for the
      // whole system, so per-particle fade has to live in the colour.
      const fade = 1 - t;
      this.colors[i * 3] = c.r * fade;
      this.colors[i * 3 + 1] = c.g * fade;
      this.colors[i * 3 + 2] = c.b * fade;
      this.alphas[i] = fade;
    }
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    (this.object.material as THREE.PointsMaterial).size = Math.max(0.02, emitter.size ?? 0.12) * 2;
    this.geometry.computeBoundingSphere();
  }

  get count() { return this.pool.length; }

  dispose() {
    this.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

/* ── Whole scene ──────────────────────────────────────────────────────────── */

export interface BuiltScene {
  root: THREE.Group;
  entities: THREE.Group;
  lights: THREE.Group;
  fields: ParticleField[];
  /** World-space bounds of everything. */
  bounds: THREE.Box3;
  /** Bounds of everything except the terrain, which is what the camera should
   *  actually frame. */
  focus: THREE.Box3;
}

/** Build the whole graph in one pass.
 *
 *  Rebuild-on-change rather than diffing: a scene is a few hundred meshes over
 *  shared geometry and cached materials, so a rebuild is well under a
 *  millisecond, and a diff would be a subtle cache-invalidation bug waiting
 *  for the first person who edits a part's shape. */
export function buildScene(doc: SceneDoc): BuiltScene {
  const root = new THREE.Group();
  const entities = new THREE.Group();
  const lights = new THREE.Group();
  entities.name = "entities";
  lights.name = "lights";

  for (const e of doc.entities ?? []) entities.add(buildEntity(e));

  // Ambient is a hemisphere rather than a flat fill: a sky-coloured top and a
  // ground-coloured bounce is what stops an unlit face reading as dead grey.
  const amb = clamp(doc.ambient ?? 0.32, 0, 1);
  const hemi = new THREE.HemisphereLight(safeColor(doc.sky ?? "#8fb8ff", 0x8fb8ff), 0x40383a, amb * 2.2);
  lights.add(hemi);
  for (const l of doc.lights ?? []) {
    const built = buildLight(l);
    if (built) lights.add(built);
  }

  root.add(entities, lights);

  const fields = (doc.fx ?? []).filter((f) => f.on !== false).map((f) => new ParticleField(f));
  for (const f of fields) root.add(f.object);

  const bounds = new THREE.Box3();
  if (entities.children.length) bounds.setFromObject(entities);

  return { root, entities, lights, fields, bounds, focus: focusBounds(entities, bounds) };
}

/** What the camera should frame.
 *
 *  Not the whole scene: a sixty-metre ground plane is most of the bounding box
 *  and none of the subject, so framing everything shows a village the size of a
 *  postage stamp in an ocean of grass. Anything essentially flat and much wider
 *  than the rest is terrain, and terrain is excluded — unless it is all there
 *  is, in which case it is the subject after all. */
function focusBounds(entities: THREE.Group, all: THREE.Box3): THREE.Box3 {
  const boxes = entities.children.map((c) => new THREE.Box3().setFromObject(c));
  if (boxes.length < 2) return all;

  const size = new THREE.Vector3();
  const footprints = boxes.map((b) => { b.getSize(size); return Math.max(size.x, size.z); });
  const median = [...footprints].sort((a, b) => a - b)[Math.floor(footprints.length / 2)] || 1;

  const focus = new THREE.Box3();
  boxes.forEach((b, i) => {
    b.getSize(size);
    const flat = size.y < Math.max(size.x, size.z) * 0.08;
    const huge = footprints[i] > median * 3;
    if (flat && huge) return;
    focus.union(b);
  });
  return focus.isEmpty() ? all : focus;
}

/** Free everything a built scene owns. Geometry and materials are shared and
 *  deliberately not touched. */
export function disposeScene(built: BuiltScene) {
  for (const f of built.fields) f.dispose();
  built.root.clear();
}

/** A camera framing that fits the whole scene, used on load and by Reset view. */
export function framingFor(bounds: THREE.Box3): { target: THREE.Vector3; distance: number } {
  if (bounds.isEmpty()) return { target: new THREE.Vector3(0, 1, 0), distance: 18 };
  const size = bounds.getSize(new THREE.Vector3());
  const target = bounds.getCenter(new THREE.Vector3());
  // Aim a little above centre: a scene framed on its exact middle puts the
  // horizon through the middle of the frame, which reads as a diagram.
  target.y = Math.min(target.y, bounds.min.y + size.y * 0.42);
  const radius = Math.max(size.x, size.y, size.z, 2) * 0.5;
  return { target, distance: radius * 2.4 + 3 };
}
