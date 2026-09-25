"use client";

import { useEffect, useRef, useState } from "react";
import { bus } from "@/kernel/bus";
import { appSrcDoc, routeViewMessage, toolInputNotification, toolResultNotification } from "@/lib/mcp-apps";

/* An MCP App view: the server's HTML in a sandboxed iframe (scripts, no
   same-origin, CSP first), talking JSON-RPC over postMessage. Only messages
   from THIS frame's window are routed; lib/mcp-apps.ts decides the reply. */
export function McpAppView({ html, csp, args, result, allowedTools, onCallTool }: {
  html: string;
  csp?: string;
  args: Record<string, unknown>;
  result: unknown;
  allowedTools: string[];
  onCallTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const win = ref.current?.contentWindow;
      if (!win || e.source !== win) return;
      const post = (m: unknown) => win.postMessage(m, "*"); // opaque origin: "*" is the only target that reaches it
      const theme = document.documentElement.style.colorScheme === "light" ? "light" : "dark";
      const a = routeViewMessage(e.data, { hostInfo: { name: "Web-AIOS", version: "2" }, theme, allowedTools });
      if (a.kind === "respond") post(a.message);
      else if (a.kind === "initialized") { post(toolInputNotification(args)); post(toolResultNotification(result)); }
      else if (a.kind === "call-tool") {
        setLog((l) => [...l, `app called ${a.name}`].slice(-6));
        try { post({ jsonrpc: "2.0", id: a.id, result: await onCallTool(a.name, a.args) }); }
        catch (err) { post({ jsonrpc: "2.0", id: a.id, error: { code: -32603, message: err instanceof Error ? err.message : "tool failed" } }); }
      } else if (a.kind === "message") bus.emit("aios-chat:ask", { prompt: a.text });
      else if (a.kind === "open-link") window.open(a.url, "_blank", "noopener,noreferrer");
      else if (a.kind === "resize") setHeight(a.height);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [args, result, allowedTools, onCallTool]);

  return (
    <div className="mt-2" data-mcp-app>
      <div className="os-label mb-1">App view (sandboxed)</div>
      <iframe ref={ref} title="MCP App view" sandbox="allow-scripts allow-forms" srcDoc={appSrcDoc(html, csp)} style={{ height }} className="w-full rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] bg-white" />
      {log.length > 0 && <div className="mt-1 text-[10px] text-[var(--muted)]">{log.join(" · ")}</div>}
    </div>
  );
}
