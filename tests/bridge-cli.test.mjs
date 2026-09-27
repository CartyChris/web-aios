/* AI through a local CLI via the Bridge daemon. The daemon source is run for
 * real, with fake "claude" and "codex" programs on PATH that report exactly
 * what they were given, so the tests see the arguments and stdin a real CLI
 * would get. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { BRIDGE_DAEMON_SOURCE, parseBridgeModel, transcriptPrompt } from "../.test-build/bridge-cli.js";

const dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
const bin = join(dir, "bin");
const PORT = 18000 + Math.floor(Math.random() * 1500);
const TOKEN = "t0ken-for-tests";
const pwned = join(dir, "pwned");
let proc;

const fake = `#!/usr/bin/env node
let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ name: require("path").basename(process.argv[1]), argv: process.argv.slice(2), stdin: s, cwd: process.cwd() }));
});`;

before(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(bin);
  for (const n of ["claude", "codex", "bash"]) { writeFileSync(join(bin, n), fake); chmodSync(join(bin, n), 0o755); }
  writeFileSync(join(dir, "daemon.js"), BRIDGE_DAEMON_SOURCE);
  proc = spawn(process.execPath, [join(dir, "daemon.js")], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, WEB_AIOS_BRIDGE_PORTS: String(PORT), WEB_AIOS_BRIDGE_TOKEN: TOKEN, WEB_AIOS_BRIDGE_ROOT: join(dir, "ws") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((res, rej) => { proc.stdout.on("data", (d) => { if (String(d).includes("Pairing token")) res(); }); proc.on("exit", (c) => rej(new Error(`daemon exited ${c}`))); setTimeout(() => rej(new Error("daemon did not start")), 8000); });
});
after(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

const url = (p) => `http://127.0.0.1:${PORT}${p}`;
const ai = (body, token = TOKEN) => fetch(url("/ai"), { method: "POST", headers: { "content-type": "application/json", "x-aurora-token": token }, body: JSON.stringify(body) });

test("health lists the allowlisted AI CLIs it can find, and only those", async () => {
  const h = await (await fetch(url("/health"))).json();
  assert.deepEqual(h.clis.sort(), ["claude", "codex"], "a program called bash on PATH is not an AI CLI");
  assert.equal(h.version, "1.1.0");
});

test("no token, no AI", async () => {
  assert.equal((await ai({ cli: "claude", prompt: "hi" }, "wrong")).status, 401);
});

test("claude: prompt on stdin, fixed read-only arguments, system prompt as its own argument", async () => {
  const r = await ai({ cli: "claude", model: "sonnet", system: "Be brief.", prompt: "Summarize: $(touch " + pwned + ") `id` ; rm -rf /" });
  assert.equal(r.status, 200);
  const out = JSON.parse((await r.json()).text);
  assert.equal(out.name, "claude");
  assert.equal(out.stdin, "Summarize: $(touch " + pwned + ") `id` ; rm -rf /");
  assert.deepEqual(out.argv, ["-p", "--output-format", "text", "--model", "sonnet", "--append-system-prompt", "Be brief.", "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "MultiEdit"]);
  assert.ok(!out.argv.some((a) => a.includes("Summarize")), "the prompt is never an argument");
  assert.ok(out.cwd.endsWith(join("ws", ".ai")), "runs in the empty AI directory");
  assert.equal(existsSync(pwned), false, "shell syntax in the prompt did nothing");
});

test("codex: read-only sandbox, stdin prompt with the system text leading", async () => {
  const out = JSON.parse((await (await ai({ cli: "codex", system: "SYS", prompt: "Q" })).json()).text);
  assert.deepEqual(out.argv, ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "-"]);
  assert.equal(out.stdin, "SYS\n\nQ");
});

test("anything off the allowlist is refused", async () => {
  for (const cli of ["bash", "__proto__", "constructor", "toString", "../claude", ""]) assert.equal((await ai({ cli, prompt: "x" })).status, 403, cli);
  assert.equal((await ai({ cli: "claude", model: "x; rm -rf /", prompt: "x" })).status, 400);
  assert.equal((await ai({ cli: "claude", model: "--dangerously-skip-permissions", prompt: "x" })).status, 400, "a model name cannot smuggle a flag");
  assert.equal((await ai({ cli: "claude", prompt: "   " })).status, 400);
});

test("the old command allowlist still holds", async () => {
  const r = await fetch(url("/exec"), { method: "POST", headers: { "x-aurora-token": TOKEN }, body: JSON.stringify({ cmd: "claude -p hi" }) });
  assert.equal(r.status, 403, "AI CLIs are reachable only through /ai");
});

test("model ids and prompts on the page side", () => {
  assert.deepEqual(parseBridgeModel("claude"), { cli: "claude" });
  assert.deepEqual(parseBridgeModel("claude:opus"), { cli: "claude", model: "opus" });
  assert.deepEqual(parseBridgeModel("codex:gpt-5.2"), { cli: "codex", model: "gpt-5.2" });
  assert.equal(parseBridgeModel("bash"), null);
  assert.equal(parseBridgeModel("claude:--yolo"), null);
  assert.equal(transcriptPrompt([{ role: "system", content: "s" }, { role: "user", content: "only" }]), "only");
  assert.equal(transcriptPrompt([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: [{ type: "text", text: "c" }] }]), "User: a\n\nAssistant: b\n\nUser: c\n\nAssistant:");
});
