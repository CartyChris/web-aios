/**
 * Swarm subagent context modes: isolated (fresh) vs forked (inherits the supervisor).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentContext } from "../.test-build/swarm-context.js";

const prior = [
  { agentId: "a", agentName: "Red", role: "attack", text: "RED-OUTPUT" },
  { agentId: "b", agentName: "Blue", role: "defend", text: "BLUE-OUTPUT" },
];
const base = { question: "Q?", supervisor: "SUPERVISOR-NOTES", declaredBlock: "", allPrior: prior, declaredIds: [] };

test("isolated sees only the question and its declared inputs", () => {
  const c = buildAgentContext({ ...base, mode: "isolated" });
  assert.equal(c.user, "Q?");
  assert.equal(c.inheritedChars, 0);
  assert.ok(!c.user.includes("SUPERVISOR-NOTES"));
  assert.ok(!c.user.includes("RED-OUTPUT"));
  const d = buildAgentContext({ ...base, mode: "isolated", declaredBlock: "DECLARED", declaredIds: ["a"] });
  assert.equal(d.user, "Q?\n\nDECLARED");
});

test("forked inherits supervisor notes and all prior work, without repeating declared inputs", () => {
  const c = buildAgentContext({ ...base, mode: "forked", declaredBlock: "DECLARED-RED", declaredIds: ["a"] });
  assert.ok(c.user.includes("SUPERVISOR-NOTES"));
  assert.ok(c.user.includes("BLUE-OUTPUT"));
  assert.ok(!c.user.includes("RED-OUTPUT"), "declared output is carried once, via the declared block");
  assert.ok(c.inheritedChars > 0);
  assert.match(c.systemNote, /forked/);
});

test("forked context is capped, keeping the newest material", () => {
  const long = [{ agentId: "x", agentName: "X", role: "r", text: "old".repeat(5000) + "NEWEST" }];
  const c = buildAgentContext({ ...base, mode: "forked", supervisor: "", allPrior: long, maxInherited: 1000 });
  assert.ok(c.user.includes("NEWEST"));
  assert.match(c.user, /earlier characters of inherited context dropped/);
  assert.ok(c.inheritedChars < 1100);
});
