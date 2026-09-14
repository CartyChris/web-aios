"use client";

/** Minimal typed pub/sub so apps can talk without importing each other.
 *  Chat publishes `artifact:created`; the IDE subscribes and offers to open it. */
type Handler = (payload: unknown) => void;

const listeners = new Map<string, Set<Handler>>();

export const bus = {
  on(event: string, fn: Handler): () => void {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
    return () => listeners.get(event)?.delete(fn);
  },
  emit(event: string, payload?: unknown) {
    listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error(`[bus] handler for "${event}" threw:`, e);
      }
    });
    listeners.get("*")?.forEach((fn) => fn({ event, payload }));
  },
  clear(event?: string) {
    if (event) listeners.delete(event);
    else listeners.clear();
  },
};
