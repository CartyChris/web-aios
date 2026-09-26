#!/usr/bin/env node
/* A scripted OpenAI-compatible endpoint for verifying agent flows WITHOUT a
   model. It returns canned replies chosen by rules; it does not generate
   anything, download anything or run any model, so it is safe under the
   project rule against running local model servers.

   Usage:
     node scripts/stub-model.mjs [rules.json] [port]      (default port 3199)

   Then, in the browser under test, point the "lmstudio" provider at
   http://localhost:3199/v1 (Settings > AI, or through window.__aios).

   Rules are tried in order against the text of the LAST message in the
   request; the first whose `when` regex matches wins. `{{last}}` in a reply
   is replaced by the first 300 characters of that message, which is how a
   test proves a tool's output actually reached the model's context. Every
   request is logged to stdout as one JSON line, so a test can also assert on
   what the app sent. */
import http from "node:http";
import { readFileSync } from "node:fs";

const DEFAULT_RULES = [
  // A tool result came back: finish, quoting it.
  { when: "entr(y|ies) from|Nothing in the timeline", reply: '{"final":"STUB saw the timeline tool result: {{last}}"}' },
  // First turn: call the timeline tool.
  { when: ".", reply: '{"tool":"timeline","args":{"query":"3 days ago"}}' },
];

const rules = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : DEFAULT_RULES;
const port = Number(process.argv[3] ?? 3199);

const textOf = (m) =>
  typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? "").join("") : "";

function pick(messages) {
  const last = textOf(messages[messages.length - 1]);
  for (const r of rules) {
    if (new RegExp(r.when, "i").test(last)) return r.reply.replaceAll("{{last}}", JSON.stringify(last.slice(0, 300)).slice(1, -1));
  }
  return '{"final":"STUB: no rule matched"}';
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    let j = {};
    try { j = JSON.parse(body || "{}"); } catch { /* keep {} */ }
    const messages = Array.isArray(j.messages) ? j.messages : [];
    const reply = pick(messages);
    console.log(JSON.stringify({ at: Date.now(), url: req.url, stream: !!j.stream, turns: messages.length, last: textOf(messages[messages.length - 1]).slice(0, 200), reply }));
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (j.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...cors });
      res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify({ id: "stub", object: "chat.completion", model: "stub-model", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage }));
  });
}).listen(port, () => console.error(`stub-model listening on :${port} with ${rules.length} rules`));
