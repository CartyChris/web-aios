/**
 * Browser tabs, bookmarks, history, per-host mode memory and find-in-page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialTabs, newTab, openTab, closeTab, switchTab, moveTab, pushEntry, stepTab, applyShimReport, activeTab,
  normalizeAddress, validTemplate, engineById, rememberHost, startView, hostOf, MAX_HOST_MEMORY,
  toggleBookmark, recordVisit, titleVisit, searchPlaces, findMatches, splitByMatches, pageFileName,
} from "../.test-build/browser-tabs.js";

const DDG = engineById("duckduckgo").template;

test("open inserts after the active tab and focuses it", () => {
  let s = initialTabs("a");
  s = openTab(s, newTab("b"));
  s = switchTab(s, "a");
  s = openTab(s, newTab("c"));
  assert.deepEqual(s.tabs.map((t) => t.id), ["a", "c", "b"]);
  assert.equal(s.activeId, "c");
  const bg = openTab(s, newTab("d"), false);
  assert.equal(bg.activeId, "c");
});

test("closing the active tab focuses the right neighbour, else the left; the last tab is replaced", () => {
  let s = { tabs: [newTab("a"), newTab("b"), newTab("c")], activeId: "b" };
  assert.equal(closeTab(s, "b", "z").activeId, "c");
  s = { tabs: [newTab("a"), newTab("b"), newTab("c")], activeId: "c" };
  assert.equal(closeTab(s, "c", "z").activeId, "b");
  // Closing a background tab keeps focus where it was.
  assert.equal(closeTab(s, "a", "z").activeId, "c");
  const last = closeTab(initialTabs("only"), "only", "fresh");
  assert.deepEqual(last.tabs.map((t) => t.id), ["fresh"]);
  assert.equal(last.activeId, "fresh");
});

test("reorder moves a tab and clamps the destination", () => {
  const s = { tabs: [newTab("a"), newTab("b"), newTab("c")], activeId: "a" };
  assert.deepEqual(moveTab(s, "a", 2).tabs.map((t) => t.id), ["b", "c", "a"]);
  assert.deepEqual(moveTab(s, "c", -5).tabs.map((t) => t.id), ["c", "a", "b"]);
  assert.equal(moveTab(s, "nope", 1), s);
});

test("each tab keeps its own history; push drops forward entries", () => {
  let t = newTab("a");
  t = pushEntry(t, { url: "https://one.test/", view: "frame", confirmed: true });
  t = pushEntry(t, { url: "https://two.test/", view: "web", confirmed: false });
  t = stepTab(t, -1);
  assert.equal(t.draft, "https://one.test/");
  t = pushEntry(t, { url: "https://three.test/", view: "reader", confirmed: true });
  assert.deepEqual(t.entries.map((e) => e.url), ["https://one.test/", "https://three.test/"]);
  assert.equal(stepTab(t, 1), t, "stepping past the end is a no-op");
  const other = newTab("b");
  const s = { tabs: [t, other], activeId: "b" };
  assert.equal(activeTab(s).entries.length, 0);
});

test("shim report confirms the entry after a redirect, then records in-page navigation", () => {
  let t = pushEntry(newTab("a"), { url: "http://x.test/", view: "web", confirmed: false });
  t = applyShimReport(t, "https://www.x.test/home", "Home");
  assert.equal(t.entries.length, 1);
  assert.equal(t.entries[0].url, "https://www.x.test/home");
  assert.equal(t.entries[0].confirmed, true);
  t = applyShimReport(t, "https://www.x.test/about", "About");
  assert.equal(t.entries.length, 2);
  assert.equal(t.index, 1);
});

test("addresses: hosts become https, only http(s) is a URL, everything else searches the chosen engine", () => {
  assert.equal(normalizeAddress("example.com/a?b=1", DDG), "https://example.com/a?b=1");
  assert.equal(normalizeAddress("https://x.test", DDG), "https://x.test");
  assert.equal(normalizeAddress("javascript:alert(1)", DDG), "https://duckduckgo.com/?q=javascript%3Aalert(1)");
  assert.equal(normalizeAddress("two words.com", DDG).startsWith("https://duckduckgo.com/?q="), true);
  const brave = engineById("brave").template;
  assert.equal(normalizeAddress("cats", brave), "https://search.brave.com/search?q=cats");
  // A broken custom template falls back to the default engine rather than producing a bad URL.
  assert.equal(normalizeAddress("cats", "ftp://x/%s"), "https://duckduckgo.com/?q=cats");
  assert.equal(validTemplate("https://s.test/?q=%s"), true);
  assert.equal(validTemplate("https://s.test/?q=%s&r=%s"), false);
  assert.equal(validTemplate("https://s.test/"), false);
  assert.equal(engineById("nope").id, "duckduckgo");
});

test("a host that refused framing starts in web next time; explicit modes win", () => {
  let mem = {};
  assert.equal(startView(mem, "https://github.com/x", "auto"), null, "unknown host probes");
  mem = rememberHost(mem, "https://www.github.com/login", "web");
  assert.equal(hostOf("https://www.github.com/login"), "github.com");
  assert.equal(startView(mem, "https://github.com/other", "auto"), "web");
  assert.equal(startView(mem, "https://github.com/other", "reader"), "reader");
  assert.equal(startView(mem, "https://example.com/", "auto"), null);
});

test("host memory is bounded and keeps the newest", () => {
  let mem = {};
  for (let i = 0; i < MAX_HOST_MEMORY + 5; i++) mem = rememberHost(mem, `https://h${i}.test/`, "web");
  assert.equal(Object.keys(mem).length, MAX_HOST_MEMORY);
  assert.equal(mem["h0.test"], undefined);
  assert.equal(mem[`h${MAX_HOST_MEMORY + 4}.test`], "web");
});

test("bookmarks toggle; history dedupes, counts, and moves to the front", () => {
  let b = toggleBookmark([], "https://a.test/", "", 1);
  assert.equal(b[0].title, "a.test");
  b = toggleBookmark(b, "https://a.test/", "A", 2);
  assert.equal(b.length, 0);
  let h = recordVisit([], "https://a.test/", "A", 1);
  h = recordVisit(h, "https://b.test/", "B", 2);
  h = recordVisit(h, "https://a.test/", "", 3);
  assert.deepEqual(h.map((v) => v.url), ["https://a.test/", "https://b.test/"]);
  assert.equal(h[0].count, 2);
  assert.equal(h[0].title, "A", "an empty title does not erase a known one");
  h = titleVisit(h, "https://b.test/", "Bee");
  assert.equal(h[1].title, "Bee");
});

test("search needs every term, in title or URL", () => {
  const list = [
    { url: "https://docs.rust.test/book", title: "The Book" },
    { url: "https://news.test/", title: "Rust news" },
  ];
  assert.deepEqual(searchPlaces(list, "rust book").map((x) => x.title), ["The Book"]);
  assert.equal(searchPlaces(list, "RUST").length, 2);
  assert.equal(searchPlaces(list, "").length, 2);
  assert.equal(searchPlaces(list, "python").length, 0);
});

test("find in page: case-insensitive, non-overlapping, and splits into runs", () => {
  assert.deepEqual(findMatches("aaaa", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  const m = findMatches("Cat cat CAT", "cat");
  assert.equal(m.length, 3);
  const runs = splitByMatches("Cat cat CAT", m);
  assert.equal(runs.map((r) => r.text).join(""), "Cat cat CAT");
  assert.deepEqual(runs.filter((r) => r.hit !== null).map((r) => r.hit), [0, 1, 2]);
  assert.deepEqual(findMatches("abc", ""), []);
  assert.equal(pageFileName("Hello: World!", "https://x.test"), "Hello-World.md");
  assert.equal(pageFileName("", "https://www.x.test/"), "xtest.md");
});
