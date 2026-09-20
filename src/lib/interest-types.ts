/* ────────────────────────────────────────────────────────────────────────────
   The contract between what the OS observes and what it suggests.

   Its own file so the producer (lib/interests.ts, kernel/activity.ts) and the
   consumer (lib/suggest.ts, apps/ForYou.tsx) can be written and tested
   independently. Neither side edits this without the other.
   ──────────────────────────────────────────────────────────────────────────── */

/** Where an observation came from. Each carries a different weight: a file you
 *  wrote says more about you than a search you ran once. */
export type SignalSource = "chat" | "file" | "app" | "widget" | "search" | "harness" | "service";

export interface InterestSignal {
  source: SignalSource;
  /** Free text: a title, a query, a prompt, a path. Never a whole document. */
  text: string;
  /** Epoch ms. Older signals decay. */
  at: number;
  /** Optional multiplier on the source's default weight. */
  weight?: number;
}

export interface Interest {
  /** Lower-case, one or two words. */
  term: string;
  /** Relative, higher is stronger. Not a probability. */
  score: number;
  /** Which sources contributed, deduplicated. Shown to the user, so they can
   *  see why the OS thinks they care about something. */
  sources: SignalSource[];
}
