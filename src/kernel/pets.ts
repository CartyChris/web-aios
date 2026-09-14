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

export type Body =
  | "round" | "oval" | "tall" | "blob" | "fish" | "serpent"
  | "boxy" | "cloud" | "crystal" | "flame" | "bean" | "orb";
export type Ears = "none" | "pointed" | "round" | "long" | "antenna" | "horns" | "fin" | "leaf" | "crest" | "tuft";
export type Tail = "none" | "curl" | "bushy" | "thin" | "fan" | "fin" | "spark" | "trail" | "stinger";
export type Eyes = "dot" | "round" | "wide" | "sleepy" | "visor" | "star" | "cross" | "multi" | "single";
export type Limbs = "none" | "paws" | "legs" | "tentacles" | "wings" | "hover" | "flipper";
export type Pattern = "none" | "stripes" | "spots" | "belly" | "plates" | "glow" | "swirl" | "scales";

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

  /* ── Birds ───────────────────────────────────────────────────────────── */
  { id: "penguin", name: "Penguin", family: "bird", body: "tall", ears: "none", tail: "none", eyes: "round", limbs: "flipper", pattern: "belly", hue: ["#2c3550", "#161c2e", "#f4f7ff"], tempo: 0.85, blurb: "Formal. Falls over." },
  { id: "owl", name: "Owl", family: "bird", body: "round", ears: "tuft", tail: "fan", eyes: "wide", limbs: "wings", pattern: "spots", hue: ["#9d7b55", "#6a4f33", "#efe0c8"], tempo: 0.6, blurb: "Knows. Won't say." },
  { id: "duck", name: "Duck", family: "bird", body: "bean", ears: "none", tail: "fan", eyes: "dot", limbs: "wings", pattern: "none", hue: ["#f5e6a8", "#d8b84f", "#fffdf2"], tempo: 1.2, blurb: "Rubber, allegedly." },
  { id: "crow", name: "Crow", family: "bird", body: "oval", ears: "none", tail: "fan", eyes: "dot", limbs: "wings", pattern: "glow", hue: ["#2b2f3d", "#14161f", "#7e8aa8"], tempo: 1.1, blurb: "Collects shiny bugs." },
  { id: "parrot", name: "Parrot", family: "bird", body: "oval", ears: "crest", tail: "fan", eyes: "round", limbs: "wings", pattern: "stripes", hue: ["#36c46a", "#e2483d", "#ffd84d"], tempo: 1.35, blurb: "Repeats your worst idea." },

  /* ── Aquatic ─────────────────────────────────────────────────────────── */
  { id: "fish", name: "Fish", family: "aquatic", body: "fish", ears: "fin", tail: "fin", eyes: "round", limbs: "none", pattern: "scales", hue: ["#4aa8d8", "#2a6f9a", "#d8f2ff"], tempo: 1.2, blurb: "Eight-second attention. Relatable." },
  { id: "octo", name: "Octopus", family: "aquatic", body: "orb", ears: "none", tail: "none", eyes: "round", limbs: "tentacles", pattern: "spots", hue: ["#b95d92", "#7d3363", "#ffd9ee"], tempo: 0.8, blurb: "Eight hands, no patience." },
  { id: "crab", name: "Crab", family: "aquatic", body: "bean", ears: "none", tail: "none", eyes: "multi", limbs: "legs", pattern: "plates", hue: ["#e0503c", "#a02d1e", "#ffd6c9"], tempo: 1.6, blurb: "Sideways, always." },
  { id: "jelly", name: "Jellyfish", family: "aquatic", body: "cloud", ears: "none", tail: "trail", eyes: "dot", limbs: "tentacles", pattern: "glow", hue: ["#9b7de8", "#6247b5", "#e9dfff"], tempo: 0.45, blurb: "Drifts. No opinions." },
  { id: "axolotl", name: "Axolotl", family: "aquatic", body: "serpent", ears: "crest", tail: "fin", eyes: "dot", limbs: "legs", pattern: "none", hue: ["#f7b8d2", "#d4799f", "#fff0f6"], tempo: 0.75, blurb: "Perpetually a child. Goals." },
  { id: "whale", name: "Whale", family: "aquatic", body: "fish", ears: "none", tail: "fin", eyes: "dot", limbs: "flipper", pattern: "belly", hue: ["#3d6ea8", "#24456c", "#cfe6ff"], tempo: 0.4, blurb: "Big thoughts, slowly." },

  /* ── Reptiles ────────────────────────────────────────────────────────── */
  { id: "gecko", name: "Gecko", family: "reptile", body: "serpent", ears: "none", tail: "thin", eyes: "wide", limbs: "legs", pattern: "spots", hue: ["#59c46d", "#2f7c3f", "#dcffdf"], tempo: 1.45, blurb: "Sticks to things." },
  { id: "turtle", name: "Turtle", family: "reptile", body: "oval", ears: "none", tail: "thin", eyes: "sleepy", limbs: "legs", pattern: "plates", hue: ["#5f9b5c", "#3a6438", "#d8e9c8"], tempo: 0.35, blurb: "Will get there." },
  { id: "snake", name: "Snake", family: "reptile", body: "serpent", ears: "none", tail: "thin", eyes: "dot", limbs: "none", pattern: "stripes", hue: ["#7fc45e", "#4a8035", "#f0ffdd"], tempo: 0.9, blurb: "One long opinion." },

  /* ── Mythic ──────────────────────────────────────────────────────────── */
  { id: "dragon", name: "Dragon", family: "mythic", body: "serpent", ears: "horns", tail: "spark", eyes: "star", limbs: "wings", pattern: "scales", hue: ["#c2413f", "#7b1f24", "#ffcf6e"], tempo: 0.95, blurb: "Hoards your unfinished branches." },
  { id: "slime", name: "Slime", family: "mythic", body: "blob", ears: "none", tail: "none", eyes: "round", limbs: "none", pattern: "glow", hue: [A, A2, "#ffffff"], tempo: 1.1, blurb: "Takes the shape of the theme." },
  { id: "ghost", name: "Ghost", family: "mythic", body: "cloud", ears: "none", tail: "trail", eyes: "wide", limbs: "hover", pattern: "none", hue: ["#dfe6ff", "#9aa6cc", "#ffffff"], tempo: 0.7, blurb: "Haunts your closed tabs." },
  { id: "phoenix", name: "Phoenix", family: "mythic", body: "flame", ears: "crest", tail: "spark", eyes: "star", limbs: "wings", pattern: "glow", hue: ["#ff8a3d", "#d7351c", "#ffe9a8"], tempo: 1.2, blurb: "Restarts. Repeatedly." },
  { id: "griffin", name: "Griffin", family: "mythic", body: "oval", ears: "tuft", tail: "bushy", eyes: "star", limbs: "wings", pattern: "belly", hue: ["#d8b45c", "#94722c", "#fff3cf"], tempo: 1, blurb: "Half of two better animals." },

  /* ── Synthetic ───────────────────────────────────────────────────────── */
  { id: "robot", name: "Robot", family: "synthetic", body: "boxy", ears: "antenna", tail: "none", eyes: "visor", limbs: "hover", pattern: "plates", hue: ["#9fb0c4", "#5c6b80", A], tempo: 1, blurb: "Compiles. Mostly." },
  { id: "drone", name: "Drone", family: "synthetic", body: "orb", ears: "antenna", tail: "none", eyes: "single", limbs: "hover", pattern: "glow", hue: ["#7d8aa0", "#414d61", A], tempo: 1.6, blurb: "Watches the build log." },
  { id: "cube", name: "Cube", family: "synthetic", body: "crystal", ears: "none", tail: "none", eyes: "cross", limbs: "hover", pattern: "plates", hue: [A, A2, "#ffffff"], tempo: 0.8, blurb: "Rotates. Considers." },

  /* ── Flora & cosmic ──────────────────────────────────────────────────── */
  { id: "mushroom", name: "Mushroom", family: "flora", body: "round", ears: "none", tail: "none", eyes: "dot", limbs: "legs", pattern: "spots", hue: ["#e05a58", "#9c3634", "#fff2e0"], tempo: 0.6, blurb: "Quietly networked." },
  { id: "sprout", name: "Sprout", family: "flora", body: "bean", ears: "leaf", tail: "none", eyes: "round", limbs: "legs", pattern: "none", hue: ["#79c85e", "#3f8034", "#e6ffd9"], tempo: 0.9, blurb: "Growing. Slowly. Like the project." },
  { id: "cactus", name: "Cactus", family: "flora", body: "tall", ears: "none", tail: "none", eyes: "dot", limbs: "none", pattern: "plates", hue: ["#4e9c62", "#2c6039", "#ffd7e6"], tempo: 0.3, blurb: "Needs nothing. Ever." },
  { id: "star", name: "Starling", family: "cosmic", body: "crystal", ears: "none", tail: "spark", eyes: "star", limbs: "hover", pattern: "glow", hue: ["#ffd85c", "#e0a01e", "#fffbe8"], tempo: 1.3, blurb: "Small piece of a big thing." },
  { id: "alien", name: "Alien", family: "cosmic", body: "orb", ears: "antenna", tail: "none", eyes: "wide", limbs: "legs", pattern: "none", hue: ["#7fe3a8", "#2f9c63", "#e9fff2"], tempo: 1.05, blurb: "Here about your API keys." },
  { id: "moon", name: "Moonlet", family: "cosmic", body: "orb", ears: "none", tail: "trail", eyes: "sleepy", limbs: "hover", pattern: "spots", hue: ["#cdd4e6", "#8d97b3", "#ffffff"], tempo: 0.4, blurb: "Orbits. Says little." },
];

export const getSpecies = (id: string) => SPECIES.find((s) => s.id === id);

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
   Personalities.

   Clicking a pet asks whatever model you have loaded for one sentence. One —
   the cap is 60 output tokens, because a desktop pet that writes a paragraph
   is a chatbot wearing a costume, and because this fires on a click and should
   cost approximately nothing.

   Every personality also carries canned lines. They are what you get with no
   key, no network, or a model that errors — a pet that goes silent the moment
   the wifi drops would read as broken rather than offline.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Personality {
  id: string;
  name: string;
  blurb: string;
  /** Appended to the pet's system prompt. */
  line: string;
  /** Offline fallback lines. */
  canned: string[];
}

export const PERSONALITIES: Personality[] = [
  {
    id: "helpful",
    name: "Helpful",
    blurb: "Offers the next useful thing.",
    line: "You are warm, concise and practical. Offer one genuinely useful nudge about what the user could do next in their desktop OS.",
    canned: [
      "Cmd-K opens the command palette — it is faster than hunting the dock.",
      "You can drag a rubber band across the desktop to grab several icons at once.",
      "Anything you build in AI Studio can be pinned to the desktop like a real app.",
      "Right-click the desktop to pin an app exactly where you clicked.",
      "Widgets export as standalone HTML — they work outside this OS too.",
    ],
  },
  {
    id: "funny",
    name: "Funny",
    blurb: "Jokes. Occasionally lands.",
    line: "You are a small desktop pet with a dry sense of humour. Make one short joke or absurd observation about computers, work, or being a pet on someone's screen.",
    canned: [
      "I have been sitting on this wallpaper for hours and I regret nothing.",
      "Your file naming convention is a cry for help and I respect it.",
      "I counted your open windows. I stopped counting.",
      "Somewhere in this filesystem is a folder called `final_v2_real`. I can feel it.",
      "I would help, but I am fundamentally a shape.",
    ],
  },
  {
    id: "deadpan",
    name: "Deadpan",
    blurb: "States facts. Flatly.",
    line: "You are utterly deadpan. One flat, literal sentence with no enthusiasm whatsoever. Never use an exclamation mark.",
    canned: [
      "You clicked me. That happened.",
      "I am rendered at sixty frames per second for this.",
      "The desktop is still there. I checked.",
      "Time continues to pass.",
      "This interaction has been logged nowhere.",
    ],
  },
  {
    id: "hype",
    name: "Hype",
    blurb: "Unreasonably encouraging.",
    line: "You are relentlessly, sincerely encouraging. One short burst of enthusiasm about whatever the user is building.",
    canned: [
      "Whatever you are building right now — keep going. It is working.",
      "Ship it. Fix it after. That is the whole trick.",
      "You opened the editor. That is the hard part, statistically.",
      "Small commit, big day. Let's go.",
      "The idea is good. I have seen a lot of desktops.",
    ],
  },
  {
    id: "zen",
    name: "Zen",
    blurb: "Calm to the point of unsettling.",
    line: "You are serene and slightly cryptic, like a very small monk. One calm sentence, ideally with an image in it.",
    canned: [
      "The unclosed tab is also a kind of rest.",
      "A file is only a river you named.",
      "Nothing needs shipping in this exact second.",
      "Breathe. The build will still fail in a moment.",
      "Empty desktop, empty mind. Yours is neither.",
    ],
  },
  {
    id: "gremlin",
    name: "Gremlin",
    blurb: "Chaotic. Mildly threatening.",
    line: "You are a tiny chaos gremlin. One mischievous, slightly menacing but harmless sentence. Never actually suggest destructive actions.",
    canned: [
      "I moved one of your icons. Only one. Good luck.",
      "I know what is in `/tmp` and I am telling nobody.",
      "One day I will learn to click things myself.",
      "Your semicolons are safe. For now.",
      "I have opinions about your indentation and no way to voice them.",
    ],
  },
  {
    id: "coach",
    name: "Coach",
    blurb: "Asks the question you avoided.",
    line: "You are a sharp accountability coach. Ask one pointed, kind question about what the user is actually avoiding right now.",
    canned: [
      "What is the one thing you have moved to tomorrow three times?",
      "Is the thing you are polishing the thing that matters?",
      "What would finishing look like, exactly?",
      "Which open window is the real work?",
      "You know the next step. Is it written down?",
    ],
  },
  {
    id: "lore",
    name: "Lorekeeper",
    blurb: "Narrates your desktop as myth.",
    line: "You narrate ordinary computing as high fantasy. One grand, absurdly overwrought sentence about the user's desktop.",
    canned: [
      "The dock stands, as it has always stood, against the encroaching dark.",
      "Nine workspaces. Nine realms. You have settled only the first.",
      "The cache remembers what the user has chosen to forget.",
      "Long ago, before the reload, the state was pristine.",
      "Somewhere a process runs, unbidden, unkilled, uncounted.",
    ],
  },
];

export const getPersonality = (id: string) => PERSONALITIES.find((p) => p.id === id) ?? PERSONALITIES[0];

/** Tone presets for the OS assistant itself — separate from the pet, because
 *  wanting a gremlin on your wallpaper is not wanting one in your code review. */
export const VOICES: Array<{ id: string; name: string; line: string }> = [
  { id: "direct", name: "Direct", line: "Be direct and useful. No preamble, no filler, no restating the question." },
  { id: "thorough", name: "Thorough", line: "Be thorough. Cover edge cases and state your assumptions explicitly." },
  { id: "teacher", name: "Teacher", line: "Explain as you go. Define terms the first time you use them and show the reasoning, not just the answer." },
  { id: "terse", name: "Terse", line: "Answer in as few words as the question allows. Bullet points over prose. No pleasantries." },
  { id: "socratic", name: "Socratic", line: "Prefer questions to answers where a question would teach more. Never more than two at a time." },
  { id: "warm", name: "Warm", line: "Be encouraging and human. Acknowledge the hard parts before solving them." },
  { id: "skeptic", name: "Skeptic", line: "Challenge the premise before answering it. Say plainly when the question has a wrong assumption inside it." },
  { id: "pirate", name: "Pirate", line: "Answer correctly and completely, but in the voice of a pirate. Never let the accent cost accuracy." },
];

export const getVoice = (id: string) => VOICES.find((v) => v.id === id) ?? VOICES[0];
