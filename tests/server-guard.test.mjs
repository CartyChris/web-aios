/** Connect-time pinning: the address the socket connects to is the one judged,
 *  so DNS rebinding between a check and the fetch cannot reach a private host. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pinnedFetch, deploymentKeyAllowed } from "../.test-build/server-guard.js";

test("pinnedFetch refuses a host that resolves to a private address; plain fetch (the control) reaches it", async () => {
  const srv = createServer((_q, r) => r.end("internal secret")).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://localhost:${srv.address().port}/`;
  try {
    assert.equal(await (await fetch(url)).text(), "internal secret", "control: the server is reachable");
    await assert.rejects(pinnedFetch(url), /private address/);
  } finally { srv.close(); }
});

test("the deployment key only travels to the built-in URL", () => {
  assert.equal(deploymentKeyAllowed(undefined, "https://api.openai.com/v1"), true);
  assert.equal(deploymentKeyAllowed("https://api.openai.com/v1/", "https://api.openai.com/v1"), true);
  assert.equal(deploymentKeyAllowed("https://attacker.example/v1", "https://api.openai.com/v1"), false);
});
