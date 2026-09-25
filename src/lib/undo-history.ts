/* ────────────────────────────────────────────────────────────────────────────
   Undo / redo over immutable snapshots.

   PURE. The clock is injected. Used by Forge 3D (whole scenes) and Asset
   Studio (one asset), both of which already treat their document as an
   immutable value, so a snapshot is a pointer, not a copy.

   The one decision with teeth is COALESCING. A slider drag or a number field
   being typed into fires dozens of changes a second; recording each as its
   own step makes undo useless (forty presses to get back one drag). Changes
   that share a `key` and arrive within `coalesceMs` of the last one fold into
   a single step. A different key, or a pause, starts a new step.
   ──────────────────────────────────────────────────────────────────────────── */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Key and time of the last recorded change, for coalescing. */
  lastKey?: string;
  lastAt?: number;
}

export interface RecordOptions {
  now: number;
  key?: string;
  coalesceMs?: number;
  cap?: number;
}

export const DEFAULT_CAP = 80;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function record<T>(h: History<T>, next: T, o: RecordOptions): History<T> {
  if (Object.is(next, h.present)) return h;
  const cap = Math.max(1, o.cap ?? DEFAULT_CAP);
  const span = o.coalesceMs ?? 600;
  const fold = o.key !== undefined && o.key === h.lastKey && h.lastAt !== undefined && o.now - h.lastAt <= span && h.past.length > 0;
  if (fold) {
    // Same gesture: move the present, keep the step it started from.
    return { past: h.past, present: next, future: [], lastKey: o.key, lastAt: o.now };
  }
  const past = [...h.past, h.present];
  return { past: past.length > cap ? past.slice(past.length - cap) : past, present: next, future: [], lastKey: o.key, lastAt: o.now };
}

/** Replace the present without creating a step (loads, imports that should
 *  not be undoable into a blank document). */
export function reset<T>(present: T): History<T> {
  return initHistory(present);
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}

export const canUndo = <T>(h: History<T>) => h.past.length > 0;
export const canRedo = <T>(h: History<T>) => h.future.length > 0;
