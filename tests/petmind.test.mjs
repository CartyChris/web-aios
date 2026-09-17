/* What the desktop pet says, and how.
 *
 * The property under test is that the two axes stay separate. A mode must
 * never dictate tone and a personality must never dictate subject — otherwise
 * you get what the old catalogue had, where every "personality" also insisted
 * on talking about the desktop, so a gremlin and a scholar said the same
 * sentence in different costumes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PET_MODES, PERSONALITIES, VOICES, getMode, getPersonality, getVoice,
  composePetPrompt, cannedLine, tidyReply, PET_MAX_WORDS, PET_MAX_TOKENS,
} from "../.test-build/petmind.js";

const base = { petName: "Mochi", speciesName: "Fox", modeId: "tips", personalityId: "helpful" };

/* ── catalogue integrity ─────────────────────────────────────────────────── */

test("there are plenty of modes and personalities, and every id is unique", () => {
  assert.ok(PET_MODES.length >= 14, `only ${PET_MODES.length} modes`);
  assert.ok(PERSONALITIES.length >= 20, `only ${PERSONALITIES.length} personalities`);
  assert.ok(VOICES.length >= 14, `only ${VOICES.length} voices`);
  for (const [label, list] of [["mode", PET_MODES], ["personality", PERSONALITIES], ["voice", VOICES]]) {
    const ids = list.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate ${label} id`);
  }
});

test("the two axes multiply into a lot of distinct pets", () => {
  assert.ok(PET_MODES.length * PERSONALITIES.length >= 300, "the point of splitting the axes was the multiplication");
});

test("every mode carries offline lines, so the pet never goes silent", () => {
  // A pet that says nothing when the wifi drops reads as broken, not offline.
  for (const m of PET_MODES) {
    assert.ok(m.canned.length >= 4, `${m.id} has only ${m.canned.length} canned lines`);
    for (const line of m.canned) assert.ok(line.trim().length > 0, `${m.id} has a blank canned line`);
  }
});

test("every mode and personality is described well enough to choose between", () => {
  for (const m of PET_MODES) {
    assert.ok(m.name.length > 0 && m.blurb.length > 8, `${m.id}: thin blurb`);
    assert.ok(m.prompt.length > 40, `${m.id}: prompt too vague to steer a model`);
  }
  for (const p of PERSONALITIES) {
    assert.ok(p.blurb.length > 5, `${p.id}: thin blurb`);
    assert.ok(p.line.length > 20, `${p.id}: voice line too vague`);
  }
});

/* ── the axes must stay separate ─────────────────────────────────────────── */

test("no personality dictates a SUBJECT", () => {
  // This is the bug the split exists to fix: the old "personalities" all
  // instructed the pet to give desktop tips, so the voice choice was cosmetic.
  const subjectWords = /\b(desktop|OS|operating system|feature|productivity|workflow|shortcut)\b/i;
  for (const p of PERSONALITIES) {
    assert.doesNotMatch(p.line, subjectWords, `personality "${p.id}" dictates a subject as well as a voice`);
  }
});

test("no mode dictates a TONE", () => {
  const toneWords = /\b(deadpan|sarcastic|warmly|cheerfully|grumpily|in the voice of a)\b/i;
  for (const m of PET_MODES) {
    assert.doesNotMatch(m.prompt, toneWords, `mode "${m.id}" dictates a tone as well as a subject`);
  }
});

test("the modes that are meant to ignore the computer say so explicitly", () => {
  for (const id of ["friend", "inspiration", "factoid", "lore", "zen", "haiku", "weather"]) {
    const m = getMode(id);
    assert.match(m.prompt, /never mention|do not mention|not about their computer/i, `${id} does not forbid software talk`);
  }
});

test("only the modes that need it ask for screen context", () => {
  // A friend asking how you are does not need your window list.
  assert.equal(getMode("friend").wantsContext, false);
  assert.equal(getMode("inspiration").wantsContext, false);
  assert.equal(getMode("tips").wantsContext, true);
  assert.equal(getMode("coach").wantsContext, true);
});

test("an unknown id falls back rather than returning undefined", () => {
  assert.equal(getMode("no_such_mode").id, PET_MODES[0].id);
  assert.equal(getPersonality("no_such_personality").id, PERSONALITIES[0].id);
  assert.equal(getVoice("no_such_voice").id, VOICES[0].id);
});

/* ── composition ─────────────────────────────────────────────────────────── */

test("the prompt names the pet, the species, the subject and the voice", () => {
  const p = composePetPrompt(base);
  assert.match(p, /You are Mochi, a small fox/);
  assert.match(p, /WHAT TO SAY:/);
  assert.match(p, /HOW TO SOUND:/);
  assert.ok(p.includes(getMode("tips").prompt));
  assert.ok(p.includes(getPersonality("helpful").line));
});

test("the SUBJECT comes before the VOICE", () => {
  // A model given the voice first performs the voice and forgets the
  // assignment — a pirate talking about being a pirate.
  const p = composePetPrompt({ ...base, modeId: "factoid", personalityId: "pirate" });
  assert.ok(p.indexOf("WHAT TO SAY:") < p.indexOf("HOW TO SOUND:"), "voice was placed before subject");
});

test("an unnamed pet falls back to its species name", () => {
  assert.match(composePetPrompt({ ...base, petName: "  " }), /You are Fox, a small fox/);
});

test("the length limit is always stated", () => {
  for (const m of PET_MODES.slice(0, 5)) {
    const p = composePetPrompt({ ...base, modeId: m.id });
    assert.match(p, new RegExp(`under ${PET_MAX_WORDS} words`));
    assert.match(p, /No quotes, no emoji/);
  }
  assert.ok(PET_MAX_TOKENS <= 100, "a pet reply must cost approximately nothing");
});

test("context reaches a mode that wants it", () => {
  const p = composePetPrompt({ ...base, modeId: "tips", context: { openApps: ["Chat", "Notes"], hour: 14, pats: 9 } });
  assert.match(p, /open right now: Chat, Notes/);
  assert.match(p, /the local hour is 14/);
  assert.match(p, /clicked you 9 times/);
});

test("context is WITHHELD from a mode that does not want it", () => {
  const p = composePetPrompt({ ...base, modeId: "friend", context: { openApps: ["Chat"], hour: 14 } });
  assert.doesNotMatch(p, /open right now/);
  assert.doesNotMatch(p, /local hour/);
});

test("a low pat count is not mentioned, so the pet is not immediately weird about it", () => {
  const p = composePetPrompt({ ...base, context: { pats: 2 } });
  assert.doesNotMatch(p, /clicked you/);
});

test("an absurd hour is clamped rather than passed through", () => {
  assert.match(composePetPrompt({ ...base, context: { hour: 99 } }), /the local hour is 23/);
  assert.match(composePetPrompt({ ...base, context: { hour: -5 } }), /the local hour is 0/);
});

test("a long app list is trimmed before it reaches the prompt", () => {
  const many = Array.from({ length: 20 }, (_, i) => `App${i}`);
  const p = composePetPrompt({ ...base, context: { openApps: many } });
  assert.match(p, /App0, App1, App2, App3, App4, App5/);
  assert.doesNotMatch(p, /App7/);
});

test("empty context adds no dangling context line", () => {
  assert.doesNotMatch(composePetPrompt({ ...base, context: {} }), /Context you may use/);
});

/* ── the offline path ────────────────────────────────────────────────────── */

test("a canned line comes from the MODE, because the subject is what you notice is missing", () => {
  const line = cannedLine("friend", "deadpan", () => 0);
  assert.ok(getMode("friend").canned.includes(line));
  assert.ok(!getPersonality("deadpan").canned.includes(line));
});

test("the random choice is injected, so the fallback path is testable at all", () => {
  const mode = getMode("factoid");
  assert.equal(cannedLine("factoid", "helpful", () => 0), mode.canned[0]);
  assert.equal(cannedLine("factoid", "helpful", () => 0.999999), mode.canned[mode.canned.length - 1]);
});

test("an out-of-range rng cannot produce undefined", () => {
  assert.equal(typeof cannedLine("tips", "helpful", () => 1.5), "string");
  assert.equal(typeof cannedLine("tips", "helpful", () => -3), "string");
  assert.notEqual(cannedLine("tips", "helpful", () => 1.5).trim(), "");
});

test("every mode can produce a canned line for every personality", () => {
  for (const m of PET_MODES) {
    for (const p of PERSONALITIES) {
      const line = cannedLine(m.id, p.id, () => 0.5);
      assert.ok(line.trim().length > 0, `${m.id}/${p.id} produced nothing`);
    }
  }
});

/* ── tidying a model reply ───────────────────────────────────────────────── */

test("quotes, markdown and a name prefix are stripped", () => {
  assert.equal(tidyReply('"Hello there."', "fb"), "Hello there.");
  assert.equal(tidyReply("**Hello there.**", "fb"), "Hello there.");
  assert.equal(tidyReply("Mochi: Hello there.", "fb", "Mochi"), "Hello there.");
  assert.equal(tidyReply("> Hello there.", "fb"), "Hello there.");
  assert.equal(tidyReply("- Hello there.", "fb"), "Hello there.");
});

test("only the first non-empty line survives", () => {
  assert.equal(tidyReply("\n\nFirst line.\nSecond line.", "fb"), "First line.");
});

test("an empty or whitespace reply falls back", () => {
  assert.equal(tidyReply("", "fallback"), "fallback");
  assert.equal(tidyReply("   \n\n  ", "fallback"), "fallback");
  assert.equal(tidyReply('""', "fallback"), "fallback");
});

test("a sentence containing a colon is NOT mistaken for a name prefix", () => {
  // The negative control for the prefix stripper, and it caught a real bug: a
  // generic /^Word:/ rule ate this factoid down to the clause after the colon.
  const factoid = "Honey never spoils: bacteria cannot use its water.";
  assert.equal(tidyReply(factoid, "fb"), factoid);
  assert.equal(tidyReply(factoid, "fb", "Mochi"), factoid, "even with a name set, real text must survive");
  assert.equal(tidyReply("There is one rule: be kind.", "fb", "Rule"), "There is one rule: be kind.");
});

test("the name prefix is stripped case-insensitively and only at the start", () => {
  assert.equal(tidyReply("mochi:  Hello.", "fb", "Mochi"), "Hello.");
  assert.equal(tidyReply("Ask Mochi: anything.", "fb", "Mochi"), "Ask Mochi: anything.");
});

test("a pet name containing regex characters does not break the stripper", () => {
  // A name is user input. "C++" or "(o_o)" must not throw or match wildly.
  assert.equal(tidyReply("C++: hello", "fb", "C++"), "hello");
  assert.equal(tidyReply("plain text", "fb", "(o_o)"), "plain text");
});

test("a haiku's slashes survive tidying", () => {
  const h = "cold glass under thumbs / the machine hums its one note / nothing is finished";
  assert.equal(tidyReply(h, "fb"), h);
});
