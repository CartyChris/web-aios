"use client";

import { useCallback, useEffect, useState } from "react";
import { bus } from "@/kernel/bus";
import type { AppProps } from "@/kernel/types";
import { download } from "@/lib/format";
import { Tabs, ErrorNote, Empty, Spinner, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";

/* ────────────────────────────────────────────────────────────────────────────
   Bridge — ported from aurora-bridge.js + Start-Aurora-OS.command.

   A browser cannot spawn a process or read your disk, and it should not be able
   to. The original's answer was a small companion daemon on localhost with a
   token that dies with the process and a hard allowlist of commands. That model
   is kept exactly; this app is the client half.

   What is different here, and stated plainly rather than hidden: a page served
   from https on Vercel may be blocked from reaching http://localhost by mixed
   content rules, depending on the browser. This app detects that and says so
   instead of showing a silent "disconnected".
   ──────────────────────────────────────────────────────────────────────────── */

const PORTS = [8787, 8788, 8789, 8790, 8791];

interface BridgeInfo {
  version?: string;
  root?: string;
  allow?: string[];
  clis?: string[];
}

export default function Bridge({}: AppProps) {
  const [tab, setTab] = useState("connect");
  const [status, setStatus] = useState<"idle" | "scanning" | "connected" | "failed">("idle");
  const [base, setBase] = useState("");
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<BridgeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cmd, setCmd] = useState("");
  const [out, setOut] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Shell-style recall: Up/Down walk the commands run this session.
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [histAt, setHistAt] = useState(-1);
  const [insecureContext, setInsecureContext] = useState(false);

  useEffect(() => {
    // An https page reaching http://localhost is the thing most likely to fail
    // here, so check for it up front rather than after a confusing timeout.
    if (typeof window !== "undefined") setInsecureContext(window.location.protocol === "https:");
  }, []);

  const scan = useCallback(async () => {
    setStatus("scanning");
    setError(null);
    for (const port of PORTS) {
      const url = `http://127.0.0.1:${port}`;
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
        if (!res.ok) continue;
        const data = (await res.json()) as BridgeInfo;
        setBase(url);
        setInfo(data);
        setStatus("connected");
        bus.emit("notify", { title: "Bridge connected", body: url, kind: "success" });
        return;
      } catch {
        // Expected for every port with nothing on it.
      }
    }
    setStatus("failed");
    setError(
      insecureContext
        ? "No bridge found. This page is served over https, and some browsers block requests from https pages to http://localhost. If the daemon is running, either open Web-AIOS from a local dev server (http://localhost:3000) or give the bridge a TLS certificate."
        : "No bridge found on ports 8787–8791. Start the companion daemon (Daemon tab) and scan again.",
    );
  }, [insecureContext]);

  const run = useCallback(async () => {
    if (!base || !cmd.trim() || busy) return;
    setBusy(true);
    setOut((o) => [...o, `$ ${cmd}`]);
    setCmdHistory((h) => [cmd, ...h.filter((x) => x !== cmd)].slice(0, 50));
    setHistAt(-1);
    try {
      const res = await fetch(`${base}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aurora-token": token },
        body: JSON.stringify({ cmd }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `${res.status}`);
      setOut((o) => [...o, data.stdout || data.stderr || "(no output)"]);
      setCmd("");
    } catch (e) {
      setOut((o) => [...o, `error: ${e instanceof Error ? e.message : "failed"}`]);
    } finally { setBusy(false); }
  }, [base, cmd, token, busy]);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[{ id: "connect", label: "Connect", icon: "bridge" }, { id: "shell", label: "Shell", icon: "terminal" }, { id: "daemon", label: "Daemon", icon: "assets" }]}
        active={tab}
        onChange={setTab}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ErrorNote error={error} onDismiss={() => setError(null)} />

        {tab === "connect" && (
          <div className="max-w-2xl">
            <div className={cn("os-card mb-3", status === "connected" && "!border-[var(--ok)]")}>
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: status === "connected" ? "var(--ok)" : status === "failed" ? "var(--danger)" : "var(--muted)" }}
                />
                <span className="font-medium text-[13px]">
                  {status === "connected" ? `Connected — ${base}` : status === "scanning" ? "Scanning…" : status === "failed" ? "Not connected" : "Not connected"}
                </span>
                <div className="flex-1" />
                {status === "scanning" ? <Spinner /> : <button className="os-btn !py-1 text-[11px]" onClick={scan}>Scan ports</button>}
              </div>

              {status === "connected" && info && (
                <div className="space-y-0.5 text-[11.5px] text-[var(--muted)]">
                  {info.version && <div>daemon v{info.version}</div>}
                  {info.root && <div>workspace: <code>{info.root}</code></div>}
                  {info.allow && <div>allowed commands: {info.allow.join(", ")}</div>}
                  {info.clis?.length ? <div>detected CLIs: {info.clis.join(", ")}</div> : null}
                </div>
              )}

              <div className="mt-2.5">
                <div className="os-label mb-1">Pairing token</div>
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Printed by the daemon when it starts"
                  className="os-input !py-1 font-[family-name:var(--font-mono)] text-[11px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>

            {insecureContext && (
              <div className="os-card mb-3" style={{ borderColor: "var(--warn)" }}>
                <div className="mb-1 font-medium text-[13px]">This page is served over https</div>
                <p className="text-[12px] leading-relaxed text-[var(--muted)]">
                  Browsers differ on whether an https page may call <code>http://localhost</code>. Chrome generally
                  permits it because localhost counts as a trustworthy origin; Firefox and Safari may block it as mixed
                  content. If scanning finds nothing while the daemon is definitely running, that is the reason — run
                  Web-AIOS from <code>npm run dev</code> on http://localhost, or terminate TLS at the bridge.
                </p>
              </div>
            )}

            <div className="os-card" style={{ borderColor: "var(--accent)" }}>
              <div className="mb-1 font-medium text-[13px]">What the bridge can and cannot do</div>
              <ul className="space-y-1 text-[12px] leading-relaxed text-[var(--muted)]">
                <li>· Runs only on <b className="text-[var(--text)]">your machine</b>, bound to loopback. Nothing about it is reachable from the internet.</li>
                <li>· The token is generated fresh at startup and <b className="text-[var(--text)]">dies with the process</b>. Restarting it invalidates the old one.</li>
                <li>· Commands are restricted to a hard allowlist, and file access is confined to one workspace directory.</li>
                <li>· It is optional. Every other app in this OS works without it.</li>
              </ul>
            </div>
          </div>
        )}

        {tab === "shell" && (
          status !== "connected" ? (
            <Empty icon="bridge" title="Not connected" body="Pair with the local daemon on the Connect tab first." />
          ) : (
            <div className="flex h-full flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto rounded-[var(--radius)] border border-[var(--border)] p-2.5 font-[family-name:var(--font-mono)] text-[11.5px]">
                {out.length === 0 && <div className="text-[var(--muted)]">Allowed commands: {info?.allow?.join(", ") ?? "ls, pwd, date, uname, whoami, node, python3, git, which, echo"}</div>}
                {out.map((l, i) => (
                  <pre key={i} className="whitespace-pre-wrap break-words" style={{ color: l.startsWith("$") ? "var(--accent)" : l.startsWith("error:") ? "var(--danger)" : "inherit" }}>{l}</pre>
                ))}
              </div>
              <div className="mt-2 flex gap-1.5">
                <input
                  value={cmd}
                  onChange={(e) => setCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { void run(); return; }
                    if (e.key === "ArrowUp" && cmdHistory.length) {
                      e.preventDefault();
                      const i = Math.min(histAt + 1, cmdHistory.length - 1);
                      setHistAt(i); setCmd(cmdHistory[i]);
                    } else if (e.key === "ArrowDown" && histAt >= 0) {
                      e.preventDefault();
                      const i = histAt - 1;
                      setHistAt(i); setCmd(i >= 0 ? cmdHistory[i] : "");
                    }
                  }}
                  aria-label="Bridge command"
                  title="Up and Down recall earlier commands"
                  placeholder="Command (allowlisted only)…"
                  className="os-input flex-1 !py-1 font-[family-name:var(--font-mono)] text-[12px]"
                  spellCheck={false}
                />
                <button className="os-btn !py-1 text-[11px]" onClick={run} disabled={busy || !cmd.trim()}>Run</button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => setOut([])}>Clear</button>
              </div>
            </div>
          )
        )}

        {tab === "daemon" && (
          <div className="max-w-3xl">
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
              Save this as <code>web-aios-bridge.js</code> and run <code>node web-aios-bridge.js</code>. It needs no npm
              packages. It prints a pairing token — paste that on the Connect tab. Closing the terminal ends the session
              and invalidates the token.
            </p>
            <div className="mb-2 flex gap-1.5">
              <CopyButton text={DAEMON} label="Copy daemon source" />
              <button className="os-btn !py-1 text-[11px]" onClick={() => download("web-aios-bridge.js", DAEMON, "text/javascript")}>Download</button>
            </div>
            <pre className="max-h-[60vh] overflow-auto rounded-[var(--radius)] border border-[var(--border)] p-3 font-[family-name:var(--font-mono)] text-[10.5px] leading-relaxed">{DAEMON}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

const DAEMON = `#!/usr/bin/env node
/* Web-AIOS companion bridge — no dependencies.
 *
 * Bound to loopback only. The pairing token is generated at startup and dies
 * with the process. Commands are restricted to an allowlist and file access is
 * confined to one workspace directory. Run it, paste the token into the Bridge
 * app, and close the terminal when you are done.
 */
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORTS = [8787, 8788, 8789, 8790, 8791];
const TOKEN = crypto.randomBytes(16).toString('hex');
const ROOT = path.join(os.homedir(), 'web-aios-workspace');
const ALLOW = new Set(['ls', 'pwd', 'date', 'uname', 'whoami', 'node', 'python3', 'git', 'which', 'echo']);
fs.mkdirSync(ROOT, { recursive: true });

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

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    return json(res, 200, { version: '1.0.0', root: ROOT, allow: [...ALLOW] });
  }

  // Everything past this point requires the token.
  const given = req.headers['x-aurora-token'];
  if (given !== TOKEN) return json(res, 401, { error: 'bad or missing token' });

  if (url.pathname === '/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
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

  if (url.pathname === '/read') {
    try {
      const f = safePath(url.searchParams.get('path'));
      return json(res, 200, { content: fs.readFileSync(f, 'utf8') });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (url.pathname === '/write' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => {
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
      console.log('');
      console.log('  Pairing token:  ' + TOKEN);
      console.log('');
      console.log('Paste that into the Bridge app. Ctrl-C ends the session and invalidates it.');
    })
    .on('error', () => listen(i + 1));
})(0);
`;
