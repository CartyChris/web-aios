"use client";

import { useEffect, useId, useRef, useState } from "react";
import { getSpecies, useCustomPets, type Species } from "@/kernel/pets";
import { composePetPrompt, cannedLine, tidyReply, PET_MAX_TOKENS } from "@/lib/petmind";
import { useWM } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { ask } from "@/lib/useAI";
import { bus } from "@/kernel/bus";
import { cn } from "@/lib/cn";
import { EGGS, useEggs } from "@/lib/easter";
import { usePetLife } from "@/kernel/petlife";
import { useJobs } from "@/kernel/jobs";
import { registerContextTarget } from "@/kernel/ctxmenu";
import { mood as lifeMood, spriteMood, level, unlocked, ACCESSORIES, type PetAction, type PetMood } from "@/lib/petlife";

/* ────────────────────────────────────────────────────────────────────────────
   Pet rendering.

   A species is a description (see kernel/pets.ts); this file turns one into an
   SVG sprite. Every part is a function of the spec, so a new creature costs a
   line of data rather than a drawing, and the same description renders at
   three fidelities:

     basic       outline only, currentColor, no fills — the old pets, kept,
                 because on a phosphor or Amiga profile they are the right look
     detailed    filled body, shading, belly, pattern, contact shadow
     expressive  detailed, plus blinking, breathing, a swaying tail and the
                 idle motion of whatever the creature is

   All of it is one 100×100 viewBox, so pets compose at any size without a
   second set of assets.
   ──────────────────────────────────────────────────────────────────────────── */

export type Detail = "basic" | "detailed" | "expressive";

interface SpriteProps {
  species: Species;
  detail?: Detail;
  size?: number;
  /** Mood tilts the mouth and eyes without needing separate artwork. */
  mood?: "idle" | "happy" | "think" | "sleep";
  className?: string;
  /** Pets on a wallpaper need a rim so they read against any background. */
  outlined?: boolean;
  /** An accessory from lib/petlife.ts ACCESSORIES, drawn on the head, face or neck. */
  accessory?: string | null;
}

/* ── Body silhouettes ─────────────────────────────────────────────────────
   Each returns a path for a creature roughly 48 wide, sitting so its feet
   land near y=84 — the shared baseline every limb and shadow is drawn to. */
function bodyPath(b: Species["body"]): string {
  switch (b) {
    case "round":
      return "M50 26a27 27 0 0 1 27 29c0 17-12 29-27 29S23 72 23 55a27 27 0 0 1 27-29z";
    case "oval":
      return "M50 24c14 0 24 13 24 30s-10 30-24 30-24-13-24-30 10-30 24-30z";
    case "tall":
      return "M50 18c12 0 19 9 19 21v26c0 12-7 19-19 19s-19-7-19-19V39c0-12 7-21 19-21z";
    case "blob":
      return "M50 26c16 0 29 12 29 27 0 12-8 21-20 24-6 1.5-12 1.5-18 0-12-3-20-12-20-24 0-15 13-27 29-27z";
    case "bean":
      return "M32 40c6-14 24-18 34-8 9 9 8 24 1 34-8 11-26 14-35 5-8-8-6-21 0-31z";
    case "orb":
      return "M50 25a28 28 0 1 1 0 56 28 28 0 0 1 0-56z";
    case "fish":
      return "M24 55c8-16 20-24 32-24s21 8 26 24c-5 16-14 24-26 24s-24-8-32-24z";
    case "serpent":
      return "M30 34c0-8 7-13 15-13 9 0 15 6 15 14 0 9-10 12-10 20 0 7 8 9 12 13 4 4 4 12-2 15-7 4-16 1-19-5-3-7 2-12 2-18 0-9-13-15-13-26z";
    case "boxy":
      return "M31 26h38a6 6 0 0 1 6 6v42a6 6 0 0 1-6 6H31a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z";
    case "cloud":
      return "M22 58a28 28 0 0 1 56 0v26l-7-6-7 6-7-6-7 6-7-6-7 6-7-6-7 6z";
    case "crystal":
      return "M50 18 76 40 68 78H32L24 40z";
    case "flame":
      return "M50 16c10 12 22 18 22 34a22 22 0 0 1-44 0c0-10 6-14 10-21 3 6 6 8 8 5 3-4 0-11 4-18z";
  }
}

/** Where the face sits — a tall body wants its eyes higher than a round one. */
function faceY(b: Species["body"]): number {
  switch (b) {
    case "tall": return 44;
    case "serpent": return 32;
    case "crystal": return 46;
    case "flame": return 50;
    case "cloud": return 50;
    case "fish": return 48;
    default: return 50;
  }
}

function faceX(b: Species["body"]): number {
  return b === "serpent" ? 44 : b === "fish" ? 54 : 50;
}

const shade = (hex: string, amt: number) => {
  // Theme tokens are passed straight through — colour-mix does the darkening
  // in the browser, where the token's actual value is known.
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${100 - amt}%, #000)`;
  return hex;
};

export function PetSprite({ species: sp, detail = "detailed", size = 64, mood = "idle", className, outlined, accessory }: SpriteProps) {
  const uid = useId().replace(/:/g, "");
  const flat = detail === "basic";
  const live = detail === "expressive";
  const [base, dark, light] = sp.hue;
  const fx = faceX(sp.body);
  const fy = faceY(sp.body);
  const speed = 1 / (sp.tempo || 1);

  const stroke = flat ? "currentColor" : shade(dark, 18);
  const fill = flat ? "none" : base;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("pet-sprite", className)}
      style={{ ["--pet-speed" as string]: `${(2.6 * speed).toFixed(2)}s`, overflow: "visible" }}
      aria-hidden
    >
      <defs>
        <clipPath id={`body-${uid}`}><path d={bodyPath(sp.body)} /></clipPath>
        {!flat && (
          <radialGradient id={`lit-${uid}`} cx="36%" cy="28%" r="78%">
            <stop offset="0%" stopColor={light} stopOpacity={0.55} />
            <stop offset="100%" stopColor={light} stopOpacity={0} />
          </radialGradient>
        )}
      </defs>

      {/* Contact shadow. Without one the creature floats off the wallpaper
          instead of sitting on it. */}
      {!flat && (
        <ellipse
          cx="50" cy="90" rx="24" ry="5"
          fill="#000" opacity={0.22}
          className={live ? "pet-shadow" : undefined}
        />
      )}

      <g className={live ? (sp.limbs === "hover" ? "pet-hover" : "pet-breathe") : undefined} style={{ transformOrigin: "50px 84px" }}>
        {/* Behind-body parts first so they tuck under it. */}
        <Limbs sp={sp} flat={flat} live={live} stroke={stroke} base={base} dark={dark} />
        <Tail sp={sp} flat={flat} live={live} stroke={stroke} base={base} light={light} />
        <Ears sp={sp} flat={flat} stroke={stroke} base={base} light={light} />

        {/* Body */}
        <path d={bodyPath(sp.body)} fill={fill} stroke={stroke} strokeWidth={flat ? 3.2 : outlined ? 2.6 : 2} strokeLinejoin="round" />

        {!flat && (
          <g clipPath={`url(#body-${uid})`}>
            <Pattern sp={sp} light={light} dark={dark} />
            <path d={bodyPath(sp.body)} fill={`url(#lit-${uid})`} />
          </g>
        )}

        <Face sp={sp} x={fx} y={fy} flat={flat} live={live} mood={mood} light={light} />
        {accessory && <AccessoryArt id={accessory} x={fx} y={fy} />}
      </g>
    </svg>
  );
}

/* ── Parts ────────────────────────────────────────────────────────────────── */

function Ears({ sp, flat, stroke, base, light }: { sp: Species; flat: boolean; stroke: string; base: string; light: string }) {
  const f = flat ? "none" : base;
  const w = flat ? 3.2 : 2;
  switch (sp.ears) {
    case "pointed":
      return <g fill={f} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M31 33 27 13l16 10z" /><path d="M69 33 73 13 57 23z" />
        {!flat && <><path d="M32 30 30 19l8 5z" fill={light} stroke="none" opacity={0.75} /><path d="M68 30 70 19l-8 5z" fill={light} stroke="none" opacity={0.75} /></>}
      </g>;
    case "round":
      return <g fill={f} stroke={stroke} strokeWidth={w}>
        <circle cx="30" cy="26" r="9" /><circle cx="70" cy="26" r="9" />
        {!flat && <><circle cx="30" cy="26" r="4.5" fill={light} stroke="none" opacity={0.7} /><circle cx="70" cy="26" r="4.5" fill={light} stroke="none" opacity={0.7} /></>}
      </g>;
    case "long":
      return <g fill={f} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M37 32c-5-2-9-12-7-20 2-7 9-5 11 2 2 6 1 16-4 18z" />
        <path d="M63 32c5-2 9-12 7-20-2-7-9-5-11 2-2 6-1 16 4 18z" />
      </g>;
    case "antenna":
      return <g fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round">
        <path d="M40 24 34 10M60 24l6-14" />
        <circle cx="34" cy="8" r="3.4" fill={flat ? "none" : light} /><circle cx="66" cy="8" r="3.4" fill={flat ? "none" : light} />
      </g>;
    case "horns":
      return <g fill={f} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M34 26c-4-6-10-8-14-6 4 1 7 5 8 11z" /><path d="M66 26c4-6 10-8 14-6-4 1-7 5-8 11z" />
      </g>;
    case "fin":
      return <path d="M50 20c8 4 12 10 13 17-5-4-9-6-13-6s-8 2-13 6c1-7 5-13 13-17z" fill={f} stroke={stroke} strokeWidth={w} strokeLinejoin="round" />;
    case "leaf":
      return <g fill={flat ? "none" : light} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M46 26c-8-3-14-11-12-18 8-1 14 6 15 15z" /><path d="M54 26c8-3 14-11 12-18-8-1-14 6-15 15z" />
      </g>;
    case "crest":
      return <g fill={flat ? "none" : light} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M50 24c-2-8 2-14 7-17-1 6 1 10 4 13z" /><path d="M44 25c-4-6-3-13 0-17 1 6 3 9 6 11z" />
      </g>;
    case "tuft":
      return <g fill={f} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M33 29c-3-6-3-11-1-14 3 3 6 6 7 11z" /><path d="M67 29c3-6 3-11 1-14-3 3-6 6-7 11z" />
      </g>;
    default:
      return null;
  }
}

function Tail({ sp, flat, live, stroke, base, light }: { sp: Species; flat: boolean; live: boolean; stroke: string; base: string; light: string }) {
  const f = flat ? "none" : base;
  const w = flat ? 3.2 : 2;
  const cls = live ? "pet-tail" : undefined;
  const origin = { transformOrigin: "72px 72px" } as const;
  switch (sp.tail) {
    case "curl":
      return <path className={cls} style={origin} d="M72 72c10 2 16-3 16-10s-8-11-12-5" fill="none" stroke={stroke} strokeWidth={flat ? 3.2 : 4} strokeLinecap="round" />;
    case "bushy":
      return <path className={cls} style={origin} d="M70 70c14 0 22-8 22-18 0-8-6-13-11-11-6 2-5 10-11 14-4 3-8 4-12 4z" fill={f} stroke={stroke} strokeWidth={w} strokeLinejoin="round" />;
    case "thin":
      return <path className={cls} style={origin} d="M70 74c10 4 17 1 20-6" fill="none" stroke={stroke} strokeWidth={flat ? 3 : 3.4} strokeLinecap="round" />;
    case "fan":
      return <path className={cls} style={origin} d="M70 66c8-2 14-8 18-16 2 10 0 22-6 28-5 5-12 4-14-2z" fill={flat ? "none" : light} stroke={stroke} strokeWidth={w} strokeLinejoin="round" />;
    case "fin":
      return <path className={cls} style={origin} d="M74 56c8-9 13-13 18-14-3 8-3 20 0 28-5-1-10-5-18-14z" fill={flat ? "none" : light} stroke={stroke} strokeWidth={w} strokeLinejoin="round" />;
    case "spark":
      return <g className={cls} style={origin} fill={flat ? "none" : light} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M70 70c10 0 16-6 18-14 4 7 4 16-1 21-5 6-13 5-17-1z" />
      </g>;
    case "trail":
      return <g className={live ? "pet-drift" : undefined} fill="none" stroke={stroke} strokeWidth={flat ? 2.6 : 2.8} strokeLinecap="round" opacity={flat ? 1 : 0.85}>
        <path d="M38 84c-2 7-1 12 2 15M50 86c-1 8 0 13 3 16M62 84c2 7 1 12-2 15" />
      </g>;
    case "stinger":
      return <path className={cls} style={origin} d="M72 74c10 2 15-2 16-9l5 5" fill="none" stroke={stroke} strokeWidth={3.2} strokeLinecap="round" />;
    default:
      return null;
  }
}

function Limbs({ sp, flat, live, stroke, base, dark }: { sp: Species; flat: boolean; live: boolean; stroke: string; base: string; dark: string }) {
  const f = flat ? "none" : base;
  const w = flat ? 3.2 : 2;
  switch (sp.limbs) {
    case "paws":
      return <g fill={f} stroke={stroke} strokeWidth={w}>
        <ellipse cx="39" cy="83" rx="8" ry="5.5" /><ellipse cx="61" cy="83" rx="8" ry="5.5" />
      </g>;
    case "legs":
      return <g fill="none" stroke={stroke} strokeWidth={flat ? 3 : 3.4} strokeLinecap="round">
        <path d="M40 78v9M60 78v9M33 72l-8 6M67 72l8 6" />
      </g>;
    case "flipper":
      return <g fill={f} stroke={stroke} strokeWidth={w} strokeLinejoin="round">
        <path d="M28 54c-6 6-8 16-4 22 4-3 6-10 7-17z" /><path d="M72 54c6 6 8 16 4 22-4-3-6-10-7-17z" />
        <ellipse cx="41" cy="85" rx="8" ry="4" /><ellipse cx="59" cy="85" rx="8" ry="4" />
      </g>;
    case "tentacles":
      return <g className={live ? "pet-drift" : undefined} fill="none" stroke={stroke} strokeWidth={flat ? 3 : 3.4} strokeLinecap="round">
        <path d="M33 72c-3 8-7 12-11 13M42 78c-2 8-4 13-7 15M50 80c0 8-1 13-2 16M58 78c2 8 4 13 7 15M67 72c3 8 7 12 11 13" />
      </g>;
    case "wings":
      return <g className={live ? "pet-flap" : undefined} style={{ transformOrigin: "50px 54px" }} fill={flat ? "none" : dark} stroke={stroke} strokeWidth={w} strokeLinejoin="round" opacity={flat ? 1 : 0.92}>
        <path d="M30 50C18 44 8 46 4 54c8 1 12 6 14 12 6-4 10-8 12-16z" />
        <path d="M70 50c12-6 22-4 26 4-8 1-12 6-14 12-6-4-10-8-12-16z" />
      </g>;
    case "hover":
      return live ? <ellipse className="pet-thrust" cx="50" cy="88" rx="14" ry="3.5" fill={dark} opacity={0.35} /> : null;
    default:
      return null;
  }
}

function Pattern({ sp, light, dark }: { sp: Species; light: string; dark: string }) {
  switch (sp.pattern) {
    case "stripes":
      return <g stroke={dark} strokeWidth={5} opacity={0.35} strokeLinecap="round">
        <path d="M26 42h48M26 56h48M26 70h48" />
      </g>;
    case "spots":
      return <g fill={dark} opacity={0.3}>
        <circle cx="34" cy="44" r="5" /><circle cx="66" cy="66" r="6" /><circle cx="62" cy="38" r="3.5" /><circle cx="38" cy="70" r="4" />
      </g>;
    case "belly":
      return <ellipse cx="50" cy="66" rx="16" ry="18" fill={light} opacity={0.75} />;
    case "plates":
      return <g fill="none" stroke={dark} strokeWidth={2.4} opacity={0.4}>
        <path d="M26 46h48M26 62h48M50 30v54" />
      </g>;
    case "glow":
      return <g fill={light} opacity={0.4}>
        <circle cx="50" cy="58" r="17" />
      </g>;
    case "swirl":
      return <path d="M50 58c-8 0-12-5-12-10s5-9 10-9 9 4 9 9-4 8-8 8" fill="none" stroke={dark} strokeWidth={3} opacity={0.4} />;
    case "scales":
      return <g fill="none" stroke={dark} strokeWidth={2} opacity={0.35}>
        <path d="M32 46a6 6 0 0 1 12 0M44 46a6 6 0 0 1 12 0M56 46a6 6 0 0 1 12 0M32 60a6 6 0 0 1 12 0M44 60a6 6 0 0 1 12 0M56 60a6 6 0 0 1 12 0M38 74a6 6 0 0 1 12 0M50 74a6 6 0 0 1 12 0" />
      </g>;
    default:
      return null;
  }
}

function Face({ sp, x, y, flat, live, mood, light }: {
  sp: Species; x: number; y: number; flat: boolean; live: boolean;
  mood: "idle" | "happy" | "think" | "sleep"; light: string;
}) {
  const ink = flat ? "currentColor" : "#151a24";
  const sleeping = mood === "sleep" || sp.eyes === "sleepy";
  const blink = live && !sleeping ? "pet-blink" : undefined;
  const sx = 9; // eye separation from centre

  const eyes = () => {
    if (sleeping) {
      return <g fill="none" stroke={ink} strokeWidth={2.4} strokeLinecap="round">
        <path d={`M${x - sx - 4} ${y} a4.5 4.5 0 0 0 9 0M${x + sx - 5} ${y} a4.5 4.5 0 0 0 9 0`} />
      </g>;
    }
    switch (sp.eyes) {
      case "dot":
        return <g fill={ink} className={blink} style={{ transformOrigin: `${x}px ${y}px` }}>
          <circle cx={x - sx} cy={y} r="2.6" /><circle cx={x + sx} cy={y} r="2.6" />
        </g>;
      case "round":
        return <g className={blink} style={{ transformOrigin: `${x}px ${y}px` }}>
          <circle cx={x - sx} cy={y} r="4.4" fill={ink} /><circle cx={x + sx} cy={y} r="4.4" fill={ink} />
          {!flat && <><circle cx={x - sx + 1.6} cy={y - 1.6} r="1.5" fill="#fff" /><circle cx={x + sx + 1.6} cy={y - 1.6} r="1.5" fill="#fff" /></>}
        </g>;
      case "wide":
        return <g className={blink} style={{ transformOrigin: `${x}px ${y}px` }}>
          <ellipse cx={x - sx - 1} cy={y} rx="6" ry="7" fill={flat ? "none" : "#fff"} stroke={ink} strokeWidth={flat ? 2.6 : 1.6} />
          <ellipse cx={x + sx + 1} cy={y} rx="6" ry="7" fill={flat ? "none" : "#fff"} stroke={ink} strokeWidth={flat ? 2.6 : 1.6} />
          <circle cx={x - sx - 1} cy={y + 1} r="2.8" fill={ink} /><circle cx={x + sx + 1} cy={y + 1} r="2.8" fill={ink} />
        </g>;
      case "visor":
        return <g>
          <rect x={x - 15} y={y - 5} width="30" height="11" rx="5.5" fill={flat ? "none" : "#101720"} stroke={ink} strokeWidth={flat ? 2.6 : 1.6} />
          <rect className={live ? "pet-scan" : undefined} x={x - 10} y={y - 1.6} width="8" height="3.4" rx="1.7" fill={flat ? "currentColor" : light} />
        </g>;
      case "single":
        return <g>
          <circle cx={x} cy={y} r="9" fill={flat ? "none" : "#101720"} stroke={ink} strokeWidth={flat ? 2.6 : 1.6} />
          <circle className={live ? "pet-iris" : undefined} style={{ transformOrigin: `${x}px ${y}px` }} cx={x} cy={y} r="4" fill={flat ? "currentColor" : light} />
        </g>;
      case "star":
        return <g fill={flat ? "none" : light} stroke={ink} strokeWidth={flat ? 2.4 : 1.4} strokeLinejoin="round" className={live ? "pet-twinkle" : undefined} style={{ transformOrigin: `${x}px ${y}px` }}>
          <path d={`M${x - sx} ${y - 6} 2 4 4 2-4 2-2 4-2-4-4-2 4-2z`} />
          <path d={`M${x + sx} ${y - 6} 2 4 4 2-4 2-2 4-2-4-4-2 4-2z`} />
        </g>;
      case "cross":
        return <g stroke={ink} strokeWidth={2.6} strokeLinecap="round">
          <path d={`M${x - sx - 3} ${y - 3} 6 6M${x - sx + 3} ${y - 3}-6 6M${x + sx - 3} ${y - 3} 6 6M${x + sx + 3} ${y - 3}-6 6`} />
        </g>;
      case "multi":
        return <g className={blink} style={{ transformOrigin: `${x}px ${y}px` }}>
          <g stroke={ink} strokeWidth={2.2}><path d={`M${x - sx} ${y - 4}v-7M${x + sx} ${y - 4}v-7`} /></g>
          <circle cx={x - sx} cy={y - 13} r="3.6" fill={ink} /><circle cx={x + sx} cy={y - 13} r="3.6" fill={ink} />
        </g>;
      default:
        return null;
    }
  };

  const mouth = () => {
    const my = y + 12;
    if (sp.eyes === "visor" || sp.eyes === "cross") return null;
    if (mood === "happy") return <path d={`M${x - 6} ${my - 2}a6 6 0 0 0 12 0`} fill="none" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />;
    if (mood === "think") return <path d={`M${x - 5} ${my} h10`} fill="none" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />;
    if (mood === "sleep") return <path d={`M${x - 4} ${my}a4 4 0 0 0 8 0`} fill="none" stroke={ink} strokeWidth={2} strokeLinecap="round" />;
    return <path d={`M${x - 5} ${my - 1}q5 4 10 0`} fill="none" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />;
  };

  return (
    <g>
      {eyes()}
      {mouth()}
      {/* Cheeks read as "alive" for almost no cost, but only where there is
          fill to sit them on. */}
      {!flat && sp.family !== "synthetic" && (
        <g fill="#ff8aa0" opacity={0.3}>
          <ellipse cx={x - sx - 8} cy={y + 7} rx="4" ry="2.6" /><ellipse cx={x + sx + 8} cy={y + 7} rx="4" ry="2.6" />
        </g>
      )}
      {mood === "sleep" && (
        <g fill="none" stroke={ink} strokeWidth={2} opacity={0.7} className={live ? "pet-z" : undefined}>
          <path d={`M${x + 20} ${y - 18}h7l-7 8h7`} />
        </g>
      )}
    </g>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   The live pet on the desktop.

   Clicking it asks whichever model is configured for exactly one sentence, in
   the personality you chose, capped at 60 output tokens. If there is no key,
   no network, or the call errors, it says one of its canned lines instead —
   a pet that goes mute the moment wifi drops reads as broken, not offline.
   ──────────────────────────────────────────────────────────────────────────── */

/* ── Accessories (unlocked by bond level; lib/petlife.ts) ───────────────────
   Drawn in the sprite's own 100x100 space relative to where its face is, so
   one drawing fits every body shape. */
function AccessoryArt({ id, x, y }: { id: string; x: number; y: number }) {
  const ink = "#1b1b24";
  switch (id) {
    case "bow": return <g data-accessory="bow"><path d={`M${x} ${y + 17}l-9 -5v10z M${x} ${y + 17}l9 -5v10z`} fill="#e0344b" stroke={ink} strokeWidth={1.2} strokeLinejoin="round" /><circle cx={x} cy={y + 17} r={2.2} fill="#b8243a" /></g>;
    case "flower": return <g data-accessory="flower">{[0, 72, 144, 216, 288].map((a) => <circle key={a} cx={x + 13 + 4 * Math.cos((a * Math.PI) / 180)} cy={y - 21 + 4 * Math.sin((a * Math.PI) / 180)} r={3.4} fill="#ff8fc7" />)}<circle cx={x + 13} cy={y - 21} r={2.4} fill="#ffd43b" /></g>;
    case "scarf": return <g data-accessory="scarf"><rect x={x - 17} y={y + 13} width={34} height={7} rx={3.5} fill="#4dabf7" stroke={ink} strokeWidth={1} /><rect x={x + 7} y={y + 17} width={6} height={13} rx={2} fill="#339af0" stroke={ink} strokeWidth={1} /></g>;
    case "glasses": return <g data-accessory="glasses" fill="none" stroke={ink} strokeWidth={1.6}><circle cx={x - 8} cy={y - 3} r={5.2} /><circle cx={x + 8} cy={y - 3} r={5.2} /><path d={`M${x - 2.8} ${y - 3}h5.6`} /></g>;
    case "shades": return <g data-accessory="shades"><rect x={x - 14} y={y - 7} width={11} height={7} rx={2.5} fill={ink} /><rect x={x + 3} y={y - 7} width={11} height={7} rx={2.5} fill={ink} /><path d={`M${x - 3} ${y - 5}h6`} stroke={ink} strokeWidth={1.6} /></g>;
    case "beanie": return <g data-accessory="beanie"><path d={`M${x - 16} ${y - 18}a16 13 0 0 1 32 0z`} fill="#fa5252" stroke={ink} strokeWidth={1.2} /><rect x={x - 17} y={y - 20} width={34} height={5} rx={2.5} fill="#e03131" stroke={ink} strokeWidth={1} /><circle cx={x} cy={y - 33} r={3.5} fill="#fff" stroke={ink} strokeWidth={1} /></g>;
    case "headphones": return <g data-accessory="headphones"><path d={`M${x - 19} ${y - 6}a19 19 0 0 1 38 0`} fill="none" stroke={ink} strokeWidth={3} /><rect x={x - 23} y={y - 9} width={7} height={11} rx={3} fill="#495057" /><rect x={x + 16} y={y - 9} width={7} height={11} rx={3} fill="#495057" /></g>;
    case "party": return <g data-accessory="party"><path d={`M${x - 9} ${y - 18}L${x} ${y - 42}L${x + 9} ${y - 18}z`} fill="#7950f2" stroke={ink} strokeWidth={1.2} strokeLinejoin="round" /><path d={`M${x - 6} ${y - 26}l12 -2M${x - 3.5} ${y - 33}l7 -1.5`} stroke="#ffd43b" strokeWidth={2} /><circle cx={x} cy={y - 43} r={3} fill="#ffd43b" /></g>;
    case "wizard": return <g data-accessory="wizard"><path d={`M${x - 20} ${y - 16}h40`} stroke="#364fc7" strokeWidth={4} strokeLinecap="round" /><path d={`M${x - 11} ${y - 17}L${x + 4} ${y - 50}L${x + 11} ${y - 17}z`} fill="#4263eb" stroke={ink} strokeWidth={1.2} strokeLinejoin="round" /><path d={`M${x + 1} ${y - 32}l1.3 2.7 3 .4-2.2 2 .6 3-2.7-1.4-2.7 1.4.6-3-2.2-2 3-.4z`} fill="#ffd43b" /></g>;
    case "crown": return <g data-accessory="crown"><path d={`M${x - 13} ${y - 17}L${x - 14} ${y - 31}L${x - 7} ${y - 24}L${x} ${y - 34}L${x + 7} ${y - 24}L${x + 14} ${y - 31}L${x + 13} ${y - 17}z`} fill="#fcc419" stroke={ink} strokeWidth={1.2} strokeLinejoin="round" /><circle cx={x} cy={y - 22} r={2} fill="#e03131" /></g>;
    case "halo": return <ellipse data-accessory="halo" cx={x} cy={y - 32} rx={14} ry={4} fill="none" stroke="#ffe066" strokeWidth={3} opacity={0.95} />;
    default: return null;
  }
}

export function PetLayer() {
  const s = useSettings();
  // Subscribed so an AI-made pet appears as soon as its store hydrates.
  const custom = useCustomPets((c) => c.pets);
  const sp = getSpecies(s.pet) ?? custom.find((p) => p.id === s.pet);
  const [say, setSay] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [bounce, setBounce] = useState(0);
  // Where the pet *drifts* to. In "still" mode the stored position wins, so
  // there is nothing to synchronise and no effect writing state after render.
  const [drift, setDrift] = useState(s.petPos);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const pats = useRef(0);
  const petId = sp?.id ?? "";
  const life = usePetLife((l) => (petId ? l.lives[petId] : undefined));
  const [reaction, setReaction] = useState<PetMood | null>(null);
  const [trick, setTrick] = useState<{ anim: string; k: number } | null>(null);
  const [card, setCard] = useState(false);
  const [ball, setBall] = useState<{ x: number; y: number } | null>(null);
  const [fetchPos, setFetchPos] = useState<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const reactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (line: string, ms = 4500) => {
    setSay(line);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setSay(null), ms);
  };
  const flash = (m: PetMood, ms = 6000) => {
    setReaction(m);
    if (reactTimer.current) clearTimeout(reactTimer.current);
    reactTimer.current = setTimeout(() => setReaction(null), ms);
  };

  // Needs catch up now, then every minute; a new day greets you (and counts the streak).
  useEffect(() => {
    if (!petId || !s.petVisible) return;
    const r = usePetLife.getState().refresh(petId);
    if (r.newDay && r.life.streak > 1) setTimeout(() => show(`Day ${r.life.streak} together!`, 5000), 1200);
    const t = setInterval(() => usePetLife.getState().refresh(petId), 60_000);
    return () => clearInterval(t);
  }, [petId, s.petVisible]);

  // It notices the OS: finished work cheers it up, failures worry it.
  useEffect(() => {
    if (!petId || !s.petVisible) return;
    let prev = new Map(useJobs.getState().jobs.map((j) => [j.id, j.status]));
    const unsub = useJobs.subscribe((st) => {
      for (const j of st.jobs) {
        const was = prev.get(j.id);
        if (was === j.status) continue;
        if (j.status === "done" && was) { const r = usePetLife.getState().react(petId, "job-done"); flash(r.mood); show(r.line, 3500); }
        if ((j.status === "error" || j.status === "timeout") && was) { const r = usePetLife.getState().react(petId, "job-failed"); flash(r.mood); show(r.line, 4000); }
      }
      prev = new Map(st.jobs.map((j) => [j.id, j.status]));
    });
    const off = bus.on("notify", (p) => { if ((p as { kind?: string })?.kind === "error") { const r = usePetLife.getState().react(petId, "error"); flash(r.mood, 4000); } });
    return () => { unsub(); off(); };
  }, [petId, s.petVisible]);

  const doAct = (a: PetAction) => {
    if (!petId) return;
    const before = level(usePetLife.getState().get(petId).xp).level;
    const r = usePetLife.getState().act(petId, a);
    show(r.line);
    if (r.anim !== "none") setTrick({ anim: r.anim, k: Date.now() });
    const after = level(r.life.xp).level;
    if (after > before) {
      const gift = ACCESSORIES.filter((x) => x.unlock === after).map((x) => x.name);
      bus.emit("notify", { title: `Bond level ${after}`, body: gift.length ? `Unlocked: ${gift.join(", ")}. Right-click your pet to wear it.` : "Your pet likes you more.", kind: "success" });
    }
  };

  const playFetch = () => {
    if (!petId) return;
    const l = usePetLife.getState().get(petId);
    if (l.asleep || l.energy < 20) { doAct("play"); return; }
    const target = { x: 10 + Math.random() * 75, y: 18 + Math.random() * 55 };
    setBall(target);
    setTimeout(() => setFetchPos(target), 500);
    setTimeout(() => { setBall(null); setFetchPos(null); doAct("play"); }, 2600);
  };

  // Right-click: everything you can do with it, and what it can wear.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !petId) return;
    return registerContextTarget(el, () => {
      const l = usePetLife.getState().get(petId);
      const wearable = unlocked(l.xp);
      return {
        id: "pet",
        entries: [
          { id: "feed", label: "Feed", icon: "plus", run: () => doAct("feed") },
          { id: "treat", label: "Give a treat", icon: "star", run: () => doAct("treat") },
          { id: "fetch", label: "Play fetch", icon: "play", run: playFetch },
          { id: "pat", label: "Pat", icon: "pet", run: () => doAct("pat") },
          { id: "trick", label: "Do a trick", icon: "sparkles", run: () => doAct("trick") },
          l.asleep ? { id: "wake", label: "Wake up", icon: "bell", run: () => doAct("wake") } : { id: "nap", label: "Take a nap", icon: "clock", run: () => doAct("nap") },
          { separator: true },
          { id: "wear", label: "Wear", icon: "wand", submenu: [
            { id: "none", label: "Nothing", checked: !l.accessory, run: () => usePetLife.getState().setAccessory(petId, null) },
            ...ACCESSORIES.map((a) => ({ id: a.id, label: wearable.includes(a) ? a.name : `${a.name} (bond level ${a.unlock})`, disabled: !wearable.includes(a), checked: l.accessory === a.id, run: () => usePetLife.getState().setAccessory(petId, a.id) })),
          ] },
          { id: "status", label: card ? "Hide status" : "Status...", icon: "info", run: () => setCard((c) => !c) },
        ],
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [petId, card]);

  // Wander. A pet that never moves is a sticker; one that moves constantly is
  // a distraction — so it steps every 9-17s and only while nothing is hovered.
  useEffect(() => {
    if (!s.petVisible || s.petMotion !== "wander" || !s.motion) return;
    const tick = () => {
      setDrift({ x: 6 + Math.random() * 84, y: 14 + Math.random() * 62 });
    };
    const id = setInterval(tick, 9000 + Math.random() * 8000);
    return () => clearInterval(id);
  }, [s.petVisible, s.petMotion, s.motion]);

  // Follow mode trails the cursor with a lag, which is the difference between
  // "a companion" and "a cursor decoration".
  useEffect(() => {
    if (!s.petVisible || s.petMotion !== "follow") return;
    let raf = 0;
    let target = { x: 50, y: 50 };
    const onMove = (e: PointerEvent) => {
      target = { x: (e.clientX / window.innerWidth) * 100, y: (e.clientY / window.innerHeight) * 100 };
    };
    const step = () => {
      setDrift((p) => ({ x: p.x + (target.x - p.x) * 0.035, y: p.y + (target.y - p.y) * 0.035 }));
      raf = requestAnimationFrame(step);
    };
    window.addEventListener("pointermove", onMove);
    raf = requestAnimationFrame(step);
    return () => { window.removeEventListener("pointermove", onMove); cancelAnimationFrame(raf); };
  }, [s.petVisible, s.petMotion]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const speak = async () => {
    if (!sp) return;
    setBounce((b) => b + 1);
    if (busy.current) return;
    // The canned line comes from the MODE, not the personality: the subject is
    // what you notice is missing when there is no model, and the voice is what
    // you notice is wrong.
    const canned = cannedLine(s.petMode, s.petPersonality, Math.random);

    pats.current += 1;
    if (pats.current === 10 && s.funMode && useEggs.getState().find("pet")) {
      const egg = EGGS.find((e) => e.id === "pet");
      setSay("Ten times. I am keeping count, you know.");
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setSay(null), 6000);
      if (egg) bus.emit("notify", { title: `Secret found: ${egg.name}`, body: egg.reveal, kind: "success" });
      return;
    }
    if (hideTimer.current) clearTimeout(hideTimer.current);

    if (!s.petTalks) {
      setSay(canned);
      hideTimer.current = setTimeout(() => setSay(null), 5200);
      return;
    }

    busy.current = true;
    setThinking(true);
    setSay(null);
    try {
      const name = s.petName || sp.name;
      const res = await ask({
        // The cap is the whole point: this fires on a click, and a pet that
        // costs real money to pat is a pet nobody pats.
        maxTokens: PET_MAX_TOKENS,
        temperature: 1,
        system: composePetPrompt({
          petName: name,
          speciesName: sp.name,
          modeId: s.petMode,
          personalityId: s.petPersonality,
          // Only the modes that asked for it actually receive this.
          context: {
            openApps: useWM.getState().windows.map((w) => w.title).slice(0, 6),
            hour: new Date().getHours(),
            pats: pats.current,
          },
        }),
        messages: [{ role: "user", content: "The user just clicked you. Say something." }],
      });
      setSay(tidyReply(res.text, canned, name));
    } catch {
      // Silent fallback by design: an error toast every time you pat the cat
      // would be worse than the cat having nothing new to say.
      setSay(canned);
    } finally {
      setThinking(false);
      busy.current = false;
      hideTimer.current = setTimeout(() => setSay(null), 7000);
    }
  };

  if (!s.petVisible || !sp) return null;
  const pos = fetchPos ?? (s.petMotion === "still" ? s.petPos : drift);
  const needMood: PetMood = reaction ?? (life ? lifeMood(life) : "idle");
  const lv = level(life?.xp ?? 0);
  const size = 52 * s.petScale;
  const detail = s.petDetail as Detail;

  return (
    <>
    {ball && <div className="pointer-events-none absolute z-[2] h-3 w-3 rounded-full" style={{ left: `${ball.x}%`, top: `${ball.y}%`, background: "#ffd43b", boxShadow: "0 0 0 2px #1b1b24", animation: s.motion ? "pet-ball 500ms ease-out" : undefined }} data-pet-ball aria-hidden />}
    <div
      ref={wrap}
      className="absolute z-[2] select-none"
      data-pet={sp.id}
      data-pet-mood={needMood}
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        transition: fetchPos ? "left 1.4s cubic-bezier(.3,.7,.3,1), top 1.4s cubic-bezier(.3,.7,.3,1)" : s.motion && s.petMotion === "wander" ? "left 6s cubic-bezier(.4,0,.2,1), top 6s cubic-bezier(.4,0,.2,1)" : undefined,
      }}
    >
      {card && life && (
        <div className="glass absolute bottom-full left-1/2 mb-8 w-[210px] -translate-x-1/2 p-2.5 text-[11px]" style={{ borderRadius: "calc(var(--radius) * 0.8)" }} data-pet-card role="dialog" aria-label={`${s.petName || sp.name} status`}>
          <div className="mb-1 flex items-center gap-1"><b className="text-[12px]">{s.petName || sp.name}</b><span className="ml-auto text-[var(--muted)]">bond {lv.level}{life.streak > 1 ? ` · ${life.streak} days` : ""}</span></div>
          <div className="mb-1.5 h-1 overflow-hidden rounded bg-white/10" title={`${lv.into}/${lv.span} XP to the next level`}><div className="h-full bg-[var(--accent)]" style={{ width: `${Math.round((lv.into / lv.span) * 100)}%` }} /></div>
          {([["Fullness", life.fullness], ["Energy", life.energy], ["Joy", life.joy]] as const).map(([k, v]) => (
            <div key={k} className="mb-0.5 flex items-center gap-1.5"><span className="w-14 text-[var(--muted)]">{k}</span><div className="h-1.5 flex-1 overflow-hidden rounded bg-white/10"><div className="h-full" style={{ width: `${Math.round(v)}%`, background: v < 30 ? "var(--danger)" : v < 60 ? "var(--warn)" : "var(--ok)" }} /></div><span className="w-7 text-right">{Math.round(v)}</span></div>
          ))}
          <div className="mt-1.5 flex flex-wrap gap-1">
            <button className="os-btn !px-1.5 !py-0 text-[10.5px]" onClick={() => doAct("feed")}>Feed</button>
            <button className="os-btn !px-1.5 !py-0 text-[10.5px]" onClick={playFetch}>Fetch</button>
            <button className="os-btn !px-1.5 !py-0 text-[10.5px]" onClick={() => doAct("trick")}>Trick</button>
            <button className="os-btn !px-1.5 !py-0 text-[10.5px]" onClick={() => doAct(life.asleep ? "wake" : "nap")}>{life.asleep ? "Wake" : "Nap"}</button>
            <button className="os-btn ml-auto !px-1.5 !py-0 text-[10.5px]" onClick={() => setCard(false)} aria-label="Close pet status">Close</button>
          </div>
          <div className="mt-1 text-[10px] text-[var(--muted)]">Fed {life.fed} · played {life.played} · patted {life.patted}</div>
        </div>
      )}
      {(say || thinking) && (
        <div
          className="glass absolute bottom-full left-1/2 mb-1.5 w-max max-w-[220px] -translate-x-1/2 px-2.5 py-1.5 text-[11.5px] leading-snug"
          style={{ borderRadius: "calc(var(--radius) * 0.8)", animation: s.motion ? "os-fade-up 180ms ease-out" : undefined }}
          role="status"
        >
          {thinking ? <span className="opacity-60">…</span> : say}
        </div>
      )}
      <button
        onClick={speak}
        onDoubleClick={() => s.set("petPos", { x: 6 + Math.random() * 84, y: 14 + Math.random() * 62 })}
        className="block cursor-pointer transition-transform hover:scale-110 active:scale-95"
        style={{ color: "var(--accent)" }}
        title={`${s.petName || sp.name} — click to talk, double-click to send it somewhere else`}
        aria-label={`${s.petName || sp.name}, desktop pet. Click to talk.`}
      >
        {/* Keyed on the pat count so each click restarts the bounce. */}
        <span key={`${bounce}-${trick?.k ?? 0}`} className={cn("inline-block", trick ? `pet-${trick.anim}` : bounce ? "pet-bounce" : "")} onAnimationEnd={() => setTrick(null)}>
          <PetSprite species={sp} detail={detail} size={size} mood={thinking ? "think" : say && !reaction ? "happy" : spriteMood(needMood)} outlined accessory={life?.accessory} />
        </span>
        {!say && !thinking && (needMood === "hungry" || needMood === "tired" || needMood === "sad" || needMood === "worried") && (
          <span className="absolute -right-1 -top-1 rounded-full bg-[var(--panel-solid)] px-1 text-[9px] leading-[14px] text-[var(--muted)] ring-1 ring-white/15" aria-hidden data-pet-need>{needMood === "hungry" ? "hungry" : needMood === "tired" ? "zz" : needMood === "worried" ? "?!" : "..."}</span>
        )}
      </button>
    </div>
    </>
  );
}
