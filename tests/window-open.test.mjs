/* Opening an app when it may already be open somewhere.
 *
 * The bug this replaces: `singleton` compared only appId, so opening Settings
 * from workspace 3 while it sat on workspace 1 teleported you to workspace 1
 * instead of opening it where you were. Four desktops, three of which could
 * never hold that app.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveOpen, workspacesWithApp } from "../.test-build/window-open.js";

const w = (id, appId, workspace, pinned = false) => ({ id, appId, workspace, pinned });

const open = (patch) => resolveOpen({ appId: "settings", windows: [], activeWorkspace: 1, singleton: true, ...patch });

/* ── the fix ─────────────────────────────────────────────────────────────── */

test("a singleton app open on ANOTHER workspace opens a new window here", () => {
  // The whole point. The old rule focused the far window and moved the user.
  const d = open({ windows: [w("a", "settings", 1)], activeWorkspace: 3 });
  assert.equal(d.action, "create");
  assert.match(d.reason, /workspace 1, but not on this one/);
});

test("a singleton app already on THIS workspace is focused, not duplicated", () => {
  const d = open({ windows: [w("a", "settings", 2)], activeWorkspace: 2 });
  assert.equal(d.action, "focus");
  assert.equal(d.windowId, "a");
  assert.match(d.reason, /already open on this workspace/);
});

test("the same app can end up on every workspace, one each", () => {
  let windows = [];
  for (const ws of [1, 2, 3, 4]) {
    const d = resolveOpen({ appId: "settings", windows, activeWorkspace: ws, singleton: true });
    assert.equal(d.action, "create", `workspace ${ws} refused to open its own copy`);
    windows = [...windows, w(`win${ws}`, "settings", ws)];
  }
  assert.deepEqual(workspacesWithApp("settings", windows), [1, 2, 3, 4]);

  // And a second request on any of them focuses rather than stacking.
  for (const ws of [1, 2, 3, 4]) {
    assert.equal(resolveOpen({ appId: "settings", windows, activeWorkspace: ws, singleton: true }).action, "focus");
  }
});

test("a PINNED instance is focused from any workspace — it is already on screen", () => {
  // Opening a second copy directly on top of a visible one is the worst of
  // both behaviours.
  const d = open({ windows: [w("p", "settings", 1, true)], activeWorkspace: 4 });
  assert.equal(d.action, "focus");
  assert.equal(d.windowId, "p");
  assert.match(d.reason, /pinned/);
});

test("a pinned instance wins over an unpinned one on the current workspace", () => {
  const d = open({ windows: [w("here", "settings", 2), w("pin", "settings", 1, true)], activeWorkspace: 2 });
  assert.equal(d.windowId, "pin");
});

/* ── everything that must NOT change ─────────────────────────────────────── */

test("a non-singleton app always creates, however many are open", () => {
  const windows = [w("a", "chat", 1), w("b", "chat", 1), w("c", "chat", 2)];
  const d = resolveOpen({ appId: "chat", windows, activeWorkspace: 1, singleton: false });
  assert.equal(d.action, "create");
  assert.equal(resolveOpen({ appId: "chat", windows, activeWorkspace: 1 }).action, "create", "undefined singleton must behave as false");
});

test("a singleton app that is not open anywhere creates", () => {
  const d = open({ windows: [w("a", "notes", 1)], activeWorkspace: 1 });
  assert.equal(d.action, "create");
  assert.match(d.reason, /not open anywhere/);
});

test("forceNew creates a second window even for a singleton on this workspace", () => {
  const d = open({ windows: [w("a", "settings", 1)], activeWorkspace: 1, forceNew: true });
  assert.equal(d.action, "create");
  assert.match(d.reason, /explicitly requested/);
});

test("another app's windows never satisfy this app's request", () => {
  const d = open({ windows: [w("a", "notes", 1), w("b", "chat", 1, true)], activeWorkspace: 1 });
  assert.equal(d.action, "create");
});

test("every decision carries a reason — a window that did not open must say why", () => {
  const cases = [
    open({ windows: [] }),
    open({ windows: [w("a", "settings", 1)], activeWorkspace: 1 }),
    open({ windows: [w("a", "settings", 1)], activeWorkspace: 2 }),
    open({ windows: [w("a", "settings", 1, true)], activeWorkspace: 2 }),
    resolveOpen({ appId: "chat", windows: [], activeWorkspace: 1, singleton: false }),
  ];
  for (const c of cases) assert.ok(c.reason && c.reason.length > 8, `bare decision: ${JSON.stringify(c)}`);
  assert.equal(new Set(cases.map((c) => c.reason)).size, cases.length, "two different decisions share a reason");
});

/* ── workspacesWithApp ───────────────────────────────────────────────────── */

test("workspacesWithApp lists each workspace once, ascending", () => {
  const windows = [w("a", "chat", 3), w("b", "chat", 1), w("c", "chat", 3), w("d", "notes", 2)];
  assert.deepEqual(workspacesWithApp("chat", windows), [1, 3]);
  assert.deepEqual(workspacesWithApp("notes", windows), [2]);
  assert.deepEqual(workspacesWithApp("nothing", windows), []);
});
