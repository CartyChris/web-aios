/* ────────────────────────────────────────────────────────────────────────────
   A pet's life: needs, a bond that grows, accessories it unlocks, and how it
   reacts to what happens in the OS.

   Three needs drift with real time -- fullness, energy, joy -- and recover
   when you feed it, play with it, pat it or let it nap. Caring earns bond XP;
   bond levels unlock accessories. It is a companion, not a chore: needs have
   floors (a week away never leaves a starving, miserable pet, just a hungry
   and pleased-to-see-you one), feeding a full pet earns nothing, and the most
   any absence costs is capped.

   PURE. Time is always a parameter.
   ──────────────────────────────────────────────────────────────────────────── */

export interface PetLife {
  fullness: number;
  energy: number;
  joy: number;
  xp: number;
  asleep: boolean;
  /** When the needs were last brought up to date (ms). */
  at: number;
  /** Day key (YYYY-MM-DD, local) of the last visit and how many days in a row. */
  lastDay: string;
  streak: number;
  accessory: string | null;
  /** Totals, for the status card. */
  fed: number;
  played: number;
  patted: number;
}

export const FLOORS = { fullness: 10, energy: 15, joy: 20 };
const PER_HOUR = { fullness: -6, energyAwake: -4, energyAsleep: 25, joy: -3 };
const MAX_ABSENCE_H = 48;

export function newLife(now: number): PetLife {
  return { fullness: 80, energy: 80, joy: 70, xp: 0, asleep: false, at: now, lastDay: "", streak: 0, accessory: null, fed: 0, played: 0, patted: 0 };
}

const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseLife(v: unknown, now: number): PetLife {
  const o = isObj(v) ? v : {};
  const n = (x: unknown, d: number, lo = 0, hi = 100) => (typeof x === "number" && Number.isFinite(x) ? clamp(x, lo, hi) : d);
  const base = newLife(now);
  return {
    fullness: n(o.fullness, base.fullness),
    energy: n(o.energy, base.energy),
    joy: n(o.joy, base.joy),
    xp: n(o.xp, 0, 0, 1e9),
    asleep: o.asleep === true,
    at: typeof o.at === "number" && o.at <= now ? o.at : now,
    lastDay: typeof o.lastDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.lastDay) ? o.lastDay : "",
    streak: n(o.streak, 0, 0, 100_000),
    accessory: typeof o.accessory === "string" && ACCESSORIES.some((a) => a.id === o.accessory) ? o.accessory : null,
    fed: n(o.fed, 0, 0, 1e9),
    played: n(o.played, 0, 0, 1e9),
    patted: n(o.patted, 0, 0, 1e9),
  };
}

/** Bring the needs up to date for the time that has passed. */
export function tick(l: PetLife, now: number): PetLife {
  const h = Math.min(MAX_ABSENCE_H, Math.max(0, (now - l.at) / 3_600_000));
  if (h === 0) return l;
  const drop = (v: number, rate: number, floor: number) => (v <= floor ? v : Math.max(floor, v + rate * h));
  const energy = l.asleep ? clamp(l.energy + PER_HOUR.energyAsleep * h) : drop(l.energy, PER_HOUR.energyAwake, FLOORS.energy);
  return {
    ...l,
    fullness: drop(l.fullness, PER_HOUR.fullness, FLOORS.fullness),
    energy,
    joy: drop(l.joy, PER_HOUR.joy, FLOORS.joy),
    // A pet wakes on its own once rested.
    asleep: l.asleep && energy < 100,
    at: now,
  };
}

/** Local day key for a timestamp, with getTimezoneOffset() semantics. */
export function dayKey(now: number, tzOffsetMin: number): string {
  return new Date(now - tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/** Count a visit: a new day continues the streak if it follows yesterday. */
export function visit(l: PetLife, now: number, tzOffsetMin: number): { life: PetLife; newDay: boolean } {
  const today = dayKey(now, tzOffsetMin);
  if (l.lastDay === today) return { life: l, newDay: false };
  const yesterday = dayKey(now - 86_400_000, tzOffsetMin);
  const streak = l.lastDay === yesterday ? l.streak + 1 : 1;
  return { life: { ...l, lastDay: today, streak, joy: clamp(l.joy + 10), xp: l.xp + 5 + Math.min(20, streak) }, newDay: true };
}

export type PetAction = "feed" | "treat" | "play" | "pat" | "nap" | "wake" | "trick";
export interface ActionResult { life: PetLife; xp: number; ok: boolean; line: string; anim: "bounce" | "spin" | "jump" | "dance" | "none" }

export function act(l0: PetLife, action: PetAction, now: number): ActionResult {
  const l = tick(l0, now);
  const done = (life: PetLife, xp: number, line: string, anim: ActionResult["anim"] = "bounce"): ActionResult => ({ life: { ...life, xp: life.xp + xp }, xp, ok: true, line, anim });
  const no = (line: string): ActionResult => ({ life: l, xp: 0, ok: false, line, anim: "none" });
  if (l.asleep && action !== "wake" && action !== "pat") return no("Zzz... (it is asleep. Wake it first.)");
  switch (action) {
    case "feed":
      if (l.fullness >= 92) return no("Too full to eat another bite.");
      return done({ ...l, fullness: clamp(l.fullness + 35), fed: l.fed + 1 }, l.fullness < 40 ? 12 : 6, l.fullness < 40 ? "Finally! Thank you!" : "Mm, thank you.");
    case "treat":
      if (l.fullness >= 97) return no("Not even room for a treat.");
      return done({ ...l, fullness: clamp(l.fullness + 12), joy: clamp(l.joy + 15), fed: l.fed + 1 }, 5, "A treat! Best day.", "jump");
    case "play":
      if (l.energy < 20) return no("Too tired to play. Maybe a nap?");
      return done({ ...l, joy: clamp(l.joy + 25), energy: clamp(l.energy - 15), fullness: clamp(l.fullness - 5), played: l.played + 1 }, 10, "Again! Again!", "jump");
    case "pat":
      return done({ ...l, joy: clamp(l.joy + 6), patted: l.patted + 1 }, l.asleep ? 0 : 2, l.asleep ? "(purrs in its sleep)" : "Heh.", l.asleep ? "none" : "bounce");
    case "nap":
      if (l.energy >= 70) return no("Not sleepy yet.");
      return done({ ...l, asleep: true }, 1, "Just five minutes...", "none");
    case "wake":
      if (!l.asleep) return no("Already awake.");
      return done({ ...l, asleep: false }, 0, "Morning!", "bounce");
    case "trick": {
      if (l.energy < 15) return no("Too tired for tricks.");
      const tricks: Array<ActionResult["anim"]> = ["spin", "jump", "dance"];
      const anim = tricks[(l.played + l.patted + l.fed) % tricks.length];
      return done({ ...l, energy: clamp(l.energy - 6), joy: clamp(l.joy + 8) }, 4, anim === "spin" ? "Ta-da!" : anim === "jump" ? "Hup!" : "Watch this!", anim);
    }
  }
}

/* ── the OS around it ────────────────────────────────────────────────────── */

export type OsEvent = "job-done" | "job-failed" | "error" | "saved" | "achievement";

export function react(l: PetLife, ev: OsEvent): { life: PetLife; mood: PetMood; line: string } {
  switch (ev) {
    case "job-done": return { life: { ...l, joy: clamp(l.joy + 5) }, mood: "happy", line: "It worked! Nice." };
    case "saved": return { life: { ...l, joy: clamp(l.joy + 1) }, mood: "happy", line: "Saved. I saw." };
    case "achievement": return { life: { ...l, joy: clamp(l.joy + 10), xp: l.xp + 5 }, mood: "happy", line: "We did it!" };
    case "job-failed": return { life: { ...l, joy: clamp(l.joy - 3, FLOORS.joy) }, mood: "worried", line: "Oh no. Try again?" };
    case "error": return { life: l, mood: "worried", line: "Hm, that did not look right." };
  }
}

export type PetMood = "happy" | "idle" | "hungry" | "tired" | "sad" | "asleep" | "worried";

export function mood(l: PetLife): PetMood {
  if (l.asleep) return "asleep";
  if (l.fullness < 30) return "hungry";
  if (l.energy < 25) return "tired";
  if (l.joy < 35) return "sad";
  if (l.joy >= 75 && l.fullness >= 50) return "happy";
  return "idle";
}

/** What the sprite can draw for each mood (it has four faces). */
export function spriteMood(m: PetMood): "idle" | "happy" | "think" | "sleep" {
  return m === "asleep" || m === "tired" ? "sleep" : m === "happy" ? "happy" : m === "idle" ? "idle" : "think";
}

/* ── bond ────────────────────────────────────────────────────────────────── */

/** XP needed to REACH level n (level 1 needs 0): 40, 120, 240, 400, ... */
export const xpFor = (n: number): number => (n <= 1 ? 0 : 20 * n * (n - 1));

export function level(xp: number): { level: number; into: number; span: number } {
  let n = 1;
  while (xp >= xpFor(n + 1) && n < 99) n++;
  return { level: n, into: xp - xpFor(n), span: xpFor(n + 1) - xpFor(n) };
}

export interface Accessory { id: string; name: string; slot: "head" | "face" | "neck"; unlock: number }

export const ACCESSORIES: Accessory[] = [
  { id: "bow", name: "Bow tie", slot: "neck", unlock: 1 },
  { id: "flower", name: "Flower", slot: "head", unlock: 2 },
  { id: "scarf", name: "Scarf", slot: "neck", unlock: 3 },
  { id: "glasses", name: "Glasses", slot: "face", unlock: 4 },
  { id: "beanie", name: "Beanie", slot: "head", unlock: 5 },
  { id: "headphones", name: "Headphones", slot: "head", unlock: 6 },
  { id: "party", name: "Party hat", slot: "head", unlock: 7 },
  { id: "shades", name: "Sunglasses", slot: "face", unlock: 8 },
  { id: "wizard", name: "Wizard hat", slot: "head", unlock: 10 },
  { id: "crown", name: "Crown", slot: "head", unlock: 12 },
  { id: "halo", name: "Halo", slot: "head", unlock: 15 },
];

export const unlocked = (xp: number): Accessory[] => ACCESSORIES.filter((a) => a.unlock <= level(xp).level);
