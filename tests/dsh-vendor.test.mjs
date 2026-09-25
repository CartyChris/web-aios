/**
 * The vendored DeepSeek Harness files (src/vendor/dsh, MIT) run as-is: Node 24
 * strips their types, so these import the verbatim .ts sources directly and
 * exercise exactly what dsh-lite's runtime calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchemaValue, assertSupportedJsonSchema, JsonSchemaError } from "../src/vendor/dsh/packages/core/tools/src/json-schema.ts";
import { estimateContent, ROLE_OVERHEAD } from "../src/vendor/dsh/packages/llm/token-meter/src/estimate.ts";
import { DEFAULTS, PRUNE_MARKER, resolveConfig as resolvePrune } from "../src/vendor/dsh/packages/compaction/compaction-tool-result-pruner/src/config.ts";
// compaction-basic/config.ts uses a TypeScript parameter property, which Node's
// strip-only mode cannot run; it is covered by tsc and the Next bundle only.
import { createTimestampFormatter, formatTimestamp } from "../src/vendor/dsh/packages/context/time-context/src/timestamp.ts";
// session/surface.ts (SurfaceManager) uses a TypeScript parameter property
// (strip-only mode cannot run it); it is covered by tsc only.
import { KNOWN_SESSION_EVENT_TYPES } from "../src/vendor/dsh/packages/core/session/src/known-event-types.ts";

const SCHEMA = { type: "object", properties: { path: { type: "string" }, n: { type: "integer" } }, required: ["path"], additionalProperties: false };

test("vendored json-schema validates tool arguments", () => {
  assertSupportedJsonSchema(SCHEMA);
  assert.deepEqual(validateJsonSchemaValue(SCHEMA, { path: "/a", n: 2 }, "args"), []);
  const errs = validateJsonSchemaValue(SCHEMA, { n: 1.5, extra: true }, "args");
  assert.ok(errs.length >= 2, errs.join(" | "));
  assert.ok(errs.some((e) => /path/.test(e)));
  assert.throws(() => assertSupportedJsonSchema({ type: "object", properties: { a: { $ref: "#/x" } } }), JsonSchemaError);
});

test("vendored token-meter heuristic is monotone in text length", () => {
  const a = estimateContent([{ type: "text", text: "x".repeat(40) }]);
  const b = estimateContent([{ type: "text", text: "x".repeat(4000) }]);
  assert.ok(a > 0 && b > a * 10);
  assert.equal(typeof ROLE_OVERHEAD, "number");
});

test("vendored pruner config resolves with upstream defaults", () => {
  assert.deepEqual({ ...DEFAULTS }, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
  assert.match(PRUNE_MARKER, /pruned/);
  assert.throws(() => resolvePrune({ bogus: 1 }), /unknown key/);
});

test("vendored time-context formats an RFC-ish timestamp with zone", () => {
  const s = formatTimestamp(Date.UTC(2026, 8, 24, 12, 0, 0), createTimestampFormatter("UTC"), "UTC");
  assert.equal(s, "2026-09-24T12:00:00+00:00[UTC]");
});

test("vendored session vocabulary includes every durable type dsh-lite logs", () => {
  for (const t of ["turn/start", "turn/end", "user/message", "assistant/message", "assistant/attempt", "tool/call", "tool/result"]) {
    assert.ok(KNOWN_SESSION_EVENT_TYPES.has(t), t);
  }
});
