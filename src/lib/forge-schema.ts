/* ────────────────────────────────────────────────────────────────────────────
   The contract between a model and the 3D scene.

   Kept out of the app file because three surfaces need it — Forge 3D builds
   from it, Asset Studio builds a subset of it, and the vision reviewer has to
   be told the same shapes it is looking at. One definition, so a change cannot
   drift between them.

   The format is deliberately boring: primitive parts with a position, a scale
   and a colour. A model that tries to write a mesh format produces garbage; a
   model composing a lamp post out of a cylinder and a sphere produces a lamp
   post.
   ──────────────────────────────────────────────────────────────────────────── */

export const SHAPES = ["box", "sphere", "cylinder", "cone", "plane", "capsule"] as const;

export const PART_SCHEMA = `A "part" is one primitive:
  { "name": string,
    "shape": "box" | "sphere" | "cylinder" | "cone" | "plane" | "capsule",
    "position": [x, y, z],     // metres, relative to the object's own origin
    "scale": [x, y, z],        // metres; 1 = one metre
    "color": "#rrggbb",
    "roughness": 0..1,         // optional
    "metalness": 0..1,         // optional
    "emissive": "#rrggbb" }    // optional — only for things that glow`;

export const PHYSICS_SCHEMA = `"physics": {
  "bodyType": "static" | "dynamic" | "kinematic",
  "collider": "box" | "sphere" | "capsule" | "mesh" | "none",
  "mass": number, "friction": 0..1, "restitution": 0..1, "solid": boolean }`;

export const SCENE_RULES = `Scale and orientation rules — breaking these is what makes generated scenes look wrong:
- +Y is up. The ground is y = 0. Nothing may sit below it unless it is meant to be buried.
- An object's parts are positioned relative to that object's origin, which sits on the ground.
- Real metres. A person is ~1.8 tall, a door ~2.1, a chair seat ~0.45, a street lamp ~4.5.
- Give things thickness. A wall 0.2 deep reads as a wall; a wall 0.01 deep reads as a bug.
- Colours must be #rrggbb. Vary them: a scene where everything is one grey is a scene nobody will keep.`;

/** The kinds of thing Forge can be asked to make, and what each one must
 *  return. Every brief is explicit about the JSON, because "return JSON" and
 *  nothing else is how you get six different shapes from six models. */
export interface ForgeKind {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  brief: string;
  placeholder: string;
}

const OBJECT_RETURN = `Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "entities": [ { "name": string, "position": [x,y,z], "rotation": [0,0,0], "scale": [1,1,1], "parts": [ ...parts... ], ${""}"physics": {...} } ] }`;

export const FORGE_KINDS: ForgeKind[] = [
  {
    id: "asset",
    name: "Asset",
    icon: "assetstudio",
    blurb: "A prop, a piece of set dressing, a building.",
    placeholder: "a weathered wooden watchtower with a ladder and a lantern",
    brief: `Build ONE object out of primitive parts.

${PART_SCHEMA}

${PHYSICS_SCHEMA}

${SCENE_RULES}

Use between 4 and 20 parts. Silhouette first: an object recognisable from its outline at a distance beats one with fiddly detail that disappears. Then break up large flat areas with trim, edges and colour variation.

${OBJECT_RETURN}`,
  },
  {
    id: "npc",
    name: "NPC",
    icon: "agents",
    blurb: "A character with a readable silhouette and role.",
    placeholder: "a hooded market trader with a heavy satchel",
    brief: `Build ONE humanoid character out of primitive parts.

${PART_SCHEMA}

${PHYSICS_SCHEMA}

${SCENE_RULES}

Character rules:
- ~1.8 metres tall overall, standing on y = 0, facing +Z.
- Build the body in order: feet, legs, hips, torso, arms, hands, neck, head — then whatever makes this character *this* character (hat, pack, tool, cloak).
- Readable from the silhouette alone. Two characters that differ only in colour are one character.
- Give the head a distinct colour from the torso, and eyes as small dark parts if the style allows.
- physics.bodyType should be "kinematic" — a character is moved by code, not by gravity.

${OBJECT_RETURN}`,
  },
  {
    id: "player",
    name: "Player model",
    icon: "home",
    blurb: "A player character built for animation.",
    placeholder: "an armoured scout in light plate with a short cape",
    brief: `Build ONE player character out of primitive parts.

${PART_SCHEMA}

${PHYSICS_SCHEMA}

${SCENE_RULES}

Player rules:
- ~1.8 metres, standing on y = 0, facing +Z, arms at the sides.
- Name each part for the joint it belongs to: "L Upper Arm", "R Thigh", "Head", "Pelvis". Whoever rigs this later needs those names, and renaming twenty parts by hand is why generated characters get thrown away.
- Keep left and right symmetric unless the design says otherwise, and mirror positions exactly.
- physics.bodyType "kinematic", collider "capsule".

${OBJECT_RETURN}`,
  },
  {
    id: "map",
    name: "Map",
    icon: "atlas",
    blurb: "A whole playable space — terrain, structures, props.",
    placeholder: "a small fishing village on a rocky shore with a pier and three huts",
    brief: `Build a whole scene: several objects arranged into a place.

${PART_SCHEMA}

${SCENE_RULES}

Composition rules:
- 6 to 16 entities. Each is one object with its own parts — do not put the whole map in one entity.
- Arrange them deliberately. Leave walkable space; do not scatter at random. Think about where a player enters and what draws them forward.
- Vary height. A map that is all one elevation reads as a floor plan.
- Include the ground itself as a large flat entity if the space needs one.
- Set "sky" to a hex colour that suits the place, and "ambient" between 0.25 (night, dramatic) and 0.7 (overcast noon).
- Add 1-3 lights that match the setting.

"light": { "name": string, "kind": "directional" | "point", "position": [x,y,z], "color": "#rrggbb", "intensity": 0..3, "range": number }
A directional light uses its position as the direction it shines FROM.

Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "sky": "#rrggbb", "ambient": 0..1, "lights": [ ...lights... ], "entities": [ ...entities... ] }`,
  },
  {
    id: "fx",
    name: "Particles",
    icon: "sparkles",
    blurb: "Fire, smoke, sparks, magic, weather.",
    placeholder: "a crackling campfire with embers drifting upward",
    brief: `Design particle emitters.

"emitter": {
  "name": string,
  "position": [x, y, z],
  "color": "#rrggbb",          // colour at birth
  "color2": "#rrggbb",         // colour at death — the fade is what sells it
  "rate": number,              // particles per second, 4-160
  "life": number,              // seconds each particle lives, 0.2-6
  "speed": number,             // initial speed in m/s, 0.2-12
  "spread": 0..1,              // 0 = a tight beam, 1 = a full sphere
  "size": number,              // radius in metres, 0.02-0.6
  "gravity": number,           // m/s²; negative falls, positive rises (smoke, embers)
  "blend": "add" | "normal" }  // "add" for anything luminous — fire, sparks, magic

Rules that make the difference between an effect and a mess:
- Layer it. Fire is at least two emitters: a fast bright core and a slower dark smoke above it.
- Luminous things use "add" and a hot colour fading to a dim one. Smoke uses "normal", starts grey and fades darker.
- Rate times life is how many particles exist at once. Keep that under 400 across all emitters.

Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "fx": [ ...emitters... ] }`,
  },
  {
    id: "lighting",
    name: "Lighting",
    icon: "spark",
    blurb: "Relight the scene — mood, time of day, drama.",
    placeholder: "cold moonlight with a warm fire glow from the left",
    brief: `Light the existing scene. You are given its contents; do not add or remove objects.

"light": { "name": string, "kind": "directional" | "point", "position": [x,y,z], "color": "#rrggbb", "intensity": 0..3, "range": number }
A directional light uses its position as the direction it shines FROM — [ -1, 2, 1 ] is a high sun to the left.

Rules:
- One key light does the work. Fills are dimmer and a different colour temperature — warm key, cool fill, or the reverse. Two lights of the same colour and intensity cancel each other into flatness.
- Point lights need a "range" that actually reaches something. A range of 2 in a 40-metre map lights nothing.
- Set "ambient" low (0.15-0.3) when you want shape, higher (0.5-0.7) when you want everything visible.
- "sky" should agree with the lighting. Cold moonlight over a warm orange sky is a mistake, not a style.

Return ONE json object in a fenced \`\`\`json block and nothing else:
{ "sky": "#rrggbb", "ambient": 0..1, "lights": [ ...lights... ] }`,
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
