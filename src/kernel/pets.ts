import type { PartValue } from "@/lib/petgen";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
/* ────────────────────────────────────────────────────────────────────────────
   Desktop pets.

   The old version was sixteen fixed SVG paths — sixteen creatures and no way
   to get a seventeenth without drawing one. This is a description instead of a
   drawing: a species says what shape its body is, what its ears and tail and
   eyes do, how it moves and what colours it wears, and the renderer composes
   that into a sprite at whatever level of detail you asked for.

   Two things fall out of that which are worth the indirection:

   - Detail becomes a dial, not a redraw. "Basic" is the outline the old pets
     were; "detailed" fills and shades the same shapes; "expressive" adds
     blinking, breathing, a swaying tail and a contact shadow. One description,
     three fidelities, and a slow machine can pick the cheap one.
   - Adding a creature is five lines. Which is why there are now thirty-two.

   Nothing here renders. The parts live in src/shell/pets.tsx.
   ──────────────────────────────────────────────────────────────────────────── */

// Derived from the one runtime list the AI pet validator also uses, so a part
// a generated pet may name is always a part the renderer can draw.
export type Body = PartValue<"body">;
export type Ears = PartValue<"ears">;
export type Tail = PartValue<"tail">;
export type Eyes = PartValue<"eyes">;
export type Limbs = PartValue<"limbs">;
export type Pattern = PartValue<"pattern">;

export interface Species {
  id: string;
  name: string;
  family: "mammal" | "bird" | "aquatic" | "reptile" | "mythic" | "synthetic" | "flora" | "cosmic";
  body: Body;
  ears: Ears;
  tail: Tail;
  eyes: Eyes;
  limbs: Limbs;
  pattern: Pattern;
  /** [base, secondary, highlight]. "accent" and "accent2" resolve to the live
   *  theme tokens, so a pet can be told to match whatever palette is on. */
  hue: [string, string, string];
  /** Idle animation speed multiplier — a crab scuttles, a jellyfish drifts. */
  tempo: number;
  blurb: string;
}

const A = "var(--accent)";
const A2 = "var(--accent2)";

export const SPECIES: Species[] = [
  /* ── Mammals ─────────────────────────────────────────────────────────── */
  { id: "cat", name: "Cat", family: "mammal", body: "oval", ears: "pointed", tail: "curl", eyes: "round", limbs: "paws", pattern: "stripes", hue: ["#f0a862", "#c9743a", "#fff3e2"], tempo: 1, blurb: "Judgmental. Warm." },
  { id: "dog", name: "Dog", family: "mammal", body: "oval", ears: "long", tail: "bushy", eyes: "round", limbs: "paws", pattern: "belly", hue: ["#c68a51", "#8a5a30", "#fbeede"], tempo: 1.25, blurb: "Delighted you exist." },
  { id: "fox", name: "Fox", family: "mammal", body: "oval", ears: "pointed", tail: "bushy", eyes: "round", limbs: "paws", pattern: "belly", hue: ["#e8703a", "#b2441c", "#fff1e4"], tempo: 1.15, blurb: "Clever, a little smug." },
  { id: "bunny", name: "Bunny", family: "mammal", body: "round", ears: "long", tail: "none", eyes: "round", limbs: "paws", pattern: "belly", hue: ["#e8dcd2", "#bda99a", "#fffaf6"], tempo: 1.4, blurb: "Twitchy and sweet." },
  { id: "bear", name: "Bear", family: "mammal", body: "round", ears: "round", tail: "none", eyes: "dot", limbs: "paws", pattern: "belly", hue: ["#8a6746", "#5d4229", "#e8d5bd"], tempo: 0.7, blurb: "Slow, immovable, fond of you." },
  { id: "otter", name: "Otter", family: "mammal", body: "bean", ears: "round", tail: "thin", eyes: "round", limbs: "paws", pattern: "belly", hue: ["#7d5b3f", "#513724", "#e4d2bd"], tempo: 1.3, blurb: "Holds things. Floats." },
  { id: "hedgehog", name: "Hedgehog", family: "mammal", body: "round", ears: "round", tail: "none", eyes: "dot", limbs: "legs", pattern: "plates", hue: ["#9a7d5e", "#5c4630", "#f3e3cd"], tempo: 1.1, blurb: "Spiky exterior, soft take." },
  { id: "capybara", name: "Capybara", family: "mammal", body: "oval", ears: "round", tail: "none", eyes: "sleepy", limbs: "legs", pattern: "none", hue: ["#a97f52", "#775636", "#dcc3a3"], tempo: 0.55, blurb: "Serenity, given form." },
  { id: "bat", name: "Bat", family: "mammal", body: "round", ears: "pointed", tail: "none", eyes: "wide", limbs: "wings", pattern: "none", hue: ["#584a72", "#332a47", "#c4b5e0"], tempo: 1.5, blurb: "Nocturnal, like you." },

  { id: "redpanda", name: "Red Panda", family: "mammal", body: "oval", ears: "round", tail: "bushy", eyes: "round", limbs: "paws", pattern: "stripes", hue: ["#c4622d", "#7d3413", "#f7e3cd"], tempo: 0.9, blurb: "Small tree gremlin. Beloved." },
  { id: "ferret", name: "Ferret", family: "mammal", body: "serpent", ears: "round", tail: "bushy", eyes: "round", limbs: "paws", pattern: "belly", hue: ["#d8c4a6", "#8d7355", "#fdf6ea"], tempo: 1.5, blurb: "A tube with opinions." },
  { id: "sloth", name: "Sloth", family: "mammal", body: "blob", ears: "round", tail: "none", eyes: "sleepy", limbs: "paws", pattern: "none", hue: ["#9d8f6f", "#6a5f45", "#ded3b6"], tempo: 0.3, blurb: "Arrives eventually." },
  { id: "shiba", name: "Shiba", family: "mammal", body: "oval", ears: "pointed", tail: "curl", eyes: "dot", limbs: "paws", pattern: "belly", hue: ["#e0a45c", "#a86a2c", "#fff4e2"], tempo: 1.2, blurb: "Deeply unbothered." },
  { id: "lynx", name: "Lynx", family: "mammal", body: "oval", ears: "tuft", tail: "thin", eyes: "wide", limbs: "paws", pattern: "spots", hue: ["#b99a72", "#7d6244", "#f2e6d2"], tempo: 0.95, blurb: "Ear tufts. Zero patience." },
  { id: "pangolin", name: "Pangolin", family: "mammal", body: "bean", ears: "none", tail: "thin", eyes: "dot", limbs: "legs", pattern: "plates", hue: ["#a9834f", "#6d502b", "#e6cfa6"], tempo: 0.75, blurb: "An artichoke that loves you." },
  { id: "wombat", name: "Wombat", family: "mammal", body: "round", ears: "round", tail: "none", eyes: "sleepy", limbs: "legs", pattern: "none", hue: ["#9b8368", "#67553f", "#dfd0b8"], tempo: 0.6, blurb: "Structurally a brick." },
  { id: "raccoon", name: "Raccoon", family: "mammal", body: "oval", ears: "round", tail: "bushy", eyes: "wide", limbs: "paws", pattern: "stripes", hue: ["#8e929c", "#4c505c", "#e4e7ee"], tempo: 1.3, blurb: "Has been through your things." },
  { id: "mouse", name: "Mouse", family: "mammal", body: "round", ears: "round", tail: "thin", eyes: "dot", limbs: "paws", pattern: "belly", hue: ["#b5adaa", "#7a7370", "#f3efed"], tempo: 1.6, blurb: "Small. Fast. Yours." },
  { id: "deer", name: "Deer", family: "mammal", body: "tall", ears: "long", tail: "none", eyes: "wide", limbs: "legs", pattern: "spots", hue: ["#c08c5c", "#8a5f36", "#f6e6d2"], tempo: 0.85, blurb: "Alert about nothing." },
  { id: "hamster", name: "Hamster", family: "mammal", body: "round", ears: "round", tail: "none", eyes: "dot", limbs: "paws", pattern: "belly", hue: ["#e3b878", "#a8804a", "#fff6e6"], tempo: 1.7, blurb: "Cheeks full of plans." },
  { id: "bumblebee", name: "Bumblebee", family: "mammal", body: "bean", ears: "antenna", tail: "stinger", eyes: "multi", limbs: "wings", pattern: "stripes", hue: ["#f5c518", "#2b2b2b", "#fff3c4"], tempo: 1.8, blurb: "Aerodynamically rude." },
  { id: "moth", name: "Moth", family: "mammal", body: "oval", ears: "antenna", tail: "none", eyes: "round", limbs: "wings", pattern: "swirl", hue: ["#c9b9a4", "#8a7a66", "#f4ece0"], tempo: 1.35, blurb: "Loves a lamp. Always has." },
  /* ── Birds ───────────────────────────────────────────────────────────── */
  { id: "penguin", name: "Penguin", family: "bird", body: "tall", ears: "none", tail: "none", eyes: "round", limbs: "flipper", pattern: "belly", hue: ["#2c3550", "#161c2e", "#f4f7ff"], tempo: 0.85, blurb: "Formal. Falls over." },
  { id: "owl", name: "Owl", family: "bird", body: "round", ears: "tuft", tail: "fan", eyes: "wide", limbs: "wings", pattern: "spots", hue: ["#9d7b55", "#6a4f33", "#efe0c8"], tempo: 0.6, blurb: "Knows. Won't say." },
  { id: "duck", name: "Duck", family: "bird", body: "bean", ears: "none", tail: "fan", eyes: "dot", limbs: "wings", pattern: "none", hue: ["#f5e6a8", "#d8b84f", "#fffdf2"], tempo: 1.2, blurb: "Rubber, allegedly." },
  { id: "crow", name: "Crow", family: "bird", body: "oval", ears: "none", tail: "fan", eyes: "dot", limbs: "wings", pattern: "glow", hue: ["#2b2f3d", "#14161f", "#7e8aa8"], tempo: 1.1, blurb: "Collects shiny bugs." },
  { id: "parrot", name: "Parrot", family: "bird", body: "oval", ears: "crest", tail: "fan", eyes: "round", limbs: "wings", pattern: "stripes", hue: ["#36c46a", "#e2483d", "#ffd84d"], tempo: 1.35, blurb: "Repeats your worst idea." },

  { id: "puffin", name: "Puffin", family: "bird", body: "oval", ears: "none", tail: "fan", eyes: "round", limbs: "wings", pattern: "belly", hue: ["#2a2f38", "#14171c", "#fdfaf4"], tempo: 1.1, blurb: "A serious little person." },
  { id: "flamingo", name: "Flamingo", family: "bird", body: "tall", ears: "crest", tail: "fan", eyes: "dot", limbs: "legs", pattern: "none", hue: ["#f78fb3", "#c95f88", "#ffe3ee"], tempo: 0.8, blurb: "Balanced, for now." },
  { id: "toucan", name: "Toucan", family: "bird", body: "oval", ears: "crest", tail: "fan", eyes: "round", limbs: "wings", pattern: "belly", hue: ["#1d1d22", "#f6a623", "#fff8e8"], tempo: 1.15, blurb: "Mostly beak, honestly." },
  { id: "hummingbird", name: "Hummingbird", family: "bird", body: "bean", ears: "none", tail: "fan", eyes: "dot", limbs: "wings", pattern: "glow", hue: ["#21c98a", "#0d7d55", "#d6fff0"], tempo: 2, blurb: "Never actually still." },
  { id: "swan", name: "Swan", family: "bird", body: "serpent", ears: "none", tail: "fan", eyes: "sleepy", limbs: "flipper", pattern: "none", hue: ["#f7f4ef", "#c9c2b6", "#ffffff"], tempo: 0.5, blurb: "Elegant. Will fight you." },
  { id: "chicken", name: "Chicken", family: "bird", body: "round", ears: "crest", tail: "fan", eyes: "dot", limbs: "legs", pattern: "none", hue: ["#f2e4cc", "#c4a87e", "#fffaf0"], tempo: 1.45, blurb: "Ancient dinosaur. Small now." },
  { id: "heron", name: "Heron", family: "bird", body: "tall", ears: "crest", tail: "thin", eyes: "wide", limbs: "legs", pattern: "none", hue: ["#8fa3b4", "#56687a", "#e6eef5"], tempo: 0.45, blurb: "Waits. Then does not." },
  { id: "kiwi", name: "Kiwi", family: "bird", body: "blob", ears: "none", tail: "none", eyes: "dot", limbs: "legs", pattern: "none", hue: ["#8d7455", "#5c4a33", "#ddcdb4"], tempo: 1.05, blurb: "A potato with ambitions." },
  /* ── Aquatic ─────────────────────────────────────────────────────────── */
  { id: "fish", name: "Fish", family: "aquatic", body: "fish", ears: "fin", tail: "fin", eyes: "round", limbs: "none", pattern: "scales", hue: ["#4aa8d8", "#2a6f9a", "#d8f2ff"], tempo: 1.2, blurb: "Eight-second attention. Relatable." },
  { id: "octo", name: "Octopus", family: "aquatic", body: "orb", ears: "none", tail: "none", eyes: "round", limbs: "tentacles", pattern: "spots", hue: ["#b95d92", "#7d3363", "#ffd9ee"], tempo: 0.8, blurb: "Eight hands, no patience." },
  { id: "crab", name: "Crab", family: "aquatic", body: "bean", ears: "none", tail: "none", eyes: "multi", limbs: "legs", pattern: "plates", hue: ["#e0503c", "#a02d1e", "#ffd6c9"], tempo: 1.6, blurb: "Sideways, always." },
  { id: "jelly", name: "Jellyfish", family: "aquatic", body: "cloud", ears: "none", tail: "trail", eyes: "dot", limbs: "tentacles", pattern: "glow", hue: ["#9b7de8", "#6247b5", "#e9dfff"], tempo: 0.45, blurb: "Drifts. No opinions." },
  { id: "axolotl", name: "Axolotl", family: "aquatic", body: "serpent", ears: "crest", tail: "fin", eyes: "dot", limbs: "legs", pattern: "none", hue: ["#f7b8d2", "#d4799f", "#fff0f6"], tempo: 0.75, blurb: "Perpetually a child. Goals." },
  { id: "whale", name: "Whale", family: "aquatic", body: "fish", ears: "none", tail: "fin", eyes: "dot", limbs: "flipper", pattern: "belly", hue: ["#3d6ea8", "#24456c", "#cfe6ff"], tempo: 0.4, blurb: "Big thoughts, slowly." },

  { id: "seahorse", name: "Seahorse", family: "aquatic", body: "serpent", ears: "crest", tail: "curl", eyes: "dot", limbs: "none", pattern: "scales", hue: ["#f0b03c", "#a9701c", "#ffeec6"], tempo: 0.7, blurb: "Holds on to things." },
  { id: "pufferfish", name: "Pufferfish", family: "aquatic", body: "orb", ears: "fin", tail: "fan", eyes: "wide", limbs: "flipper", pattern: "spots", hue: ["#e8c169", "#a9853a", "#fff4d8"], tempo: 0.9, blurb: "Inflates on principle." },
  { id: "manta", name: "Manta", family: "aquatic", body: "fish", ears: "fin", tail: "thin", eyes: "dot", limbs: "flipper", pattern: "belly", hue: ["#2f4a63", "#16283a", "#dfeaf3"], tempo: 0.55, blurb: "Flies underwater." },
  { id: "narwhal", name: "Narwhal", family: "aquatic", body: "fish", ears: "horns", tail: "fin", eyes: "sleepy", limbs: "flipper", pattern: "spots", hue: ["#7e8fa8", "#4a5870", "#e9eff7"], tempo: 0.6, blurb: "Sea unicorn. Real, somehow." },
  { id: "nautilus", name: "Nautilus", family: "aquatic", body: "orb", ears: "none", tail: "trail", eyes: "multi", limbs: "tentacles", pattern: "swirl", hue: ["#d9b98a", "#96734a", "#f6ead6"], tempo: 0.5, blurb: "Older than trees." },
  { id: "starfish", name: "Starfish", family: "aquatic", body: "crystal", ears: "none", tail: "none", eyes: "dot", limbs: "none", pattern: "spots", hue: ["#e57c52", "#a8492a", "#ffdcc9"], tempo: 0.4, blurb: "Regrows. Eventually." },
  { id: "shrimp", name: "Shrimp", family: "aquatic", body: "bean", ears: "antenna", tail: "fan", eyes: "multi", limbs: "legs", pattern: "plates", hue: ["#f08a7a", "#b5503f", "#ffe1da"], tempo: 1.55, blurb: "Punches above its weight." },
  { id: "seal", name: "Seal", family: "aquatic", body: "blob", ears: "none", tail: "fin", eyes: "round", limbs: "flipper", pattern: "spots", hue: ["#8e9099", "#565a64", "#e7e9ee"], tempo: 0.8, blurb: "A wet dog that swims." },
  /* ── Reptiles ────────────────────────────────────────────────────────── */
  { id: "gecko", name: "Gecko", family: "reptile", body: "serpent", ears: "none", tail: "thin", eyes: "wide", limbs: "legs", pattern: "spots", hue: ["#59c46d", "#2f7c3f", "#dcffdf"], tempo: 1.45, blurb: "Sticks to things." },
  { id: "turtle", name: "Turtle", family: "reptile", body: "oval", ears: "none", tail: "thin", eyes: "sleepy", limbs: "legs", pattern: "plates", hue: ["#5f9b5c", "#3a6438", "#d8e9c8"], tempo: 0.35, blurb: "Will get there." },
  { id: "snake", name: "Snake", family: "reptile", body: "serpent", ears: "none", tail: "thin", eyes: "dot", limbs: "none", pattern: "stripes", hue: ["#7fc45e", "#4a8035", "#f0ffdd"], tempo: 0.9, blurb: "One long opinion." },

  { id: "chameleon", name: "Chameleon", family: "reptile", body: "oval", ears: "crest", tail: "curl", eyes: "single", limbs: "legs", pattern: "swirl", hue: [A, A2, "#f2fff8"], tempo: 0.5, blurb: "Matches your theme. Literally." },
  { id: "frog", name: "Frog", family: "reptile", body: "bean", ears: "none", tail: "none", eyes: "wide", limbs: "legs", pattern: "spots", hue: ["#6fbf5e", "#3c7a30", "#e4ffd9"], tempo: 1.2, blurb: "Sits. Is content." },
  { id: "newt", name: "Newt", family: "reptile", body: "serpent", ears: "none", tail: "thin", eyes: "dot", limbs: "legs", pattern: "spots", hue: ["#e07b39", "#98491a", "#ffe6cf"], tempo: 1.05, blurb: "Damp and delighted." },
  { id: "iguana", name: "Iguana", family: "reptile", body: "serpent", ears: "crest", tail: "thin", eyes: "sleepy", limbs: "legs", pattern: "scales", hue: ["#7fae5c", "#4a6c32", "#e8f7d6"], tempo: 0.65, blurb: "Sunbathing professional." },
  { id: "tortoise", name: "Tortoise", family: "reptile", body: "round", ears: "none", tail: "none", eyes: "sleepy", limbs: "legs", pattern: "plates", hue: ["#8d7a4e", "#5a4d2f", "#ded0aa"], tempo: 0.25, blurb: "Will outlive this project." },
  /* ── Mythic ──────────────────────────────────────────────────────────── */
  { id: "dragon", name: "Dragon", family: "mythic", body: "serpent", ears: "horns", tail: "spark", eyes: "star", limbs: "wings", pattern: "scales", hue: ["#c2413f", "#7b1f24", "#ffcf6e"], tempo: 0.95, blurb: "Hoards your unfinished branches." },
  { id: "slime", name: "Slime", family: "mythic", body: "blob", ears: "none", tail: "none", eyes: "round", limbs: "none", pattern: "glow", hue: [A, A2, "#ffffff"], tempo: 1.1, blurb: "Takes the shape of the theme." },
  { id: "ghost", name: "Ghost", family: "mythic", body: "cloud", ears: "none", tail: "trail", eyes: "wide", limbs: "hover", pattern: "none", hue: ["#dfe6ff", "#9aa6cc", "#ffffff"], tempo: 0.7, blurb: "Haunts your closed tabs." },
  { id: "phoenix", name: "Phoenix", family: "mythic", body: "flame", ears: "crest", tail: "spark", eyes: "star", limbs: "wings", pattern: "glow", hue: ["#ff8a3d", "#d7351c", "#ffe9a8"], tempo: 1.2, blurb: "Restarts. Repeatedly." },
  { id: "griffin", name: "Griffin", family: "mythic", body: "oval", ears: "tuft", tail: "bushy", eyes: "star", limbs: "wings", pattern: "belly", hue: ["#d8b45c", "#94722c", "#fff3cf"], tempo: 1, blurb: "Half of two better animals." },

  { id: "kitsune", name: "Kitsune", family: "mythic", body: "oval", ears: "pointed", tail: "fan", eyes: "star", limbs: "paws", pattern: "glow", hue: ["#f5f0e6", "#d4452f", "#fff8ee"], tempo: 1.1, blurb: "Nine tails. One agenda." },
  { id: "unicorn", name: "Unicorn", family: "mythic", body: "tall", ears: "horns", tail: "trail", eyes: "star", limbs: "legs", pattern: "glow", hue: ["#fdf7ff", "#d8c2ef", "#ffffff"], tempo: 0.9, blurb: "Insufferably magical." },
  { id: "wisp", name: "Wisp", family: "mythic", body: "cloud", ears: "none", tail: "trail", eyes: "single", limbs: "hover", pattern: "glow", hue: [A, A2, "#ffffff"], tempo: 1.3, blurb: "Leads travellers astray. Fondly." },
  { id: "gargoyle", name: "Gargoyle", family: "mythic", body: "boxy", ears: "horns", tail: "thin", eyes: "cross", limbs: "wings", pattern: "plates", hue: ["#7d7f86", "#494b52", "#c9ccd4"], tempo: 0.35, blurb: "Guards nothing, diligently." },
  { id: "chimera", name: "Chimera", family: "mythic", body: "oval", ears: "horns", tail: "stinger", eyes: "multi", limbs: "paws", pattern: "stripes", hue: ["#c2703c", "#6b3418", "#ffdfc2"], tempo: 1.2, blurb: "Committee of animals." },
  { id: "golem", name: "Golem", family: "mythic", body: "boxy", ears: "none", tail: "none", eyes: "single", limbs: "legs", pattern: "plates", hue: ["#8a7a63", "#54493a", "#cdbfa6"], tempo: 0.4, blurb: "One word on its forehead." },
  { id: "banshee", name: "Banshee", family: "mythic", body: "cloud", ears: "long", tail: "trail", eyes: "sleepy", limbs: "hover", pattern: "swirl", hue: ["#b9c8e0", "#6c7e9c", "#f0f6ff"], tempo: 0.75, blurb: "Politely ominous." },
  { id: "mimic", name: "Mimic", family: "mythic", body: "boxy", ears: "none", tail: "none", eyes: "multi", limbs: "legs", pattern: "plates", hue: ["#7a5230", "#472c17", "#d8b98f"], tempo: 1.1, blurb: "Definitely just a box." },
  /* ── Synthetic ───────────────────────────────────────────────────────── */
  { id: "robot", name: "Robot", family: "synthetic", body: "boxy", ears: "antenna", tail: "none", eyes: "visor", limbs: "hover", pattern: "plates", hue: ["#9fb0c4", "#5c6b80", A], tempo: 1, blurb: "Compiles. Mostly." },
  { id: "drone", name: "Drone", family: "synthetic", body: "orb", ears: "antenna", tail: "none", eyes: "single", limbs: "hover", pattern: "glow", hue: ["#7d8aa0", "#414d61", A], tempo: 1.6, blurb: "Watches the build log." },
  { id: "cube", name: "Cube", family: "synthetic", body: "crystal", ears: "none", tail: "none", eyes: "cross", limbs: "hover", pattern: "plates", hue: [A, A2, "#ffffff"], tempo: 0.8, blurb: "Rotates. Considers." },

  { id: "toaster", name: "Toaster", family: "synthetic", body: "boxy", ears: "none", tail: "none", eyes: "visor", limbs: "legs", pattern: "plates", hue: ["#c8ccd4", "#7d828c", "#eef1f6"], tempo: 0.9, blurb: "Sentient. Still toasts." },
  { id: "lamp", name: "Desk Lamp", family: "synthetic", body: "tall", ears: "none", tail: "thin", eyes: "single", limbs: "none", pattern: "glow", hue: [A, A2, "#fffbe8"], tempo: 0.7, blurb: "Leans in when you work." },
  { id: "mech", name: "Mech", family: "synthetic", body: "boxy", ears: "antenna", tail: "none", eyes: "visor", limbs: "legs", pattern: "plates", hue: ["#5d6672", "#2f353d", "#a9b5c4"], tempo: 0.5, blurb: "Scaled down. Still stomps." },
  { id: "satellite", name: "Satellite", family: "synthetic", body: "boxy", ears: "antenna", tail: "trail", eyes: "dot", limbs: "hover", pattern: "glow", hue: ["#9aa7bb", "#5a6577", "#e2e9f4"], tempo: 0.6, blurb: "Passes overhead. Waves." },
  { id: "orb", name: "Orb", family: "synthetic", body: "orb", ears: "none", tail: "none", eyes: "single", limbs: "hover", pattern: "glow", hue: [A, A2, "#ffffff"], tempo: 1, blurb: "Hovering. Judging. Helping." },
  { id: "printer", name: "Printer", family: "synthetic", body: "boxy", ears: "none", tail: "trail", eyes: "visor", limbs: "none", pattern: "plates", hue: ["#d5d8dd", "#898f99", "#f4f6f9"], tempo: 0.8, blurb: "Jammed. Emotionally." },
  { id: "floppy", name: "Floppy Disk", family: "synthetic", body: "boxy", ears: "none", tail: "none", eyes: "dot", limbs: "legs", pattern: "plates", hue: ["#3a4a6b", "#1f2a43", "#c9d4e8"], tempo: 1.2, blurb: "Remembers 1.44 things." },
  /* ── Flora & cosmic ──────────────────────────────────────────────────── */
  { id: "mushroom", name: "Mushroom", family: "flora", body: "round", ears: "none", tail: "none", eyes: "dot", limbs: "legs", pattern: "spots", hue: ["#e05a58", "#9c3634", "#fff2e0"], tempo: 0.6, blurb: "Quietly networked." },
  { id: "sprout", name: "Sprout", family: "flora", body: "bean", ears: "leaf", tail: "none", eyes: "round", limbs: "legs", pattern: "none", hue: ["#79c85e", "#3f8034", "#e6ffd9"], tempo: 0.9, blurb: "Growing. Slowly. Like the project." },
  { id: "cactus", name: "Cactus", family: "flora", body: "tall", ears: "none", tail: "none", eyes: "dot", limbs: "none", pattern: "plates", hue: ["#4e9c62", "#2c6039", "#ffd7e6"], tempo: 0.3, blurb: "Needs nothing. Ever." },
  { id: "star", name: "Starling", family: "cosmic", body: "crystal", ears: "none", tail: "spark", eyes: "star", limbs: "hover", pattern: "glow", hue: ["#ffd85c", "#e0a01e", "#fffbe8"], tempo: 1.3, blurb: "Small piece of a big thing." },
  { id: "alien", name: "Alien", family: "cosmic", body: "orb", ears: "antenna", tail: "none", eyes: "wide", limbs: "legs", pattern: "none", hue: ["#7fe3a8", "#2f9c63", "#e9fff2"], tempo: 1.05, blurb: "Here about your API keys." },
  { id: "moon", name: "Moonlet", family: "cosmic", body: "orb", ears: "none", tail: "trail", eyes: "sleepy", limbs: "hover", pattern: "spots", hue: ["#cdd4e6", "#8d97b3", "#ffffff"], tempo: 0.4, blurb: "Orbits. Says little." },
  { id: "sunflower", name: "Sunflower", family: "flora", body: "tall", ears: "crest", tail: "none", eyes: "round", limbs: "none", pattern: "glow", hue: ["#f5c211", "#a37a06", "#fff6cc"], tempo: 0.5, blurb: "Follows the brightest thing." },
  { id: "fern", name: "Fern", family: "flora", body: "tall", ears: "leaf", tail: "curl", eyes: "sleepy", limbs: "none", pattern: "none", hue: ["#4f8f52", "#2c5c2f", "#d8f0d4"], tempo: 0.4, blurb: "Unfurling, slowly." },
  { id: "acorn", name: "Acorn", family: "flora", body: "bean", ears: "leaf", tail: "none", eyes: "dot", limbs: "legs", pattern: "belly", hue: ["#a8703c", "#6b421d", "#eed4b2"], tempo: 1.1, blurb: "Ambitious. Technically a tree." },
  { id: "lotus", name: "Lotus", family: "flora", body: "crystal", ears: "leaf", tail: "none", eyes: "sleepy", limbs: "none", pattern: "glow", hue: ["#f6a8c8", "#bd6389", "#fff0f6"], tempo: 0.35, blurb: "Serene, from mud." },
  { id: "venus", name: "Venus Trap", family: "flora", body: "bean", ears: "leaf", tail: "none", eyes: "multi", limbs: "none", pattern: "stripes", hue: ["#6aa84f", "#8b2f3f", "#e4ffd0"], tempo: 0.9, blurb: "Friendly. Mostly." },
  { id: "comet", name: "Comet", family: "cosmic", body: "orb", ears: "none", tail: "trail", eyes: "star", limbs: "hover", pattern: "glow", hue: ["#bfe6ff", "#4a7fb5", "#ffffff"], tempo: 1.6, blurb: "Visits. Rarely." },
  { id: "blackhole", name: "Singularity", family: "cosmic", body: "orb", ears: "none", tail: "trail", eyes: "single", limbs: "hover", pattern: "swirl", hue: ["#0b0b12", "#2b1b45", "#c7b3ff"], tempo: 0.45, blurb: "Attentive. Very attentive." },
  { id: "nebula", name: "Nebula", family: "cosmic", body: "cloud", ears: "none", tail: "trail", eyes: "multi", limbs: "hover", pattern: "swirl", hue: [A2, A, "#ffffff"], tempo: 0.3, blurb: "Mostly empty. Still stunning." },
  { id: "sun", name: "Little Sun", family: "cosmic", body: "orb", ears: "crest", tail: "none", eyes: "round", limbs: "hover", pattern: "glow", hue: ["#ffcf3f", "#e8791a", "#fff6d8"], tempo: 0.85, blurb: "Warm. Slightly too warm." },
  { id: "constellation", name: "Constellation", family: "cosmic", body: "crystal", ears: "none", tail: "spark", eyes: "star", limbs: "hover", pattern: "glow", hue: ["#dce9ff", "#7c96c8", "#ffffff"], tempo: 0.55, blurb: "Joined by imaginary lines." },
  { id: "satellite2", name: "Rover", family: "cosmic", body: "boxy", ears: "antenna", tail: "none", eyes: "visor", limbs: "legs", pattern: "plates", hue: ["#c0a87f", "#7c684a", "#efe3c8"], tempo: 0.4, blurb: "Still going. Still reporting." },
];

/** Pets a model designed for this user. Persisted separately so a catalogue
 *  update can never overwrite them. Capped: each is small, but unbounded is
 *  unbounded. */
interface CustomPetState {
  pets: Species[];
  add: (s: Species) => void;
  remove: (id: string) => void;
}
export const useCustomPets = create<CustomPetState>()(
  persist(
    (set) => ({
      pets: [],
      add: (sp) => set((st) => ({ pets: [sp, ...st.pets.filter((p) => p.id !== sp.id)].slice(0, 60) })),
      remove: (id) => set((st) => ({ pets: st.pets.filter((p) => p.id !== id) })),
    }),
    { name: "webaios.custompets.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/** Built-in first, then anything a model made. Reads the store directly, so
 *  components that must re-render when a pet is added subscribe to
 *  useCustomPets themselves. */
export const getSpecies = (id: string): Species | undefined =>
  SPECIES.find((s) => s.id === id) ?? useCustomPets.getState().pets.find((s) => s.id === id);

export const PET_FAMILIES: Array<{ id: Species["family"]; label: string }> = [
  { id: "mammal", label: "Mammals" },
  { id: "bird", label: "Birds" },
  { id: "aquatic", label: "Aquatic" },
  { id: "reptile", label: "Reptiles" },
  { id: "mythic", label: "Mythic" },
  { id: "synthetic", label: "Synthetic" },
  { id: "flora", label: "Flora" },
  { id: "cosmic", label: "Cosmic" },
];

/* ────────────────────────────────────────────────────────────────────────────
   Personalities, modes and voices now live in `@/lib/petmind`.

   They moved for one reason: `tsconfig.test.json` has `rootDir: "src/lib"`, so
   nothing under `kernel/` can be unit-tested, and the prompt composition is
   exactly the part worth testing. What a pet says is two axes multiplied
   together, and getting the order wrong makes a pirate talk about being a
   pirate instead of answering.

   Re-exported here so every existing import still resolves. The species
   catalogue below stays, because it is visual description rather than
   behaviour.
   ──────────────────────────────────────────────────────────────────────────── */

export {
  PERSONALITIES, getPersonality, VOICES, getVoice,
  PET_MODES, getMode, composePetPrompt, cannedLine, tidyReply,
  PET_MAX_TOKENS, PET_MAX_WORDS,
} from "@/lib/petmind";
export type { Personality, PetMode, PetContext, PetPromptInput } from "@/lib/petmind";
