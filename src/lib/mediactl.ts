/* Media player decisions that do not need a DOM: the A-B loop, where to resume
   a file, and what a key does. Pure, so the edge cases are tested rather than
   discovered by someone scrubbing a video. */

export interface AbLoop { a: number | null; b: number | null }

/** Where playback should be after a tick at time `t`. Only a complete loop
 *  (both ends, b after a) ever jumps; a half-set loop plays normally. */
export function abNext(t: number, loop: AbLoop): number | null {
  if (loop.a === null || loop.b === null || loop.b <= loop.a) return null;
  return t >= loop.b || t < loop.a - 0.25 ? loop.a : null;
}

/** Setting A or B in turn: A, then B, then clear. Setting B before A, or at a
 *  time before A, makes the new point A instead of a loop that never plays. */
export function abCycle(t: number, loop: AbLoop): AbLoop {
  if (loop.a === null) return { a: t, b: null };
  if (loop.b === null) return t > loop.a + 0.1 ? { a: loop.a, b: t } : { a: t, b: null };
  return { a: null, b: null };
}

/** Resume position for a file, or 0. Near the start or the end is not worth
 *  resuming: the first seconds are what you would replay anyway, and resuming
 *  in the last seconds strands you at the credits. */
export function resumeAt(saved: number | undefined, duration: number): number {
  if (!saved || !Number.isFinite(saved) || !Number.isFinite(duration) || duration <= 0) return 0;
  if (saved < 5 || saved > duration - 10) return 0;
  return saved;
}

export type MediaAction =
  | { kind: "toggle" } | { kind: "seek"; by: number } | { kind: "mute" }
  | { kind: "rate"; by: number } | { kind: "next" } | { kind: "prev" } | { kind: "ab" };

export function keyAction(key: string, shift: boolean): MediaAction | null {
  switch (key) {
    case " ": case "k": return { kind: "toggle" };
    case "ArrowRight": return { kind: "seek", by: shift ? 30 : 5 };
    case "ArrowLeft": return { kind: "seek", by: shift ? -30 : -5 };
    case "m": return { kind: "mute" };
    case ">": return { kind: "rate", by: 0.25 };
    case "<": return { kind: "rate", by: -0.25 };
    case "n": return { kind: "next" };
    case "p": return { kind: "prev" };
    case "l": return { kind: "ab" };
    default: return null;
  }
}

export const clampRate = (r: number): number => Math.round(Math.max(0.25, Math.min(3, r)) * 100) / 100;
