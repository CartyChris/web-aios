"use client";

import { useCallback, useMemo, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useMcp, connect, callTool, type McpServer, type McpTool } from "@/lib/mcp";
import {
  MCP_DIRECTORY, MCP_HOSTS, HOST_LABEL, shouldRelay, type McpDirectoryEntry,
} from "@/lib/mcp-directory";
import { Tabs, Empty, ErrorNote, Spinner, CopyButton } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   MCP Hub.

   The client has existed for a while, reachable only from a panel inside AI
   Studio, seeded with four localhost editor URLs. That is enough to use a
   server you already knew about and nothing at all if you did not — so this is
   the surface: a directory, a connection, the tool list a server actually
   returns, and a form that calls one and shows you the raw result.

   The thing worth getting right is the routing hint, which the directory owns
   and this file only displays. A localhost server is reached from the browser,
   because over there localhost is YOUR machine; a public one has to go through
   the relay, because it sets no CORS header. Backwards in either direction
   gives you a network error with nothing in it, and that is the failure this
   app exists to make impossible to hit by accident.
   ──────────────────────────────────────────────────────────────────────────── */

const HOST_ICON: Record<string, string> = { self: "harness", local: "terminal", public: "network" };

export default function McpHub({}: AppProps) {
  const mcp = useMcp();
  const [tab, setTab] = useState("directory");
  const [hostFilter, setHostFilter] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});

  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; ms: number } | null>(null);

  const visible = useMemo(
    () => MCP_DIRECTORY.filter((e) => hostFilter === "all" || e.host === hostFilter),
    [hostFilter],
  );

  /** The store keeps servers by id; the directory keeps descriptions. A
   *  directory entry becomes a server the moment you connect to it. */
  const serverFor = useCallback((entry: McpDirectoryEntry): McpServer => {
    const existing = mcp.servers.find((s) => s.id === entry.id);
    const token = tokens[entry.id]?.trim() || existing?.token;
    return {
      id: entry.id,
      name: entry.name,
      url: entry.url,
      // Never trust the stored flag over the rule: an entry saved by an older
      // version could carry a value that predates the rule.
      viaRelay: shouldRelay(entry.url),
      enabled: true,
      ...(token ? { token } : {}),
    };
  }, [mcp.servers, tokens]);

  const doConnect = useCallback(async (entry: McpDirectoryEntry) => {
    setError(null);
    setBusy(entry.id);
    const server = serverFor(entry);
    mcp.update(entry.id, server);
    if (!mcp.servers.some((s) => s.id === entry.id)) {
      // `add` mints its own id, which would decouple the server from the
      // directory entry it came from. Write it in place instead.
      useMcp.setState((st) => ({ servers: [...st.servers.filter((s) => s.id !== entry.id), server] }));
    }
    try {
      const conn = await connect(server);
      mcp.setConnection(entry.id, conn);
      setActiveServerId(entry.id);
      setActiveTool(conn.tools[0]?.name ?? null);
      setOutcome(null);
      if (conn.error) setError(`${entry.name}: ${conn.error}`);
      else setTab("tools");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Connection failed.";
      mcp.setConnection(entry.id, {
        serverId: entry.id, tools: [], connectedAt: Date.now(),
        error: msg,
      });
      setError(
        `${entry.name}: ${msg}` +
        (entry.host === "local"
          ? " — a server on your own machine is reached from this browser, so check it is actually running and listening on that port."
          : " — a public server is reached through this deployment's relay, which refuses private addresses by design."),
      );
    } finally {
      setBusy(null);
    }
  }, [mcp, serverFor]);

  const activeConn = activeServerId ? mcp.connections[activeServerId] : undefined;
  const activeEntry = activeServerId ? MCP_DIRECTORY.find((e) => e.id === activeServerId) : undefined;
  const tool: McpTool | undefined = activeConn?.tools.find((t) => t.name === activeTool);

  const runTool = useCallback(async () => {
    if (!activeEntry || !tool || !activeConn) return;
    setBusy("call");
    setOutcome(null);
    const started = Date.now();
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(toolArgs)) {
      if (v.trim() === "") continue;
      const prop = (tool.inputSchema?.properties ?? {})[k] as { type?: string } | undefined;
      // A number field typed as a string reaches the server as "5" and a
      // strict schema rejects it with a message about the wrong type.
      args[k] = prop?.type === "number" || prop?.type === "integer" ? Number(v) : v;
    }
    try {
      const r = await callTool(serverFor(activeEntry), activeConn.sessionId, tool.name, args);
      setOutcome({ ok: r.ok, text: r.text, ms: Date.now() - started });
    } finally {
      setBusy(null);
    }
  }, [activeEntry, tool, activeConn, toolArgs, serverFor]);

  const connectedCount = Object.values(mcp.connections).filter((c) => !c.error && c.tools.length > 0).length;

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "directory", label: `Directory (${MCP_DIRECTORY.length})`, icon: "mcp" },
          { id: "tools", label: connectedCount > 0 ? `Tools (${connectedCount} connected)` : "Tools", icon: "tune" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ErrorNote error={error} onDismiss={() => setError(null)} />

        {tab === "directory" && (
          <>
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              <button
                onClick={() => setHostFilter("all")}
                className={cn("os-chip !py-0.5 text-[10px]", hostFilter === "all" && "!border-[var(--accent)] !text-[var(--accent)]")}
              >
                All {MCP_DIRECTORY.length}
              </button>
              {MCP_HOSTS.map((h) => (
                <button
                  key={h}
                  onClick={() => setHostFilter(h)}
                  className={cn("os-chip !py-0.5 text-[10px]", hostFilter === h && "!border-[var(--accent)] !text-[var(--accent)]")}
                >
                  {HOST_LABEL[h]}
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              {visible.map((entry) => {
                const conn = mcp.connections[entry.id];
                const connected = conn && !conn.error && conn.tools.length > 0;
                return (
                  <div key={entry.id} className="os-card !p-2.5">
                    <div className="flex flex-wrap items-start gap-2">
                      <Icon name={HOST_ICON[entry.host] ?? "mcp"} size={14} className="mt-0.5 shrink-0 opacity-70" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[12.5px] font-medium">{entry.name}</span>
                          <span className="os-chip !px-1.5 !py-0 !text-[9px]">{HOST_LABEL[entry.host]}</span>
                          <span
                            className="os-chip !px-1.5 !py-0 !text-[9px]"
                            title={
                              entry.viaRelay
                                ? "Relayed through /api/mcp: this host sets no CORS header for a browser origin, so the request would never leave the page."
                                : "Sent straight from this browser. A relay would resolve localhost to the deployment's own loopback, which is a different machine."
                            }
                          >
                            {entry.viaRelay ? "relayed" : "direct"}
                          </span>
                          {connected && (
                            <span className="os-chip !px-1.5 !py-0 !text-[9px]" style={{ color: "var(--ok)" }}>
                              {conn.tools.length} tools
                            </span>
                          )}
                          {conn?.error && (
                            <span className="os-chip !px-1.5 !py-0 !text-[9px]" style={{ color: "var(--danger)" }}>
                              unreachable
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">{entry.description}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">{entry.url}</p>
                        {entry.requires && (
                          <p className="mt-1 text-[10.5px] leading-snug text-[var(--muted)]">
                            <span className="opacity-70">Needs: </span>{entry.requires}
                          </p>
                        )}
                        {entry.needsToken && (
                          <input
                            className="os-input mt-1.5 w-full text-[11px]"
                            type="password"
                            placeholder="Access token — stays in this browser"
                            value={tokens[entry.id] ?? ""}
                            onChange={(e) => setTokens((t) => ({ ...t, [entry.id]: e.target.value }))}
                          />
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col gap-1">
                        <button
                          className="os-btn !py-1 text-[11px]"
                          onClick={() => void doConnect(entry)}
                          disabled={busy === entry.id}
                        >
                          {busy === entry.id ? "Connecting…" : connected ? "Reconnect" : "Connect"}
                        </button>
                        <a href={entry.docs} target="_blank" rel="noreferrer noopener" className="os-chip !py-0.5 text-center !text-[10px]">
                          Docs
                        </a>
                      </div>
                    </div>
                    {conn?.error && (
                      <p className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[10.5px] leading-snug text-[var(--muted)]">
                        {conn.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {tab === "tools" && (
          !activeConn || activeConn.tools.length === 0 ? (
            <Empty
              icon="mcp"
              title="Nothing connected."
              body="Connect to a server in the Directory. This deployment's own server needs nothing running and is the quickest way to see the client and the server agree."
            />
          ) : (
            <div className="app-split flex min-h-0 gap-3">
              <div className="app-sidebar w-56 shrink-0">
                <div className="os-label mb-1">{activeEntry?.name}</div>
                <div className="space-y-0.5">
                  {activeConn.tools.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => { setActiveTool(t.name); setToolArgs({}); setOutcome(null); }}
                      className={cn(
                        "block w-full truncate rounded px-2 py-1 text-left text-[11.5px]",
                        t.name === activeTool ? "bg-[var(--accent)]/16" : "hover:bg-[var(--hover)]",
                      )}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="min-w-0 flex-1">
                {tool && (
                  <>
                    <div className="os-label mb-1">{tool.name}</div>
                    {tool.description && (
                      <p className="mb-2 text-[11px] leading-relaxed text-[var(--muted)]">{tool.description}</p>
                    )}
                    <div className="mb-2 grid gap-2 sm:grid-cols-2">
                      {Object.entries(tool.inputSchema?.properties ?? {}).map(([name, raw]) => {
                        const prop = raw as { type?: string; description?: string };
                        const required = (tool.inputSchema?.required ?? []).includes(name);
                        return (
                          <label key={name} className="block">
                            <span className="os-label mb-0.5 block">
                              {name}
                              {required && <span className="ml-1 text-[var(--accent)]">required</span>}
                            </span>
                            <input
                              className="os-input w-full text-[11.5px]"
                              placeholder={prop.description ?? prop.type ?? "value"}
                              value={toolArgs[name] ?? ""}
                              onChange={(e) => setToolArgs((a) => ({ ...a, [name]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") void runTool(); }}
                            />
                          </label>
                        );
                      })}
                      {Object.keys(tool.inputSchema?.properties ?? {}).length === 0 && (
                        <p className="text-[11px] text-[var(--muted)]">This tool takes no arguments.</p>
                      )}
                    </div>
                    <button className="os-btn" onClick={() => void runTool()} disabled={busy === "call"}>
                      <Icon name="play" size={13} /> {busy === "call" ? "Calling…" : "Call"}
                    </button>

                    {busy === "call" && <div className="mt-2"><Spinner label={`Calling ${tool.name}…`} /></div>}

                    {outcome && (
                      <div
                        className="os-card mt-2.5 !p-2.5"
                        style={{ borderColor: outcome.ok ? "var(--border)" : "var(--danger)" }}
                      >
                        <div className="mb-1.5 flex items-center gap-1.5">
                          <Icon
                            name={outcome.ok ? "check" : "warning"}
                            size={13}
                            style={{ color: outcome.ok ? "var(--ok)" : "var(--danger)" }}
                          />
                          <span className="text-[11.5px] font-medium">
                            {outcome.ok ? "Returned" : "The tool reported an error"}
                          </span>
                          <span className="text-[10px] text-[var(--muted)]">{outcome.ms} ms</span>
                          <div className="flex-1" />
                          <CopyButton text={outcome.text} label="Copy" className="!px-1.5 !py-0 !text-[10px]" />
                        </div>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                          {outcome.text}
                        </pre>
                        {!outcome.ok && (
                          <p className="mt-1.5 text-[10.5px] leading-snug text-[var(--muted)]">
                            A failed tool call is not a transport failure. The server answered; the tool itself
                            refused or could not complete, and the text above is what it said.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
