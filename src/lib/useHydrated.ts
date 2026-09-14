"use client";

import { useSyncExternalStore } from "react";

// Nothing changes after hydration, so subscribe is a no-op that never fires.
// Hoisted so the identities stay stable across renders.
const noop = () => () => {};
const onClient = () => true;
const onServer = () => false;

/** True once the client has hydrated.
 *
 *  Persisted zustand stores read localStorage after mount, so painting the
 *  shell before hydration would flash default settings. useSyncExternalStore is
 *  the right primitive here: it returns the server snapshot during SSR and the
 *  client snapshot afterwards, with no setState inside an effect. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noop, onClient, onServer);
}
