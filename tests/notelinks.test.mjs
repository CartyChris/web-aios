/* Notes: wiki links, backlinks, word counts, full-text search. */
import test from "node:test";
import assert from "node:assert/strict";
import { extractLinks, backlinks, resolveLink, textStats, searchNotes, renderWikiLinks, noteFileName, noteTitle } from "../.test-build/notelinks.js";

const n = (name, content) => ({ path: `/notes/${name}`, name, content });
const NOTES = [
  n("Alpha.md", "See [[Beta]] and [[beta|the second]]. Also [[Gamma]]."),
  n("Beta.md", "Back to [[alpha]]. ```\n[[Alpha]] in code is not a link\n```"),
  n("Gamma.md", "No links. The word alpha appears here, alpha again, alpha thrice."),
];

test("links are distinct, case-insensitive, and aliases resolve to the target", () => {
  assert.deepEqual(extractLinks(NOTES[0].content), ["Beta", "Gamma"]);
});

test("links inside code are not links", () => {
  assert.deepEqual(extractLinks(NOTES[1].content), ["alpha"]);
  assert.deepEqual(extractLinks("`[[X]]` inline"), []);
});

test("backlinks", () => {
  assert.deepEqual(backlinks(NOTES[0], NOTES).map((x) => x.name), ["Beta.md"]);
  assert.deepEqual(backlinks(NOTES[1], NOTES).map((x) => x.name), ["Alpha.md"]);
  assert.deepEqual(backlinks(NOTES[2], NOTES).map((x) => x.name), ["Alpha.md"]);
  assert.equal(resolveLink("GAMMA", NOTES).name, "Gamma.md");
  assert.equal(resolveLink("nope", NOTES), null);
});

test("word count ignores markdown punctuation", () => {
  const s = textStats("# Title\n\n- one two\n- three ##");
  assert.equal(s.words, 4);
  assert.equal(s.lines, 4);
  assert.equal(s.readingMin, 1);
  assert.equal(textStats("").words, 0);
  assert.equal(textStats("").readingMin, 0);
});

test("search ranks title hits first, then match count, with a snippet", () => {
  const hits = searchNotes(NOTES, "alpha");
  assert.deepEqual(hits.map((h) => h.title), ["Alpha", "Gamma", "Beta"]);
  assert.equal(hits[1].count, 3);
  assert.match(hits[1].snippet, /word alpha appears/);
  assert.deepEqual(searchNotes(NOTES, "   "), []);
});

test("wiki links render for the preview, unresolved ones marked", () => {
  const out = renderWikiLinks("[[Beta]] and [[Nope|nah]]", (t) => t.toLowerCase() === "beta");
  assert.equal(out, "**Beta** and *nah (no such note)*");
});

test("file names", () => {
  assert.equal(noteFileName("a/b: c?"), "a b c.md");
  assert.equal(noteFileName("   "), "untitled.md");
  assert.equal(noteTitle("x.md"), "x");
});
