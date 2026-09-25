/** MCP Apps host routing: what the host does with each message from a view. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeViewMessage, uiResourceUri, isAppResource, appSrcDoc } from "../.test-build/mcp-apps.js";

const ctx = { hostInfo: { name: "Web-AIOS", version: "2" }, theme: "dark", allowedTools: ["get_weather"] };

test("ui/initialize is answered with host info and capabilities", () => {
  const a = routeViewMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appCapabilities: {} } }, ctx);
  assert.equal(a.kind, "respond");
  assert.equal(a.message.id, 1);
  assert.equal(a.message.result.hostInfo.name, "Web-AIOS");
});

test("a view may only call its own server's tools", () => {
  assert.deepEqual(routeViewMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_weather", arguments: { city: "Oslo" } } }, ctx), { kind: "call-tool", id: 2, name: "get_weather", args: { city: "Oslo" } });
  const refused = routeViewMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delete_everything" } }, ctx);
  assert.equal(refused.kind, "respond");
  assert.equal(refused.message.error.code, -32602);
});

test("links must be http(s); unknown requests get method-not-found; junk is ignored", () => {
  assert.equal(routeViewMessage({ jsonrpc: "2.0", id: 4, method: "ui/open-link", params: { url: "javascript:alert(1)" } }, ctx).message.error.code, -32602);
  assert.deepEqual(routeViewMessage({ jsonrpc: "2.0", method: "ui/open-link", params: { url: "https://x.dev" } }, ctx), { kind: "open-link", url: "https://x.dev" });
  assert.equal(routeViewMessage({ jsonrpc: "2.0", id: 5, method: "fs/read" }, ctx).message.error.code, -32601);
  assert.equal(routeViewMessage({ hello: 1 }, ctx).kind, "ignore");
  assert.equal(routeViewMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 99999 } }, ctx).height, 1200);
});

test("resource detection and a CSP that lands before any script", () => {
  assert.equal(uiResourceUri({ name: "t", _meta: { ui: { resourceUri: "ui://w/dash" } } }), "ui://w/dash");
  assert.equal(uiResourceUri({ name: "t", _meta: { ui: { resourceUri: "https://evil" } } }), null);
  assert.equal(isAppResource("text/html; profile=mcp-app"), true);
  assert.equal(isAppResource("text/html"), false);
  const doc = appSrcDoc("<html><head><script>x()</script></head></html>");
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<script>"));
});
