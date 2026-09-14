/* ────────────────────────────────────────────────────────────────────────────
   The contract between a model and the 3D scene.

   Kept out of the app file because three surfaces need it — Forge 3D builds
   from it, Asset Studio builds a subset of it, and the vision reviewer has to
   be told the same shapes it is looking at.

   Everything here is written the way it is because of how these briefs
   actually fail:

   - A brief that says `"entities": [ ...entities... ]` without ever defining
     what an entity *is* produces a scene where every object sits at the
     origin, stacked invisibly inside itself. The model was never told an
     entity has a position, so it never wrote one. Every return shape below is
     therefore written out in full, with a worked example carrying real
     numbers.
   - Radians produce wrong rotations and degrees do not. Models write 90 when
     they mean a quarter turn.
   - A model given only "box" builds everything out of boxes. Given a wedge and
     a pyramid it builds roofs.
   ──────────────────────────────────────────────────────────────────────────── */

export const SHAPES = [
  "box", "sphere", "cylinder", "cone", "pyramid", "wedge", "capsule", "torus", "plane",
] as const;

export const PART_SCHEMA = `A "part" is one primitive:
  { "name": string,
    "shape": "box" | "sphere" | "cylinder" | "cone" | "pyramid" | "wedge" | "capsule" | "torus" | "plane",
    "position": [x, y, z],     // metres, relative to the object's own origin
    "rotation": [x, y, z],     // DEGREES. Omit for no rotation.
    "scale": [x, y, z],        // the part's SIZE in metres along each axis
    "color": "#rrggbb",
    "roughness": 0..1,         // 0 = mirror, 1 = chalk. Default 0.72
    "metalness": 0..1,         // metal or not. There is no in between in reality
    "emissive": "#rrggbb",     // only for things that GLOW — lamps, embers, screens
    "opacity": 0..1 }          // below 1 for glass, water, ghosts

"scale" is the size of the part's bounding box, for every shape. A sphere with
scale [2,2,2] is two metres across. A cylinder with scale [0.3, 4, 0.3] is a
four-metre pole. You never have to reason about radii.

Shape notes:
- "wedge" is a triangular prism — flat bottom rising to a ridge along Z. This is
  a pitched roof. Rotate it 90° about Y to run the ridge the other way.
- "pyramid" is a square pyramid — a spire, a tent, a hip roof.
- "plane" is a flat sheet lying horizontally. Ground, water, a rug.
- "capsule" is a rounded cylinder — limbs, bollards, soft shapes.`;

export const PHYSICS_SCHEMA = `"physics": {
  "bodyType": "static" | "dynamic" | "kinematic",
  "collider": "box" | "sphere" | "capsule" | "mesh" | "none",
  "mass": number, "friction": 0..1, "restitution": 0..1, "solid": boolean }`;

export const ENTITY_SCHEMA = `An "entity" is one object, made of parts, placed in the world:
  { "name": string,
    "position": [x, y, z],     // WHERE IT STANDS IN THE WORLD, in metres
    "rotation": [x, y, z],     // DEGREES, usually just a Y turn
    "scale": [1, 1, 1],        // leave at 1 unless you mean to resize the whole object
    "parts": [ ...parts... ],
    "physics": { ... } }

A part's position is relative to its entity. An entity's position is absolute.
THIS IS THE FIELD THAT MATTERS MOST: if every entity has position [0,0,0] they
all end up in one heap at the origin, inside each other, and the scene is
ruined. Give every entity its own place.`;

export const CRAFT = `What separates a scene worth keeping from a pile of boxes:

SILHOUETTE FIRST. An object has to be recognisable from its outline at a
distance. Get the big masses right, then add detail.

PROPORTION IS REAL METRES. A person is 1.8 tall. A door is 2.1. A chair seat is
0.45. A street lamp is 4.5. A single-storey cottage is about 6 × 5 × 3 with a
roof on top. Get one of these wrong and the whole scene reads as a toy.

DETAIL HIERARCHY. Three scales of detail: the mass (walls, roof), the features
(door, windows, chimney), the trim (sill, beam, handle, sign). An object with
only the first is a crate. Twelve to thirty parts for anything important.

BREAK SYMMETRY. Real things are not mirror-perfect. Offset a window, tilt a
sign two degrees, make one shutter hang open. Rotation is how you do this and
it costs nothing.

COLOUR WITH INTENT. Pick three or four colours and vary them in value, not hue —
a wall, its shadowed side and its trim are three shades of one colour, not three
different colours. Then one accent that appears two or three times. A scene where
everything is a different pastel is the single most common failure.

MATERIALS CARRY MEANING. Wood is roughness 0.85, metalness 0. Painted metal is
roughness 0.35, metalness 0.9. Glass is opacity 0.25, roughness 0.05. Water is
opacity 0.75, roughness 0.15, metalness 0.4. Anything that emits light needs
"emissive" — it will otherwise read as a grey box in the dark.

NOTHING FLOATS AND NOTHING SINKS. +Y is up and the ground is y = 0. An entity's
position sits on the ground; its parts are built upward from there. A part at
y = 0.5 with scale 1 has its bottom exactly on the ground.`;

export interface ForgeKind {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  brief: string;
  placeholder: string;
}

const WORKED_EXAMPLE = `Worked example — a lamp post, so you can see the numbers:
{ "entities": [ {
  "name": "Iron lamp post",
  "position": [4, 0, -2],
  "rotation": [0, 15, 0],
  "scale": [1, 1, 1],
  "parts": [
    { "name": "Base",    "shape": "cylinder", "position": [0, 0.12, 0], "scale": [0.42, 0.24, 0.42], "color": "#2b2f36", "roughness": 0.5, "metalness": 0.85 },
    { "name": "Column",  "shape": "cylinder", "position": [0, 2.1, 0],  "scale": [0.14, 4.0, 0.14],  "color": "#343a43", "roughness": 0.45, "metalness": 0.9 },
    { "name": "Collar",  "shape": "torus",    "position": [0, 3.6, 0],  "rotation": [90, 0, 0], "scale": [0.3, 0.3, 0.12], "color": "#2b2f36", "roughness": 0.5, "metalness": 0.85 },
    { "name": "Arm",     "shape": "box",      "position": [0.35, 4.2, 0], "rotation": [0, 0, -18], "scale": [0.8, 0.09, 0.09], "color": "#343a43", "roughness": 0.45, "metalness": 0.9 },
    { "name": "Housing", "shape": "cone",     "position": [0.68, 4.3, 0], "rotation": [180, 0, 0], "scale": [0.46, 0.4, 0.46], "color": "#2b2f36", "roughness": 0.5, "metalness": 0.85 },
    { "name": "Bulb",    "shape": "sphere",   "position": [0.68, 4.08, 0], "scale": [0.26, 0.26, 0.26], "color": "#ffe9b0", "emissive": "#ffcf70", "roughness": 0.3 }
  ],
  "physics": { "bodyType": "static", "collider": "capsule", "mass": 0, "friction": 0.8, "restitution": 0, "solid": true }
} ] }

Note what that example does: real metres, a rotation to break symmetry, three
values of one dark metal plus one warm accent, a cone flipped 180° to become a
shade, and an emissive bulb so it actually reads as a light.`;

const OBJECT_RETURN = `Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "entities": [ <one entity> ] }`;

export const FORGE_KINDS: ForgeKind[] = [
  {
    id: "asset",
    name: "Asset",
    icon: "assetstudio",
    blurb: "A prop, a piece of set dressing, a building.",
    placeholder: "a weathered wooden watchtower with a ladder and a hanging lantern",
    brief: `Build ONE object out of primitive parts, to the standard of a hand-modelled game asset.

${PART_SCHEMA}

${ENTITY_SCHEMA}

${PHYSICS_SCHEMA}

${CRAFT}

Use 12 to 30 parts. Fewer than 12 and it will read as a placeholder.

${WORKED_EXAMPLE}

${OBJECT_RETURN}`,
  },
  {
    id: "npc",
    name: "NPC",
    icon: "agents",
    blurb: "A character with a readable silhouette and a role.",
    placeholder: "a hooded market trader with a heavy satchel and a walking staff",
    brief: `Build ONE humanoid character out of primitive parts.

${PART_SCHEMA}

${ENTITY_SCHEMA}

${PHYSICS_SCHEMA}

${CRAFT}

Character rules:
- About 1.8 metres tall, standing on y = 0, facing +Z.
- Build in order: feet, shins, thighs, pelvis, torso, shoulders, upper arms,
  forearms, hands, neck, head. Use "capsule" for limbs — boxes read as a robot.
- Then the things that make this character THIS character: hat, hood, pack,
  cloak, tool, apron, boots. That is where the silhouette comes from.
- The head needs a face: a slightly darker sphere or box for hair, two small
  dark spheres for eyes at about y = 1.68.
- Give the arms a small rotation so they are not dead straight at the sides, and
  turn the head a few degrees. A perfectly symmetrical figure reads as a mannequin.
- physics.bodyType "kinematic" — a character is moved by code, not by gravity.

${WORKED_EXAMPLE}

${OBJECT_RETURN}`,
  },
  {
    id: "player",
    name: "Player model",
    icon: "home",
    blurb: "A player character built to be rigged and animated.",
    placeholder: "an armoured scout in light plate with a short cape and a lantern on the belt",
    brief: `Build ONE player character out of primitive parts, built to be rigged later.

${PART_SCHEMA}

${ENTITY_SCHEMA}

${PHYSICS_SCHEMA}

${CRAFT}

Player rules:
- About 1.8 metres, standing on y = 0, facing +Z.
- Name every part for the joint it belongs to: "L Upper Arm", "R Thigh",
  "Pelvis", "Head", "Neck". Whoever rigs this needs those names, and renaming
  thirty parts by hand is why generated characters get thrown away.
- Left and right must mirror exactly: if "L Thigh" is at x = -0.16, "R Thigh" is
  at x = +0.16 with the same scale and the mirrored rotation.
- Use capsules for limbs, a box or capsule for the torso, a sphere for the head.
- physics.bodyType "kinematic", collider "capsule".

${WORKED_EXAMPLE}

${OBJECT_RETURN}`,
  },
  {
    id: "map",
    name: "Map",
    icon: "atlas",
    blurb: "A whole playable space — terrain, structures, props.",
    placeholder: "a small fishing village on a rocky shore with a stone pier and three huts",
    brief: `Build a whole scene: several distinct objects arranged into a place someone could walk through.

${PART_SCHEMA}

${ENTITY_SCHEMA}

${CRAFT}

COMPOSITION — this is the part that decides whether the scene is any good:

- 8 to 18 entities. Each is ONE object with its own parts. Do not put the whole
  map inside one entity.
- EVERY ENTITY NEEDS ITS OWN "position". Spread them over 30 to 60 metres. If two
  entities share a position they are inside each other and both are wasted. Before
  you finish, read back your own entity list and check no two positions are close.
- Compose deliberately. Decide where the viewer enters, what draws the eye, and
  what sits at the edges to frame it. Leave open ground to walk through — a scene
  packed edge to edge has no composition.
- Vary height across the scene: something tall at one end, low things at the other.
  A map at one elevation reads as a floor plan.
- Vary rotation. Buildings on a street are not all axis-aligned; give each one a
  different Y rotation of a few degrees.
- Repeat elements with variation rather than copies: three huts at different
  sizes, rotations and roof colours, not three identical huts.
- Include the ground as one large flat entity — a "plane" or a very flat box,
  30-60 metres across, positioned at y = 0. Give water its own flat entity
  slightly above the ground (y = 0.02) with opacity 0.8 so it reads as water.

LIGHT AND AIR:
- "sky": a hex colour that suits the place and the hour.
- "ambient": 0.2 for night or dramatic, 0.35 for golden hour, 0.6 for overcast noon.
- "fog": metres at which the horizon fades out — 120 for an intimate space,
  400 for an open landscape. Omit for none.
- 2 or 3 lights. One key that clearly comes from somewhere, one cooler fill from
  roughly the opposite side at a third of the intensity, and optionally one warm
  point light on something that glows.

"light": { "name": string, "kind": "directional" | "point", "position": [x,y,z],
           "color": "#rrggbb", "intensity": 0..3, "range": number }
A directional light's position is the DIRECTION it shines FROM: [-1, 1.6, 0.8] is
a low sun on the left. A point light needs a "range" that actually reaches
something — a range of 2 in a 40-metre scene lights nothing.

${WORKED_EXAMPLE}

Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "sky": "#rrggbb", "ambient": 0..1, "fog": number, "lights": [ <lights> ], "entities": [ <entities, each with its own position> ] }`,
  },
  {
    id: "fx",
    name: "Particles",
    icon: "sparkles",
    blurb: "Fire, smoke, sparks, magic, weather.",
    placeholder: "a crackling campfire with embers drifting upward and thin smoke above",
    brief: `Design particle emitters for the scene you are given.

"emitter": {
  "name": string,
  "position": [x, y, z],       // world position — put it ON the thing it belongs to
  "color": "#rrggbb",          // colour at birth
  "color2": "#rrggbb",         // colour at death — the fade is what sells it
  "rate": number,              // particles per second, 4-160
  "life": number,              // seconds each particle lives, 0.2-6
  "speed": number,             // initial speed in m/s, 0.2-12
  "spread": 0..1,              // 0 = a tight beam, 1 = a full sphere
  "size": number,              // radius in metres, 0.02-0.6
  "gravity": number,           // m/s²; negative falls, positive rises (smoke, embers)
  "blend": "add" | "normal" }  // "add" for anything luminous — fire, sparks, magic

What separates an effect from a mess:
- LAYER IT. Fire is at least three emitters: a fast bright core (life 0.4, speed 2,
  add), slower orange flame (life 1.2, speed 1.2, add), and grey smoke above it
  (life 4, speed 0.6, normal, larger size, positioned a metre higher).
- Luminous things use "add" and fade from a hot colour to a dim one. Smoke uses
  "normal", starts mid-grey and fades darker and larger.
- rate × life is how many particles exist at once. Keep the total under 400.
- Match the position to the scene you were given. An emitter at the origin when
  the campfire is at [12, 0, -8] is an effect nobody will ever see.

Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "fx": [ <emitters> ] }`,
  },
  {
    id: "lighting",
    name: "Lighting",
    icon: "spark",
    blurb: "Relight the scene — mood, time of day, drama.",
    placeholder: "cold moonlight with a warm fire glow from the left and mist in the distance",
    brief: `Light the existing scene. You are given its contents; do not add or remove objects.

"light": { "name": string, "kind": "directional" | "point", "position": [x,y,z],
           "color": "#rrggbb", "intensity": 0..3, "range": number }
A directional light's position is the DIRECTION it shines FROM — [-1, 2, 1] is a
high sun to the left. A point light sits at its position and needs a "range" in
metres that actually reaches something.

Rules:
- ONE key light does the work. It has a clear direction and a colour temperature.
- Fills are dimmer AND a different temperature — warm key with cool fill, or the
  reverse. Two lights of the same colour and intensity cancel into flatness, which
  is the most common way a scene ends up looking like a diagram.
- A low key (y around 1-2 in the direction vector) gives long shadows and shape.
  A high key (y around 3+) gives flat noon light. Pick on purpose.
- "ambient" low (0.15-0.3) when you want shape, higher (0.5-0.7) when you want
  everything legible.
- "sky" must agree with the light. Cold moonlight under a warm orange sky is a
  mistake, not a style.
- "fog" in metres ties the horizon to the sky. Mist is fog plus a raised ambient.

Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "sky": "#rrggbb", "ambient": 0..1, "fog": number, "lights": [ <lights> ] }`,
  },
];

export const getForgeKind = (id: string) => FORGE_KINDS.find((k) => k.id === id) ?? FORGE_KINDS[0];

/** Pull the first JSON object out of a model reply, fenced or not.
 *
 *  Models add prose before JSON roughly as often as they do not, and a brace
 *  scan is more reliable than any instruction telling them to stop. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("No JSON object found in the reply.");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error("The JSON in the reply was never closed — the model was probably cut off. Raise max tokens in Settings.");
}

/* ── Coercion ─────────────────────────────────────────────────────────────
   Models write "12" as often as 12, and [0,0] as often as [0,0,0]. Rejecting
   those silently is how every object ends up at the origin, so coerce what can
   be coerced and say so when it cannot. */

export function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function vec3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(v)) {
    // A short array is padded rather than thrown away: [4, 2] almost always
    // means [4, 2, 0], and discarding it loses the placement entirely.
    const out: [number, number, number] = [
      num(v[0], fallback[0]),
      num(v[1], v.length > 1 ? fallback[1] : fallback[1]),
      num(v[2], fallback[2]),
    ];
    return out;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("x" in o || "y" in o || "z" in o) {
      return [num(o.x, fallback[0]), num(o.y, fallback[1]), num(o.z, fallback[2])];
    }
  }
  return fallback;
}

/** How many entities are effectively stacked on one another.
 *
 *  This is the failure the briefs above are written to prevent, so it is worth
 *  detecting rather than hoping: if a model still returns a heap, the user gets
 *  told why their scene looks like one object instead of being left to wonder. */
export function stackedCount(positions: Array<[number, number, number]>): number {
  let stacked = 0;
  for (let i = 0; i < positions.length; i++) {
    // Look both ways, not just forward. Scanning only ahead undercounts by
    // one — with every object at the origin the last one has nothing after it
    // and is reported as fine, which is precisely the case this exists to
    // catch.
    const [ax, , az] = positions[i];
    const hasNeighbour = positions.some(([bx, , bz], j) => j !== i && Math.hypot(ax - bx, az - bz) < 0.75);
    if (hasNeighbour) stacked++;
  }
  return stacked;
}

/** Spread entities that arrived on top of each other onto a ring.
 *
 *  A rescue, not a layout engine: it cannot know what the scene meant, but a
 *  ring of visible objects is recoverable by hand and an invisible heap is not. */
export function spreadOverlapping(positions: Array<[number, number, number]>): Array<[number, number, number]> {
  const out = positions.map((p) => [...p] as [number, number, number]);
  const placed: Array<[number, number, number]> = [];
  let ring = 0;
  for (let i = 0; i < out.length; i++) {
    const collides = placed.some(([ax, , az]) => Math.hypot(ax - out[i][0], az - out[i][2]) < 0.75);
    if (collides) {
      ring++;
      const angle = (ring / Math.max(1, out.length)) * Math.PI * 2;
      const radius = 6 + ring * 2.2;
      out[i][0] = Math.round(Math.cos(angle) * radius * 100) / 100;
      out[i][2] = Math.round(Math.sin(angle) * radius * 100) / 100;
    }
    placed.push(out[i]);
  }
  return out;
}
