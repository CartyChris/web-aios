/**
 * The 3D scene layer, after the move to WebGL.
 *
 * Two things here fail silently and are therefore worth asserting. The
 * geometry contract — every primitive normalised into a unit cube — is what
 * lets a model write "scale: [2, 0.4, 3]" and mean metres for a sphere as much
 * as for a box; if a cone quietly came out twice as tall as its scale, nothing
 * would error, scenes would just be subtly wrong forever. And the coercion of
 * model output is what stands between a described village and fourteen objects
 * stacked invisibly at the origin, which is exactly what shipped before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { geometryFor, SHAPES, isShape } from "../.test-build/forge-geometry.js";
import { buildEntity, buildLight, buildScene, framingFor } from "../.test-build/forge-scene.js";
import { num, vec3, stackedCount, spreadOverlapping, extractJson, FORGE_KINDS } from "../.test-build/forge-schema.js";

/* ── The geometry contract ─────────────────────────────────────────────── */

test("every primitive fits exactly inside the unit cube", () => {
  for (const shape of SHAPES) {
    const g = geometryFor(shape);
    g.computeBoundingBox();
    const b = g.boundingBox;
    const size = b.getSize(new THREE.Vector3());
    // A plane is legitimately flat in Y; everything else must fill all three.
    const axes = shape === "plane" ? ["x", "z"] : ["x", "y", "z"];
    for (const a of axes) {
      assert.ok(Math.abs(size[a] - 1) < 0.03, `${shape} ${a} should be 1, got ${size[a].toFixed(3)}`);
    }
    const centre = b.getCenter(new THREE.Vector3());
    for (const a of ["x", "y", "z"]) {
      assert.ok(Math.abs(centre[a]) < 0.03, `${shape} should be centred on ${a}, got ${centre[a].toFixed(3)}`);
    }
  }
});

test("geometries are shared, not rebuilt per mesh", () => {
  // A village is hundreds of meshes over a dozen geometries. Rebuilding per
  // mesh is the difference between a smooth orbit and a stuttering one.
  assert.equal(geometryFor("box"), geometryFor("box"));
  assert.notEqual(geometryFor("box"), geometryFor("sphere"));
});

test("an unknown shape falls back to a box instead of rendering nothing", () => {
  assert.equal(isShape("dodecahedron"), false);
  assert.equal(geometryFor("dodecahedron"), geometryFor("box"));
});

test("the wedge is a closed prism with a ridge at the top", () => {
  const g = geometryFor("wedge");
  const pos = g.getAttribute("position");
  assert.equal(pos.count % 3, 0, "must be whole triangles");
  let top = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.49) top++;
  assert.ok(top > 0, "a wedge needs vertices at the ridge");
  // The ridge is a line, not a face: every top vertex sits on x = 0.
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0.49) assert.ok(Math.abs(pos.getX(i)) < 0.01, "the ridge must run along Z at x=0");
  }
});

/* ── Building the graph ────────────────────────────────────────────────── */

const entity = (over = {}) => ({
  id: "e1", name: "Thing", position: [3, 0, -4], rotation: [0, 90, 0], scale: [1, 1, 1], visible: true,
  parts: [{ name: "Body", shape: "box", position: [0, 1, 0], scale: [2, 2, 2], color: "#ff0000" }],
  ...over,
});

test("an entity lands where its position says, not at the origin", () => {
  const g = buildEntity(entity());
  assert.deepEqual([g.position.x, g.position.y, g.position.z], [3, 0, -4]);
});

test("rotations in the document are degrees, not radians", () => {
  const g = buildEntity(entity({ rotation: [0, 90, 0] }));
  assert.ok(Math.abs(g.rotation.y - Math.PI / 2) < 1e-6, `90 degrees should be π/2, got ${g.rotation.y}`);
});

test("a part's scale is its size in metres for every shape", () => {
  const g = buildEntity(entity({
    parts: [{ name: "Pole", shape: "cylinder", position: [0, 2, 0], scale: [0.3, 4, 0.3] }],
  }));
  const box = new THREE.Box3().setFromObject(g);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.y - 4) < 0.05, `a 4m pole should be 4m tall, got ${size.y.toFixed(2)}`);
  assert.ok(Math.abs(size.x - 0.3) < 0.05, `and 0.3m wide, got ${size.x.toFixed(2)}`);
});

test("a zero scale is treated as unset rather than rendering nothing", () => {
  const g = buildEntity(entity({ parts: [{ name: "X", shape: "box", position: [0, 0, 0], scale: [0, 0, 0] }] }));
  assert.deepEqual([g.children[0].scale.x, g.children[0].scale.y, g.children[0].scale.z], [1, 1, 1]);
});

test("opacity below 1 turns on transparency; 1 leaves it off", () => {
  const glass = buildEntity(entity({ parts: [{ name: "G", shape: "box", opacity: 0.3 }] }));
  const solid = buildEntity(entity({ parts: [{ name: "S", shape: "box" }] }));
  assert.equal(glass.children[0].material.transparent, true);
  assert.equal(solid.children[0].material.transparent, false);
});

test("a nonsense colour falls back instead of throwing the scene away", () => {
  const g = buildEntity(entity({ parts: [{ name: "X", shape: "box", color: "not a colour" }] }));
  // `.isColor` rather than instanceof: the module under test and this file can
  // resolve to different three instances, and instanceof is false across them
  // even though both objects are perfectly good Colors.
  assert.ok(g.children[0].material.color?.isColor, "a bad colour must still yield a usable material");
});

test("parts cast and receive shadows — that is what puts them on the ground", () => {
  const g = buildEntity(entity());
  assert.equal(g.children[0].castShadow, true);
  assert.equal(g.children[0].receiveShadow, true);
});

test("a directional light is pushed out along its direction and casts shadows", () => {
  const l = buildLight({ id: "k", name: "k", kind: "directional", position: [-1, 2, 1], color: "#ffffff", intensity: 1, range: 0 });
  assert.ok(l.isDirectionalLight);
  assert.equal(l.castShadow, true);
  // The document gives a direction; the light has to sit far enough out for
  // its shadow frustum to cover the scene.
  assert.ok(l.position.length() > 50, `expected it pushed out, got ${l.position.length().toFixed(1)}`);
  assert.ok(l.position.x < 0 && l.position.y > 0, "direction must be preserved");
});

test("a disabled light builds nothing at all", () => {
  assert.equal(buildLight({ id: "x", name: "x", kind: "point", position: [0, 1, 0], color: "#fff", intensity: 1, range: 4, on: false }), null);
});

test("a scene builds entities, lights and one particle field per live emitter", () => {
  const built = buildScene({
    entities: [entity(), entity({ id: "e2", position: [10, 0, 10] })],
    lights: [{ id: "k", name: "k", kind: "directional", position: [0, 1, 0], color: "#fff", intensity: 1, range: 0 }],
    fx: [
      { id: "f1", name: "fire", position: [0, 0, 0], color: "#f80", color2: "#000", rate: 10, life: 1, speed: 1, spread: 0.3, size: 0.1, gravity: 1, blend: "add" },
      { id: "f2", name: "off", position: [0, 0, 0], color: "#f80", color2: "#000", rate: 10, life: 1, speed: 1, spread: 0.3, size: 0.1, gravity: 1, blend: "add", on: false },
    ],
    ambient: 0.4, sky: "#88aaff",
  });
  assert.equal(built.entities.children.length, 2);
  // One hemisphere for ambient plus the declared directional.
  assert.equal(built.lights.children.length, 2);
  assert.equal(built.fields.length, 1, "a disabled emitter should not become a field");
});

test("the camera frames the content, not a huge ground plane", () => {
  const ground = {
    id: "g", name: "Ground", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true,
    parts: [{ name: "Grass", shape: "plane", position: [0, 0, 0], scale: [200, 1, 200] }],
  };
  const hut = entity({ id: "h", position: [2, 0, 2] });
  const withGround = buildScene({ entities: [ground, hut, entity({ id: "h2", position: [-2, 0, -2] })], lights: [], fx: [], ambient: 0.3, sky: "#fff" });

  const framedAll = framingFor(withGround.bounds).distance;
  const framedFocus = framingFor(withGround.focus).distance;
  // Framing the full bounds would put the village a few pixels across.
  assert.ok(framedFocus < framedAll / 4, `focus ${framedFocus.toFixed(1)} should be far closer than all ${framedAll.toFixed(1)}`);
});

test("a scene that is only terrain still frames the terrain", () => {
  const ground = {
    id: "g", name: "Ground", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true,
    parts: [{ name: "Grass", shape: "plane", position: [0, 0, 0], scale: [80, 1, 80] }],
  };
  const built = buildScene({ entities: [ground], lights: [], fx: [], ambient: 0.3, sky: "#fff" });
  assert.ok(framingFor(built.focus).distance > 20, "excluding the only object would frame nothing");
});

/* ── Coercion: the bug that stacked everything at the origin ───────────── */

test("numbers written as strings are still numbers", () => {
  assert.equal(num("12.5", 0), 12.5);
  assert.equal(num(" -3 ", 0), -3);
  assert.equal(num("banana", 7), 7);
  assert.equal(num(undefined, 7), 7);
  assert.equal(num(NaN, 7), 7);
});

test("a vector of numeric strings is not silently discarded", () => {
  // This is the exact shape that used to fail the old Array.every(isFinite)
  // check and default every object to the origin.
  assert.deepEqual(vec3(["12", "0", "-8"], [0, 0, 0]), [12, 0, -8]);
  assert.deepEqual(vec3([4, 2, 9], [0, 0, 0]), [4, 2, 9]);
});

test("an {x,y,z} object is accepted as a vector", () => {
  assert.deepEqual(vec3({ x: 1, y: 2, z: 3 }, [0, 0, 0]), [1, 2, 3]);
});

test("a garbage vector falls back rather than producing NaN geometry", () => {
  assert.deepEqual(vec3("nope", [1, 1, 1]), [1, 1, 1]);
  assert.deepEqual(vec3(null, [1, 1, 1]), [1, 1, 1]);
});

test("stacked entities are detected", () => {
  // The reported failure: fourteen objects, every one at the origin.
  const heap = Array.from({ length: 14 }, () => [0, 0, 0]);
  assert.equal(stackedCount(heap), 14);
  const spread = [[0, 0, 0], [10, 0, 0], [0, 0, 10]];
  assert.equal(stackedCount(spread), 0);
});

test("stacked entities are spread onto a ring rather than left invisible", () => {
  const heap = Array.from({ length: 8 }, () => [0, 0, 0]);
  const out = spreadOverlapping(heap);
  assert.equal(out.length, 8);
  assert.equal(stackedCount(out), 0, "the rescue must actually separate them");
  // The first one keeps its place; only the collisions move.
  assert.deepEqual(out[0], [0, 0, 0]);
});

test("a scene that was already well placed is left exactly alone", () => {
  const good = [[0, 0, 0], [12, 0, -4], [-8, 0, 9]];
  assert.deepEqual(spreadOverlapping(good), good);
});

/* ── The briefs ────────────────────────────────────────────────────────── */

test("every brief defines the entity shape, including its position", () => {
  // The map brief used to say "entities: [ ...entities... ]" and never define
  // what an entity was, so no model ever wrote a position and every scene came
  // back as one heap. Any brief that can return entities must spell it out.
  for (const kind of FORGE_KINDS) {
    if (!/entities/.test(kind.brief)) continue;
    assert.match(kind.brief, /"position": \[x, y, z\]/, `${kind.id} must define an entity position`);
    assert.match(kind.brief, /WHERE IT STANDS IN THE WORLD|its own distinct "position"|own "position"/, `${kind.id} must say the position is the world placement`);
  }
});

test("every brief that offers rotation states it is in degrees", () => {
  for (const kind of FORGE_KINDS) {
    // Particle emitters have no rotation, so nothing to say.
    if (!/"rotation"/.test(kind.brief)) continue;
    assert.match(kind.brief, /DEGREES/, `${kind.id} must say degrees — radians come back wrong every time`);
  }
});

test("the briefs offer the shapes the geometry layer can actually build", () => {
  for (const kind of FORGE_KINDS) {
    const offered = [...kind.brief.matchAll(/"(box|sphere|cylinder|cone|pyramid|wedge|capsule|torus|plane)"/g)].map((m) => m[1]);
    for (const shape of new Set(offered)) {
      assert.ok(SHAPES.includes(shape), `${kind.id} offers "${shape}" which the renderer cannot build`);
    }
  }
});

test("extractJson still survives the prose models wrap around it", () => {
  assert.deepEqual(extractJson('Here you go!\n```json\n{"entities":[]}\n```\nEnjoy.'), { entities: [] });
});
