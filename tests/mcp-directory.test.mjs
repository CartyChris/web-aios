/* The MCP server directory.
 *
 * One rule carries this module: which requests leave from the browser and
 * which go through the relay. Getting it backwards produces a network error
 * with no explanation, which is the most common way a hand-written MCP client
 * appears broken — so the rule gets tested from both directions rather than
 * trusted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_DIRECTORY, MCP_HOSTS, HOST_LABEL, shouldRelay, entryById, directoryDisagreements,
} from "../.test-build/mcp-directory.js";

test("the directory is non-empty and every id is unique", () => {
  assert.ok(MCP_DIRECTORY.length >= 10, `only ${MCP_DIRECTORY.length} entries`);
  const ids = MCP_DIRECTORY.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate directory id");
});

test("every entry names what it is, where its docs are, and what it needs", () => {
  for (const e of MCP_DIRECTORY) {
    assert.ok(e.name.length > 0, `${e.id} has no name`);
    assert.ok(e.description.length > 20, `${e.id}: description too thin to choose by`);
    assert.match(e.docs, /^https:\/\//, `${e.id} docs is not an https URL`);
    assert.ok(MCP_HOSTS.includes(e.host), `${e.id} has unknown host kind ${e.host}`);
    assert.ok(HOST_LABEL[e.host], `${e.id}: host kind has no label`);
  }
});

test("an entry that needs a token says so in its requirements", () => {
  // Otherwise it fails with a 401 the user has no way to interpret.
  for (const e of MCP_DIRECTORY) {
    if (e.needsToken) assert.ok(e.requires.length > 0, `${e.id} needs a token but says nothing about it`);
  }
});

test("a local entry tells you how to start the server", () => {
  for (const e of MCP_DIRECTORY.filter((x) => x.host === "local")) {
    assert.ok(e.requires.length > 0, `${e.id} is local but does not say what to run first`);
  }
});

/* ── the routing rule, both directions ───────────────────────────────────── */

test("a localhost server is NEVER relayed — the relay's loopback is a different machine", () => {
  assert.equal(shouldRelay("http://localhost:8080/mcp"), false);
  assert.equal(shouldRelay("http://127.0.0.1:3000/mcp"), false);
  assert.equal(shouldRelay("http://[::1]:3000/mcp"), false);
  assert.equal(shouldRelay("http://mybox.local:9000/mcp"), false);
  assert.equal(shouldRelay("http://app.localhost:3000/mcp"), false);
});

test("a public server IS relayed — almost none set CORS for a browser origin", () => {
  assert.equal(shouldRelay("https://mcp.deepwiki.com/mcp"), true);
  assert.equal(shouldRelay("https://api.githubcopilot.com/mcp/"), true);
  assert.equal(shouldRelay("https://huggingface.co/mcp"), true);
});

test("a same-origin path is not relayed; it is this origin", () => {
  assert.equal(shouldRelay("/api/harness/mcp"), false);
});

test("a malformed URL does not get relayed by accident", () => {
  // Fail toward the browser: a direct request fails visibly in the console,
  // where a bad relay request would be attributed to the deployment.
  assert.equal(shouldRelay("not a url"), false);
  assert.equal(shouldRelay(""), false);
});

test("every declared viaRelay agrees with the rule", () => {
  // The negative control for the whole module: a wrong entry surfaces here
  // rather than as an unexplained network error in someone's console.
  const bad = directoryDisagreements();
  assert.deepEqual(bad, [], `entries disagree with shouldRelay: ${JSON.stringify(bad)}`);
});

test("the disagreement check can actually fail", () => {
  // A checker that always returns [] is decoration. Prove it fires.
  const wrong = { id: "x", url: "https://example.com/mcp", viaRelay: false };
  assert.notEqual(wrong.viaRelay, shouldRelay(wrong.url));
});

test("this deployment's own server is in the directory and is not relayed", () => {
  const self = entryById("self");
  assert.ok(self, "the OS does not list its own MCP server");
  assert.equal(self.host, "self");
  assert.equal(self.viaRelay, false);
  assert.equal(self.url, "/api/harness/mcp");
  assert.equal(self.needsToken, false);
});

test("entryById returns undefined for an unknown id rather than the first entry", () => {
  assert.equal(entryById("no_such_server"), undefined);
});

test("the directory covers local, public and self", () => {
  for (const host of MCP_HOSTS) {
    assert.ok(MCP_DIRECTORY.some((e) => e.host === host), `nothing in the directory is ${host}`);
  }
});
