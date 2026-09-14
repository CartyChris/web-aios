import * as THREE from "three";

/* ────────────────────────────────────────────────────────────────────────────
   Primitive geometry for Forge 3D.

   Two rules make the whole scene format predictable for a model to write:

   1. Every primitive is normalised to fit exactly inside a 1×1×1 box centred
      on its own origin. So `scale: [2, 0.4, 3]` means "two metres wide, forty
      centimetres tall, three metres deep" for a sphere exactly as much as for
      a box. Without that, a model has to know that a cone's height is its
      `height` parameter but a capsule's is `length + 2 * radius`, and it
      will get it wrong.
   2. Geometries are built once and shared. A village with two hundred parts
      is two hundred meshes over a dozen geometries, not two hundred
      geometries — which is the difference between a scene that orbits at
      120fps and one that hitches every time you drag.

   `wedge` and `pyramid` are here because a roof is the single most common
   thing anyone asks for, and neither a box nor a cone is a roof.
   ──────────────────────────────────────────────────────────────────────────── */

export const SHAPES = [
  "box", "sphere", "cylinder", "cone", "plane", "capsule", "wedge", "pyramid", "torus",
] as const;

export type Shape = (typeof SHAPES)[number];

export const isShape = (s: unknown): s is Shape => SHAPES.includes(s as Shape);

/** A triangular prism: flat bottom, sloping up to a ridge along Z.
 *  Hand-built rather than extruded so the normals are exact and the whole
 *  thing is twelve triangles. */
function wedgeGeometry(): THREE.BufferGeometry {
  const h = 0.5;
  // Ridge runs along Z at the top centre; the base is the full unit square.
  const v = [
    [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], // base
    [0, h, -h], [0, h, h],                               // ridge
  ] as const;
  const tri = (a: number, b: number, c: number) => [...v[a], ...v[b], ...v[c]];
  const pos = [
    ...tri(0, 2, 1), ...tri(0, 3, 2),   // bottom
    ...tri(0, 1, 4),                     // front gable
    ...tri(3, 5, 2),                     // back gable — wound the other way
    ...tri(1, 2, 5), ...tri(1, 5, 4),   // right slope
    ...tri(0, 4, 5), ...tri(0, 5, 3),   // left slope
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Build one primitive, normalised into the unit cube. */
function build(shape: Shape): THREE.BufferGeometry {
  switch (shape) {
    case "box":
      return new THREE.BoxGeometry(1, 1, 1);
    case "sphere":
      return new THREE.SphereGeometry(0.5, 32, 20);
    case "cylinder":
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
    case "cone":
      return new THREE.ConeGeometry(0.5, 1, 28);
    case "pyramid":
      // Four radial segments is a square pyramid; the quarter turn puts its
      // faces square to the axes instead of its corners.
      return new THREE.ConeGeometry(0.707, 1, 4).rotateY(Math.PI / 4);
    case "plane":
      // Laid flat, so a "plane" is ground rather than a wall standing on edge.
      return new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    case "capsule": {
      // Total height is length + 2r = 2; halve it so the bounds are unit.
      const g = new THREE.CapsuleGeometry(0.5, 1, 6, 20);
      g.scale(1, 0.5, 1);
      return g;
    }
    case "torus": {
      // Ring radius 0.35 + tube 0.15 = 0.5 fills X and Y, but the tube is only
      // 0.3 deep — so Z is stretched to fill the unit box like everything
      // else. That is what makes `scale: [0.6, 0.6, 0.12]` mean a 0.6m ring
      // 12cm thick rather than 3.6cm, and keeps one rule for every primitive.
      const g = new THREE.TorusGeometry(0.35, 0.15, 14, 40);
      g.scale(1, 1, 1 / 0.3);
      return g;
    }
    case "wedge":
      return wedgeGeometry();
  }
}

const cache = new Map<Shape, THREE.BufferGeometry>();

/** The shared geometry for a shape. Never dispose these — they outlive scenes. */
export function geometryFor(shape: string): THREE.BufferGeometry {
  const key: Shape = isShape(shape) ? shape : "box";
  let g = cache.get(key);
  if (!g) {
    g = build(key);
    cache.set(key, g);
  }
  return g;
}

/** Every geometry this module can hand out, for tests and teardown. */
export function __allGeometries(): Shape[] {
  return [...SHAPES];
}
