/* Version history for user-built apps.
 *
 * This is the module where a bug loses someone's work, so the tests are
 * weighted toward the three invariants that make the feature safe rather than
 * toward the happy path: reverting must not destroy, pruning must not drop the
 * original, and an oversized version must be refused rather than silently
 * wedging a shared storage quota.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  makeVersion, appendVersion, prune, revertTo, diffVersions, currentVersion,
  labelFor, byteSize, upgradePrompt, intentById, UPGRADE_INTENTS,
  MAX_VERSIONS, MAX_VERSION_BYTES, looksLikeDocument, unfence, mergeFiles,
} from "../.test-build/appversions.js";

const T0 = 1_776_254_400_000;
let n = 0;
const v = (html, patch = {}) => makeVersion({ id: `v${++n}`, at: T0 + n * 1000, source: "ai", html, ...patch });

/** A history of `count` versions, oldest first. */
function history(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const ver = makeVersion({
      id: `h${i}`, at: T0 + i * 1000,
      source: i === 0 ? "install" : "ai",
      html: `<html>v${i}</html>`,
      parentId: i === 0 ? null : `h${i - 1}`,
    });
    out.push(ver);
  }
  return out;
}

/* ── creating ────────────────────────────────────────────────────────────── */

test("a version records its size across html and every project file", () => {
  assert.equal(byteSize("abcd"), 4);
  assert.equal(byteSize("ab", [{ path: "a.js", content: "xyz" }]), 2 + 4 + 3);
  const ver = v("<html></html>", { files: [{ path: "a.js", content: "x" }] });
  assert.equal(ver.bytes, byteSize("<html></html>", [{ path: "a.js", content: "x" }]));
});

test("a label is never empty — a history of bare timestamps cannot be navigated", () => {
  assert.equal(labelFor({ source: "install" }), "First version");
  assert.equal(labelFor({ source: "manual" }), "Edited by hand");
  assert.equal(labelFor({ source: "ai" }), "Changed by AI");
  assert.equal(labelFor({ source: "ai", prompt: "  add   a dark mode  " }), "add a dark mode");
  assert.equal(labelFor({ source: "ai", prompt: "x", label: "explicit" }), "explicit");
});

test("a very long prompt is truncated into a label rather than overflowing a row", () => {
  const label = labelFor({ source: "ai", prompt: "a".repeat(400) });
  assert.ok(label.length <= 70, `label was ${label.length} chars`);
  assert.match(label, /…$/);
});

test("optional fields are omitted rather than stored as undefined", () => {
  const ver = v("<p>x</p>");
  assert.ok(!("files" in ver));
  assert.ok(!("prompt" in ver));
  assert.equal(ver.parentId, null);
});

/* ── appending ───────────────────────────────────────────────────────────── */

test("appending returns a new history and does not mutate the old one", () => {
  const h = history(2);
  const before = h.length;
  const r = appendVersion(h, v("<html>new</html>"));
  assert.equal(r.ok, true);
  assert.equal(h.length, before, "the input history was mutated");
  assert.equal(r.history.length, before + 1);
});

test("an identical document is refused — two same entries make a history you cannot read", () => {
  const h = history(2);
  const same = makeVersion({ id: "dup", at: T0, source: "ai", html: h[h.length - 1].html });
  const r = appendVersion(h, same);
  assert.equal(r.ok, false);
  assert.match(r.reason, /identical/);
});

test("identical html but different project files IS a new version", () => {
  // The negative control for the duplicate check: it must not swallow a real
  // change that happens to leave the preview document alone.
  const base = makeVersion({ id: "a", at: T0, source: "install", html: "<html></html>", files: [{ path: "a.js", content: "1" }] });
  const changed = makeVersion({ id: "b", at: T0 + 1, source: "ai", html: "<html></html>", files: [{ path: "a.js", content: "2" }] });
  assert.equal(appendVersion([base], changed).ok, true);
});

test("an oversized version is REFUSED rather than wedging the shared quota", () => {
  const huge = makeVersion({ id: "big", at: T0, source: "ai", html: "x".repeat(MAX_VERSION_BYTES + 1) });
  const r = appendVersion(history(1), huge);
  assert.equal(r.ok, false);
  assert.match(r.reason, /limit/);
  // The message must say what to blame, not just refuse.
  assert.match(r.reason, /KB/);
});

test("a version exactly at the limit is allowed — the boundary is not off by one", () => {
  const atLimit = makeVersion({ id: "edge", at: T0, source: "ai", html: "x".repeat(MAX_VERSION_BYTES) });
  assert.equal(appendVersion(history(1), atLimit).ok, true);
});

/* ── pruning: the first version is pinned ────────────────────────────────── */

test("pruning keeps the FIRST version, not just the most recent ones", () => {
  // A plain slice(-max) drops the original on change 21 — silently, and
  // exactly when a long session means you most want it back.
  const h = history(MAX_VERSIONS + 5);
  const { kept } = prune(h, MAX_VERSIONS);
  assert.equal(kept.length, MAX_VERSIONS);
  assert.equal(kept[0].id, "h0", "the original version was pruned away");
  assert.equal(kept[kept.length - 1].id, `h${MAX_VERSIONS + 4}`, "the newest version was pruned away");
});

test("pruning removes from the MIDDLE and reports what it dropped", () => {
  const h = history(MAX_VERSIONS + 3);
  const { kept, pruned } = prune(h, MAX_VERSIONS);
  assert.equal(pruned.length, 3);
  for (const id of pruned) assert.ok(!kept.some((k) => k.id === id));
  assert.ok(!pruned.includes("h0"), "the original was reported as pruned");
});

test("a history at or under the cap is untouched", () => {
  const h = history(MAX_VERSIONS);
  const { kept, pruned } = prune(h, MAX_VERSIONS);
  assert.deepEqual(pruned, []);
  assert.equal(kept.length, MAX_VERSIONS);
  assert.deepEqual(kept.map((k) => k.id), h.map((k) => k.id));
});

test("appending past the cap still leaves the original reachable", () => {
  let h = history(1);
  for (let i = 0; i < MAX_VERSIONS + 10; i++) {
    const r = appendVersion(h, makeVersion({ id: `x${i}`, at: T0 + i, source: "ai", html: `<html>${i}</html>` }));
    assert.equal(r.ok, true, `append ${i} failed`);
    h = r.history;
  }
  assert.equal(h.length, MAX_VERSIONS);
  assert.equal(h[0].id, "h0");
  assert.equal(h[0].source, "install");
});

test("pruning to zero keeps nothing rather than throwing", () => {
  const { kept, pruned } = prune(history(3), 0);
  assert.deepEqual(kept, []);
  assert.equal(pruned.length, 3);
});

/* ── reverting: forward, never destructive ───────────────────────────────── */

test("reverting APPENDS a copy — the versions you passed are still there", () => {
  const h = history(5);
  const r = revertTo(h, "h1", "rev1", T0 + 99);
  assert.equal(r.ok, true);
  assert.equal(r.version.source, "revert");
  assert.equal(r.version.html, h[1].html);
  assert.equal(r.version.revertedFrom, "h1");
  assert.equal(r.version.parentId, "h4", "the revert must descend from what was current");

  const after = appendVersion(h, r.version);
  assert.equal(after.ok, true);
  assert.equal(after.history.length, 6, "reverting shortened the history");
  for (const id of ["h0", "h1", "h2", "h3", "h4"]) {
    assert.ok(after.history.some((x) => x.id === id), `${id} was destroyed by a revert`);
  }
});

test("un-reverting is just reverting again", () => {
  // The property that makes "try it and see" safe rather than a one-way door.
  let h = history(3);
  const back = revertTo(h, "h0", "r1", T0 + 10);
  h = appendVersion(h, back.version).history;
  assert.equal(currentVersion(h).html, "<html>v0</html>");

  const forward = revertTo(h, "h2", "r2", T0 + 20);
  assert.equal(forward.ok, true);
  h = appendVersion(h, forward.version).history;
  assert.equal(currentVersion(h).html, "<html>v2</html>");
  assert.equal(h.length, 5);
});

test("reverting to the current version is refused, with a reason", () => {
  const h = history(3);
  const r = revertTo(h, "h2", "r", T0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already the current/);
});

test("reverting to a version whose content already matches the current one is refused", () => {
  const a = makeVersion({ id: "a", at: T0, source: "install", html: "<p>same</p>" });
  const b = makeVersion({ id: "b", at: T0 + 1, source: "ai", html: "<p>other</p>" });
  const c = makeVersion({ id: "c", at: T0 + 2, source: "ai", html: "<p>same</p>" });
  const r = revertTo([a, b, c], "a", "r", T0 + 3);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already identical/);
});

test("reverting to an unknown id names the id rather than failing silently", () => {
  const r = revertTo(history(2), "nope", "r", T0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /nope/);
});

test("a revert carries a label naming what it went back to", () => {
  const h = [makeVersion({ id: "a", at: T0, source: "install", html: "<p>1</p>", label: "Before the redesign" }),
             makeVersion({ id: "b", at: T0 + 1, source: "ai", html: "<p>2</p>" })];
  const r = revertTo(h, "a", "r", T0 + 2);
  assert.match(r.version.label, /Before the redesign/);
});

test("reverting preserves project files, not just the preview document", () => {
  const a = makeVersion({ id: "a", at: T0, source: "install", html: "<p>1</p>", files: [{ path: "app.js", content: "one" }] });
  const b = makeVersion({ id: "b", at: T0 + 1, source: "ai", html: "<p>2</p>", files: [{ path: "app.js", content: "two" }] });
  const r = revertTo([a, b], "a", "r", T0 + 2);
  assert.deepEqual(r.version.files, [{ path: "app.js", content: "one" }]);
});

/* ── diffing ─────────────────────────────────────────────────────────────── */

test("a diff counts added and removed lines", () => {
  const from = v("<a>\n<b>\n<c>");
  const to = v("<a>\n<c>\n<d>\n<e>");
  const d = diffVersions(from, to);
  assert.equal(d.added, 2, "d and e are new");
  assert.equal(d.removed, 1, "b is gone");
  assert.equal(d.identical, false);
});

test("a diff of a version against itself is identical and says so", () => {
  const a = v("<a>\n<b>");
  const d = diffVersions(a, a);
  assert.equal(d.identical, true);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.summary, "No change");
});

test("blank lines and indentation changes are not counted as a rewrite", () => {
  const from = v("<a>\n<b>");
  const to = v("\n\n  <a>  \n\n\t<b>\n");
  assert.equal(diffVersions(from, to).identical, true);
});

test("repeated identical lines are counted as a multiset, not collapsed", () => {
  // Three <li> becoming five is a change of two, not of zero.
  const from = v("<li>\n<li>\n<li>");
  const to = v("<li>\n<li>\n<li>\n<li>\n<li>");
  const d = diffVersions(from, to);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});

test("a byte delta is signed and shown in the summary", () => {
  const grew = diffVersions(v("<a>"), v("<a>\n<bbbb>"));
  assert.ok(grew.bytesDelta > 0);
  assert.match(grew.summary, /\+\d/);
  const shrank = diffVersions(v("<a>\n<bbbb>"), v("<a>"));
  assert.ok(shrank.bytesDelta < 0);
  assert.match(shrank.summary, /-\d/);
});

test("a project diff reports added, removed, changed and unchanged files", () => {
  const from = v("<html>", { files: [{ path: "a.js", content: "1" }, { path: "b.js", content: "keep" }, { path: "gone.js", content: "x" }] });
  const to = v("<html>", { files: [{ path: "a.js", content: "2" }, { path: "b.js", content: "keep" }, { path: "new.js", content: "y" }] });
  const d = diffVersions(from, to);
  const byPath = Object.fromEntries(d.files.map((f) => [f.path, f.status]));
  assert.equal(byPath["a.js"], "changed");
  assert.equal(byPath["b.js"], "same");
  assert.equal(byPath["gone.js"], "removed");
  assert.equal(byPath["new.js"], "added");
  assert.equal(d.identical, false, "a file-only change must not read as identical");
});

test("a single-document app produces no file rows", () => {
  assert.deepEqual(diffVersions(v("<a>"), v("<b>")).files, []);
});

/* ── the upgrade prompt ──────────────────────────────────────────────────── */

test("every intent has a distinct id and a real instruction", () => {
  const ids = UPGRADE_INTENTS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(UPGRADE_INTENTS.length >= 6);
  for (const i of UPGRADE_INTENTS) {
    assert.ok(i.instruction.length > 40, `${i.id}: instruction too vague to constrain a model`);
    assert.ok(i.label.length > 0);
  }
});

test("an unknown intent falls back rather than producing an empty instruction", () => {
  assert.equal(intentById("nope").id, UPGRADE_INTENTS[0].id);
});

test("the prompt states the return format and the preservation rule before the request", () => {
  const p = upgradePrompt("polish", "", "<html>current</html>");
  assert.match(p, /ONE complete HTML document/);
  assert.match(p, /Preserve every feature/);
  // The escape hatch matters: a model that cannot comply should return the
  // document unchanged rather than approximate it.
  assert.match(p, /return the document UNCHANGED/);
  assert.ok(p.includes("<html>current</html>"));
});

test("a detail is included, and an empty detail adds no dangling line", () => {
  assert.match(upgradePrompt("feature", "add dark mode", "<x>"), /Specifically: add dark mode/);
  assert.doesNotMatch(upgradePrompt("feature", "   ", "<x>"), /Specifically:/);
});

test("each intent's instruction reaches the prompt verbatim", () => {
  for (const i of UPGRADE_INTENTS) {
    assert.ok(upgradePrompt(i.id, "", "<x>").includes(i.instruction), `${i.id} was not used`);
  }
});

/* ── guarding against a truncated rewrite ────────────────────────────────── */

test("a truncated document is caught by its missing closing tag", () => {
  // The expensive failure: a model that runs out of tokens returns a file that
  // looks fine in a list and is broken when you open it.
  const cut = "<!doctype html><html><head><title>x</title></head><body><div>half a th";
  const r = looksLikeDocument(cut);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cut off/);
});

test("a complete document passes", () => {
  assert.equal(looksLikeDocument("<!doctype html><html><body><h1>Hi</h1></body></html>").ok, true);
  // A fragment is still usable in an iframe srcDoc, so it must not be refused.
  assert.equal(looksLikeDocument("<div id=app><h1>Hello there everyone</h1></div>").ok, true);
});

test("prose, an apology or an empty reply is refused", () => {
  assert.equal(looksLikeDocument("").ok, false);
  assert.equal(looksLikeDocument("   ").ok, false);
  assert.equal(looksLikeDocument("I'm sorry, I can't help with that request right now.").ok, false);
  assert.match(looksLikeDocument("Sure! Here is an improved version of your application for you.").reason, /does not look like HTML/);
});

test("a body left unclosed is caught even when html is closed", () => {
  assert.equal(looksLikeDocument("<html><body><div>content here and more</div></html>").ok, false);
});

test("unfence strips a markdown fence and leaves a bare document alone", () => {
  assert.equal(unfence("```html\n<p>hi</p>\n```"), "<p>hi</p>");
  assert.equal(unfence("```\n<p>hi</p>\n```"), "<p>hi</p>");
  assert.equal(unfence("<p>hi</p>"), "<p>hi</p>");
  assert.equal(unfence("  <p>hi</p>  "), "<p>hi</p>");
});

test("merging files replaces what the model returned and keeps the rest", () => {
  // A model that returns three of nine files has changed three, not deleted six.
  const existing = [
    { path: "index.html", content: "old" },
    { path: "app.js", content: "old" },
    { path: "style.css", content: "keep me" },
  ];
  const returned = [{ path: "app.js", content: "new" }, { path: "extra.js", content: "added" }];
  const merged = mergeFiles(existing, returned);
  const byPath = Object.fromEntries(merged.map((f) => [f.path, f.content]));
  assert.equal(byPath["app.js"], "new");
  assert.equal(byPath["style.css"], "keep me", "an unmentioned file was dropped");
  assert.equal(byPath["index.html"], "old");
  assert.equal(byPath["extra.js"], "added");
  assert.equal(merged.length, 4);
});

test("merging an empty reply changes nothing", () => {
  const existing = [{ path: "a.js", content: "1" }];
  assert.deepEqual(mergeFiles(existing, []), existing);
});
