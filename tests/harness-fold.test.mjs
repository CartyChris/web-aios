/* Context folding.
 *
 * The behaviour that matters is the counter: forty identical failures must
 * become one line saying forty, not forty lines. Everything else follows from
 * that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  bulletsFor, curate, prune, foldSteps, renderLedger, recurringFailures,
  FOLD_DEFAULTS, LEDGER_HEADER,
} from "../.test-build/harness/fold.js";

const step = (index, over = {}) => ({
  index,
  thought: `thinking ${index}`,
  action: over.action ?? null,
  observation: over.observation ?? "",
  outcome: over.outcome ?? "thought",
  parseError: over.parseError,
  llm: { spanId: `s${index}`, provider: "p", model: "m", system: "", prompt: "", text: "", tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0 },
});
const act = (verb, args = {}) => ({ verb, raw: verb, args });

/* ── extraction ──────────────────────────────────────────────────────────── */

test("a tool error becomes a failure bullet", () => {
  const b = bulletsFor(step(1, { outcome: "tool_error", action: act("http_get"), observation: "timed out" }), 160);
  assert.equal(b[0].kind, "failure");
  assert.match(b[0].text, /http_get/);
});

test("a successful call becomes a tool bullet carrying its arguments", () => {
  const b = bulletsFor(step(2, { outcome: "acted", action: act("read", { path: "/a/b.txt" }), observation: "ok" }), 160);
  assert.equal(b[0].kind, "tool");
  assert.match(b[0].text, /read\(path=\/a\/b\.txt\)/);
});

test("a denial is a failure, and says who refused", () => {
  const b = bulletsFor(step(3, { outcome: "denied", action: act("write") }), 160);
  assert.equal(b[0].kind, "failure");
  assert.match(b[0].text, /denied/);
});

test("paths and urls in an observation become artifact bullets", () => {
  const b = bulletsFor(step(4, { outcome: "acted", action: act("save"), observation: "wrote /harness/runs/x.md and https://e.com/a" }), 160);
  const arts = b.filter((x) => x.kind === "artifact").map((x) => x.text);
  assert.ok(arts.includes("/harness/runs/x.md"), arts.join("|"));
  assert.ok(arts.some((a) => a.startsWith("https://e.com")), arts.join("|"));
});

test("bullet text is clipped to the limit", () => {
  const b = bulletsFor(step(5, { outcome: "tool_error", action: act("x"), observation: "y".repeat(500) }), 40);
  assert.ok(b[0].text.length <= 40, b[0].text.length);
});

/* ── the counter ─────────────────────────────────────────────────────────── */

test("a repeated failure increments a counter instead of appending duplicates", () => {
  let bullets = [];
  for (let i = 1; i <= 40; i++) {
    bullets = curate(bullets, step(i, { outcome: "tool_error", action: act("http_get"), observation: "timed out" }));
  }
  const fails = bullets.filter((b) => b.kind === "failure");
  assert.equal(fails.length, 1, "forty identical failures are one bullet");
  assert.equal(fails[0].hits, 40);
  assert.equal(fails[0].firstStep, 1);
  assert.equal(fails[0].lastStep, 40);
});

test("digits are normalized together, so a varying timeout is still one loop", () => {
  // "timed out after 3000ms" and "after 5000ms" are the same recurring
  // failure. Treating them as two singletons hides the loop.
  let bullets = [];
  bullets = curate(bullets, step(1, { outcome: "tool_error", action: act("get"), observation: "timed out after 3000ms" }));
  bullets = curate(bullets, step(2, { outcome: "tool_error", action: act("get"), observation: "timed out after 5000ms" }));
  assert.equal(bullets.filter((b) => b.kind === "failure").length, 1);
  assert.equal(bullets[0].hits, 2);
});

test("genuinely different failures stay separate", () => {
  let bullets = [];
  bullets = curate(bullets, step(1, { outcome: "tool_error", action: act("get"), observation: "timed out" }));
  bullets = curate(bullets, step(2, { outcome: "tool_error", action: act("get"), observation: "404 not found" }));
  assert.equal(bullets.filter((b) => b.kind === "failure").length, 2);
});

test("curate never mutates the ledger it was given", () => {
  const before = [];
  const after = curate(before, step(1, { outcome: "tool_error", action: act("x"), observation: "boom" }));
  assert.equal(before.length, 0);
  assert.equal(after.length, 1);
});

/* ── pruning ─────────────────────────────────────────────────────────────── */

/* Distinct NAMES, not distinct numbers: digits normalize together on purpose,
   so tool1..tool30 would collapse into a single bullet with thirty hits. That
   is the intended behaviour, and it is what the first version of this test got
   wrong. */
const NAMES = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");

test("pruning keeps failures over successful tool calls", () => {
  let bullets = [];
  for (const n of NAMES) {
    bullets = curate(bullets, step(NAMES.indexOf(n) + 1, { outcome: "acted", action: act(n), observation: `read ${n}` }));
  }
  assert.ok(bullets.length > 20, `expected distinct bullets, got ${bullets.length}`);
  bullets = curate(bullets, step(99, { outcome: "tool_error", action: act("critical"), observation: "the thing that broke" }));
  const kept = prune(bullets, 5);
  assert.equal(kept.length, 5);
  assert.ok(kept.some((b) => b.kind === "failure"), "the failure must survive a cut");
});

test("identical calls differing only by number collapse into one counted bullet", () => {
  let bullets = [];
  for (let i = 1; i <= 30; i++) {
    bullets = curate(bullets, step(i, { outcome: "acted", action: act(`tool${i}`), observation: `ok${i}` }));
  }
  assert.equal(bullets.length, 1, "thirty numbered variants are one pattern");
  assert.equal(bullets[0].hits, 30);
});

test("pruning is deterministic for the same input", () => {
  // A ledger that reorders between identical runs would break prompt caching.
  let bullets = [];
  for (const n of NAMES) bullets = curate(bullets, step(NAMES.indexOf(n) + 1, { outcome: "acted", action: act(n), observation: "ok" }));
  assert.deepEqual(prune(bullets, 7), prune(bullets, 7));
});

test("pruning preserves chronological order, not rank order", () => {
  let bullets = [];
  for (const n of NAMES.slice(0, 10)) bullets = curate(bullets, step(NAMES.indexOf(n) + 1, { outcome: "acted", action: act(n), observation: "ok" }));
  const kept = prune(bullets, 4);
  const steps = kept.map((b) => b.firstStep);
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
});

test("a ledger under the cap is returned untouched", () => {
  const bullets = curate([], step(1, { outcome: "acted", action: act("a"), observation: "ok" }));
  assert.equal(prune(bullets, 24), bullets);
});

/* ── folding a transcript ────────────────────────────────────────────────── */

const many = Array.from({ length: 12 }, (_, i) =>
  step(i + 1, { outcome: "acted", action: act("http_get", { url: "https://e.com" }), observation: `body ${i}` }));

test("recent steps stay verbatim and the rest fold", () => {
  const r = foldSteps(many, { keepRecent: 3 });
  assert.equal(r.kept.length, 3);
  assert.deepEqual(r.kept.map((s) => s.index), [10, 11, 12]);
  assert.equal(r.foldedCount, 9);
  assert.deepEqual(r.foldedRange, [1, 9]);
  assert.ok(r.bullets.length > 0);
});

test("a short transcript is not folded at all", () => {
  const r = foldSteps(many.slice(0, 3), { keepRecent: 3 });
  assert.equal(r.foldedCount, 0);
  assert.equal(r.foldedRange, null);
  assert.deepEqual(r.bullets, []);
  assert.equal(r.kept.length, 3);
});

test("folding is all or nothing per step — no half step ever survives", () => {
  const r = foldSteps(many, { keepRecent: 5 });
  for (const s of r.kept) {
    assert.ok(s.thought !== undefined && s.observation !== undefined, "a kept step keeps both halves");
  }
  assert.equal(r.kept.length + r.foldedCount, many.length, "every step is accounted for exactly once");
});

test("keepRecent larger than the transcript keeps everything", () => {
  const r = foldSteps(many, { keepRecent: 99 });
  assert.equal(r.kept.length, 12);
  assert.equal(r.foldedCount, 0);
});

test("keepRecent of zero folds the lot", () => {
  const r = foldSteps(many, { keepRecent: 0 });
  assert.equal(r.kept.length, 0);
  assert.equal(r.foldedCount, 12);
});

/* ── rendering ───────────────────────────────────────────────────────────── */

test("the rendered ledger names the range and points at the full detail", () => {
  const r = foldSteps(many, { keepRecent: 2 });
  const text = renderLedger(r, { artifactPath: "/harness/runs/abc.md" });
  assert.ok(text.startsWith(LEDGER_HEADER));
  assert.match(text, /Steps 1-10 \(10\)/);
  assert.match(text, /\/harness\/runs\/abc\.md/);
});

test("a repeated bullet renders its count", () => {
  let bullets = [];
  for (let i = 1; i <= 4; i++) bullets = curate(bullets, step(i, { outcome: "tool_error", action: act("get"), observation: "nope" }));
  const text = renderLedger({ kept: [], bullets, foldedRange: [1, 4], foldedCount: 4 });
  assert.match(text, /\(x4\)/);
});

test("an empty ledger renders as nothing, not a lonely header", () => {
  // An empty section reads as "there was nothing earlier", which is false and
  // invites the model to redo work.
  assert.equal(renderLedger({ kept: [], bullets: [], foldedRange: null, foldedCount: 0 }), "");
});

/* ── what a supervisor should see ────────────────────────────────────────── */

test("recurring failures are surfaced, one-offs are not", () => {
  let bullets = [];
  for (let i = 1; i <= 5; i++) bullets = curate(bullets, step(i, { outcome: "tool_error", action: act("a"), observation: "same" }));
  bullets = curate(bullets, step(6, { outcome: "tool_error", action: act("b"), observation: "once" }));
  const rec = recurringFailures(bullets, 2);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].hits, 5);
});

test("the defaults are what the docs claim", () => {
  assert.equal(FOLD_DEFAULTS.keepRecent, 3);
  assert.equal(FOLD_DEFAULTS.maxBullets, 24);
});
