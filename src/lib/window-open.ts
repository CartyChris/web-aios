/* ────────────────────────────────────────────────────────────────────────────
   Deciding whether a request to open an app makes a new window.

   `singleton` used to mean "one window in the entire OS", and it was
   implemented as `windows.find(w => w.appId === appId)` — no workspace in the
   comparison. So opening Settings from workspace 3 when Settings was already
   open on workspace 1 did not open Settings: it teleported you to workspace 1.
   Four desktops, and three of them could never hold that app.

   The rule is now per WORKSPACE, which is what "singleton" was always for.
   Having five copies of Settings stacked on one desktop is the mess worth
   preventing; having one on each desktop is the entire point of having
   desktops. A pinned window shows on every workspace, so it still counts as
   the instance for whichever one you are on — otherwise you would get a second
   copy sitting directly on top of the first.

   PURE, so the rule can be tested against arrangements that are tedious to
   build by hand in a browser.
   ──────────────────────────────────────────────────────────────────────────── */

export interface OpenCandidate {
  id: string;
  appId: string;
  workspace: number;
  /** A pinned window is visible on every workspace. */
  pinned?: boolean;
}

export type OpenDecision =
  | { action: "focus"; windowId: string; reason: string }
  | { action: "create"; reason: string };

export interface ResolveOpenInput {
  appId: string;
  windows: OpenCandidate[];
  activeWorkspace: number;
  /** false or undefined always creates. */
  singleton?: boolean;
  /** Force a new window even for a singleton app — "open another one here". */
  forceNew?: boolean;
}

export function resolveOpen(input: ResolveOpenInput): OpenDecision {
  // An explicit "open another one" beats every other rule, including pinning.
  if (input.forceNew) return { action: "create", reason: "a new window was explicitly requested" };

  // A pinned instance is on screen here whatever workspace it belongs to, so
  // it is the one to focus. This is checked BEFORE the singleton rule on
  // purpose. It used to sit after it, which made the whole pinned branch
  // unreachable for the twenty-nine apps that are not singletons: pinning an
  // AI Studio window and opening AI Studio again stacked a second copy
  // directly on top of the visible one -- the exact outcome the rule exists to
  // prevent, and the one the header comment above says it prevents. Pinning is
  // a statement about where a window is VISIBLE, which has nothing to do with
  // how many copies an app allows; `forceNew` remains the way to ask for
  // another one anyway.
  const pinned = input.windows.find((w) => w.appId === input.appId && w.pinned);
  if (pinned) {
    return { action: "focus", windowId: pinned.id, reason: "an instance is pinned to every workspace" };
  }

  if (!input.singleton) return { action: "create", reason: "the app allows more than one window" };

  const here = input.windows.find((w) => w.appId === input.appId && w.workspace === input.activeWorkspace);
  if (here) {
    return { action: "focus", windowId: here.id, reason: `already open on this workspace` };
  }

  // It exists, but somewhere else. THIS is the case the old code got wrong: it
  // focused that window and dragged the user to another workspace.
  const elsewhere = input.windows.find((w) => w.appId === input.appId);
  return {
    action: "create",
    reason: elsewhere
      ? `open on workspace ${elsewhere.workspace}, but not on this one`
      : "not open anywhere",
  };
}

/** Every workspace an app currently has a window on, ascending. Used by the
 *  dock and the switcher to show that an app is on more than one desktop. */
export function workspacesWithApp(appId: string, windows: OpenCandidate[]): number[] {
  return [...new Set(windows.filter((w) => w.appId === appId).map((w) => w.workspace))].sort((a, b) => a - b);
}
