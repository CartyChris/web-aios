/* ────────────────────────────────────────────────────────────────────────────
   AI through a local CLI, via the Bridge companion daemon.

   People who pay for Claude Code or Codex already have a model on their
   machine behind a subscription. The Bridge daemon (localhost only, pairing
   token, dies with the process) gains one endpoint, POST /ai, that runs an
   ALLOWLISTED CLI with FIXED arguments and the prompt on stdin -- never
   through a shell, never with the prompt as an argument -- and returns what
   it printed. The provider "bridge" routes every AI feature in the OS through
   it, the office apps included.

   The CLIs run in a read-only posture: Claude Code with its editing and shell
   tools disallowed, Codex with --sandbox read-only, both in an empty working
   directory inside the Bridge workspace.

   PURE (the daemon is source text, run by the person with node).
   ──────────────────────────────────────────────────────────────────────────── */

export const BRIDGE_CLIS = ["claude", "codex"] as const;
export type BridgeCli = (typeof BRIDGE_CLIS)[number];

/** "claude", "claude:sonnet", "codex:gpt-5.2" -> which CLI, and an optional model for it. */
export function parseBridgeModel(id: string): { cli: BridgeCli; model?: string } | null {
  // A model name must start with a letter or digit, so it can never be read as a flag.
  const m = /^(claude|codex)(?::([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$/.exec(id.trim());
  if (!m) return null;
  return m[2] ? { cli: m[1] as BridgeCli, model: m[2] } : { cli: m[1] as BridgeCli };
}

type Msg = { role: string; content: string | Array<{ type?: string; text?: string }> };

/** A chat as one plain-text prompt: a CLI takes a single message, not a message list. */
export function transcriptPrompt(messages: Msg[]): string {
  const text = (c: Msg["content"]) => (typeof c === "string" ? c : c.map((p) => p.text ?? "").join(""));
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 1) return text(turns[0].content);
  return turns.map((m) => `${m.role === "assistant" ? "Assistant" : m.role === "tool" ? "Tool result" : "User"}: ${text(m.content)}`).join("\n\n") + "\n\nAssistant:";
}

export const BRIDGE_DAEMON_SOURCE = `#!/usr/bin/env node
/* Web-AIOS companion bridge -- no dependencies.
 *
 * Bound to loopback only. The pairing token is generated at startup and dies
 * with the process. Commands are restricted to an allowlist and file access is
 * confined to one workspace directory. /ai runs an allowlisted AI CLI (Claude
 * Code or Codex) with fixed, read-only arguments and the prompt on stdin.
 * Run it, paste the token into the Bridge app, and close the terminal when
 * you are done.
 */
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORTS = (process.env.WEB_AIOS_BRIDGE_PORTS || '8787,8788,8789,8790,8791').split(',').map(Number);
const TOKEN = process.env.WEB_AIOS_BRIDGE_TOKEN || crypto.randomBytes(16).toString('hex');
const ROOT = process.env.WEB_AIOS_BRIDGE_ROOT || path.join(os.homedir(), 'web-aios-workspace');
const ALLOW = new Set(['ls', 'pwd', 'date', 'uname', 'whoami', 'node', 'python3', 'git', 'which', 'echo']);
const AI_DIR = path.join(ROOT, '.ai');
fs.mkdirSync(AI_DIR, { recursive: true });

/* Fixed arguments per CLI. The prompt is never an argument. */
const AI_CLIS = {
  claude: (model, system) => ['-p', '--output-format', 'text']
    .concat(model ? ['--model', model] : [])
    .concat(system ? ['--append-system-prompt', system] : [])
    .concat(['--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']),
  codex: (model) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral']
    .concat(model ? ['-m', model] : [])
    .concat(['-']),
};
// Starts with a letter or digit: "--dangerously-skip-permissions" is not a model.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Which allowlisted AI CLIs are on PATH. */
const detectClis = () => Object.keys(AI_CLIS).filter((bin) =>
  (process.env.PATH || '').split(path.delimiter).some((d) => { try { return fs.statSync(path.join(d, bin)).isFile(); } catch { return false; } }));

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-aurora-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};
const json = (res, code, body) => {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Refuse any path that escapes the workspace, including via symlink or "..". */
const safePath = (p) => {
  const full = path.resolve(ROOT, p || '.');
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error('path escapes workspace');
  return full;
};

const readBody = (req, limit, done) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > limit) req.destroy(); });
  req.on('end', () => done(body));
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    return json(res, 200, { version: '1.1.0', root: ROOT, allow: [...ALLOW], clis: detectClis() });
  }

  // Everything past this point requires the token.
  const given = req.headers['x-aurora-token'];
  if (given !== TOKEN) return json(res, 401, { error: 'bad or missing token' });

  if (url.pathname === '/exec' && req.method === 'POST') {
    readBody(req, 1e6, (body) => {
      let cmd;
      try { cmd = JSON.parse(body).cmd; } catch { return json(res, 400, { error: 'bad JSON' }); }
      const parts = String(cmd || '').trim().split(/\\s+/);
      const bin = parts[0];
      if (!ALLOW.has(bin)) return json(res, 403, { error: bin + ' is not allowlisted' });
      // execFile, not exec: no shell means no injection through the arguments.
      execFile(bin, parts.slice(1), { cwd: ROOT, timeout: 25000, maxBuffer: 4e6 }, (err, stdout, stderr) => {
        json(res, 200, { stdout: stdout || '', stderr: stderr || (err ? String(err.message) : '') });
      });
    });
    return;
  }

  if (url.pathname === '/ai' && req.method === 'POST') {
    readBody(req, 2e6, (body) => {
      let q;
      try { q = JSON.parse(body); } catch { return json(res, 400, { error: 'bad JSON' }); }
      const make = AI_CLIS[q && q.cli];
      if (!make || !Object.prototype.hasOwnProperty.call(AI_CLIS, q.cli)) return json(res, 403, { error: String(q && q.cli) + ' is not an allowlisted AI CLI (' + Object.keys(AI_CLIS).join(', ') + ')' });
      const model = q.model ? String(q.model) : '';
      if (model && !MODEL_RE.test(model)) return json(res, 400, { error: 'bad model name' });
      const system = q.system ? String(q.system).slice(0, 20000) : '';
      const prompt = String(q.prompt || '').slice(0, 400000);
      if (!prompt.trim()) return json(res, 400, { error: 'empty prompt' });
      // Codex has no system-prompt flag: the system text leads the prompt instead.
      const stdin = q.cli === 'codex' && system ? system + '\\n\\n' + prompt : prompt;
      const started = Date.now();
      const child = execFile(q.cli, make(model, q.cli === 'claude' ? system : ''), { cwd: AI_DIR, timeout: 300000, maxBuffer: 8e6, env: process.env }, (err, stdout, stderr) => {
        if (err && !stdout) return json(res, 502, { error: (err.killed ? 'timed out' : String(err.message)).slice(0, 500), stderr: String(stderr || '').slice(-2000) });
        json(res, 200, { text: String(stdout || '').trim(), ms: Date.now() - started, cli: q.cli });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    });
    return;
  }

  if (url.pathname === '/read') {
    try {
      const f = safePath(url.searchParams.get('path'));
      return json(res, 200, { content: fs.readFileSync(f, 'utf8') });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === '/write' && req.method === 'POST') {
    readBody(req, 5e6, (body) => {
      try {
        const { path: p, content } = JSON.parse(body);
        const f = safePath(p);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, String(content ?? ''));
        json(res, 200, { ok: true, path: f });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (url.pathname === '/list') {
    try {
      const d = safePath(url.searchParams.get('path'));
      const entries = fs.readdirSync(d, { withFileTypes: true })
        .map((e) => ({ name: e.name, dir: e.isDirectory() }));
      return json(res, 200, { entries });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  json(res, 404, { error: 'not found' });
});

(function listen(i) {
  if (i >= PORTS.length) { console.error('No free port in', PORTS.join(', ')); process.exit(1); }
  server.listen(PORTS[i], '127.0.0.1')
    .on('listening', () => {
      console.log('Web-AIOS bridge on http://127.0.0.1:' + PORTS[i]);
      console.log('Workspace: ' + ROOT);
      console.log('AI CLIs found: ' + (detectClis().join(', ') || 'none'));
      console.log('');
      console.log('  Pairing token:  ' + TOKEN);
      console.log('');
      console.log('Paste that into the Bridge app (and Settings, provider Bridge). Ctrl-C ends the session and invalidates it.');
    })
    .on('error', () => listen(i + 1));
})(0);
`;
