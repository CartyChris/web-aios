/* A pet's life: kind needs, a bond that grows, and honest rules. */
import test from "node:test";
import assert from "node:assert/strict";
import { newLife, parseLife, tick, act, visit, react, mood, spriteMood, level, xpFor, unlocked, ACCESSORIES, FLOORS, dayKey } from "../.test-build/petlife.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 27, 12, 0);

test("needs drift with time, and never below their floors", () => {
  const l = tick(newLife(T0), T0 + 2 * H);
  assert.equal(l.fullness, 80 - 12);
  assert.equal(l.energy, 80 - 8);
  assert.equal(l.joy, 70 - 6);
  const away = tick(newLife(T0), T0 + 30 * 24 * H);
  assert.deepEqual([away.fullness, away.energy, away.joy], [FLOORS.fullness, FLOORS.energy, FLOORS.joy], "a month away: hungry and glad to see you, not ruined");
});

test("a sleeping pet recovers energy and wakes on its own when rested", () => {
  const s = { ...newLife(T0), energy: 30, asleep: true };
  const one = tick(s, T0 + H);
  assert.equal(one.energy, 55);
  assert.equal(one.asleep, true);
  const rested = tick(s, T0 + 4 * H);
  assert.equal(rested.energy, 100);
  assert.equal(rested.asleep, false);
});

test("feeding helps a hungry pet more, and a full one refuses", () => {
  const hungry = { ...newLife(T0), fullness: 25 };
  const r = act(hungry, "feed", T0);
  assert.equal(r.ok, true);
  assert.equal(r.life.fullness, 60);
  assert.equal(r.xp, 12);
  const full = act({ ...newLife(T0), fullness: 95 }, "feed", T0);
  assert.equal(full.ok, false);
  assert.equal(full.xp, 0, "no XP for over-feeding");
});

test("play costs energy and is refused when tired; tricks rotate", () => {
  const r = act(newLife(T0), "play", T0);
  assert.equal(r.life.energy, 65);
  assert.equal(r.life.joy, 95);
  assert.equal(act({ ...newLife(T0), energy: 10 }, "play", T0).ok, false);
  const anims = new Set();
  let l = newLife(T0);
  for (let i = 0; i < 3; i++) { const t = act(l, "trick", T0); anims.add(t.anim); l = { ...t.life, played: t.life.played + 1 }; }
  assert.deepEqual([...anims].sort(), ["dance", "jump", "spin"]);
});

test("asleep: only a pat or waking works", () => {
  const s = { ...newLife(T0), asleep: true, energy: 40 };
  assert.equal(act(s, "feed", T0).ok, false);
  assert.equal(act(s, "pat", T0).ok, true);
  assert.equal(act(s, "pat", T0).xp, 0, "no XP for patting a sleeping pet");
  assert.equal(act(s, "wake", T0).life.asleep, false);
  assert.equal(act(newLife(T0), "nap", T0).ok, false, "not sleepy at 80 energy");
});

test("visits: one per local day, streaks continue on consecutive days and reset after a gap", () => {
  const tz = 240; // New York in September
  let l = newLife(T0);
  let v = visit(l, T0, tz);
  assert.equal(v.newDay, true);
  assert.equal(v.life.streak, 1);
  assert.equal(visit(v.life, T0 + H, tz).newDay, false, "same day");
  v = visit(v.life, T0 + 24 * H, tz);
  assert.equal(v.life.streak, 2);
  v = visit(v.life, T0 + 72 * H, tz);
  assert.equal(v.life.streak, 1, "a missed day resets");
  assert.equal(dayKey(Date.UTC(2026, 8, 28, 2, 0), 240), "2026-09-27", "2am UTC is still the 27th in New York");
});

test("moods follow the needs, and map onto the sprite's four faces", () => {
  assert.equal(mood({ ...newLife(T0), fullness: 20 }), "hungry");
  assert.equal(mood({ ...newLife(T0), energy: 20 }), "tired");
  assert.equal(mood({ ...newLife(T0), joy: 30 }), "sad");
  assert.equal(mood({ ...newLife(T0), joy: 90 }), "happy");
  assert.equal(mood({ ...newLife(T0), asleep: true }), "asleep");
  assert.equal(spriteMood("hungry"), "think");
  assert.equal(spriteMood("tired"), "sleep");
});

test("bond levels and accessory unlocks", () => {
  assert.deepEqual([xpFor(1), xpFor(2), xpFor(3), xpFor(4)], [0, 40, 120, 240]);
  assert.deepEqual(level(0), { level: 1, into: 0, span: 40 });
  assert.deepEqual(level(130), { level: 3, into: 10, span: 120 });
  assert.deepEqual(unlocked(0).map((a) => a.id), ["bow"]);
  assert.ok(unlocked(xpFor(12)).some((a) => a.id === "crown"));
  assert.ok(!unlocked(xpFor(11)).some((a) => a.id === "crown"));
  assert.equal(new Set(ACCESSORIES.map((a) => a.id)).size, ACCESSORIES.length);
});

test("the OS around it: successes cheer it, failures worry it without breaking its floor", () => {
  assert.equal(react(newLife(T0), "job-done").mood, "happy");
  const low = { ...newLife(T0), joy: FLOORS.joy };
  assert.equal(react(low, "job-failed").life.joy, FLOORS.joy);
});

test("stored life is validated: junk, future timestamps and unknown accessories", () => {
  const l = parseLife({ fullness: 900, joy: "x", at: T0 + 10 * H, accessory: "jetpack", lastDay: "yesterday" }, T0);
  assert.equal(l.fullness, 100);
  assert.equal(l.joy, 70);
  assert.equal(l.at, T0, "a timestamp from the future is not trusted");
  assert.equal(l.accessory, null);
  assert.equal(l.lastDay, "");
});
