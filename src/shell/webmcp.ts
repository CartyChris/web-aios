"use client";

/* WebMCP bridge: Web-AIOS as a set of tools a browser's own AI agent can call.

   WebMCP (github.com/webmachinelearning/webmcp, a Chrome origin trial) lets a
   page declare tools with document.modelContext.registerTool({ name,
   description, inputSchema, execute }); aborting the signal passed alongside
   unregisters them. Feature-detected: where the API is absent this does
   nothing and says so on window.__aios.webmcp.

   The first slice is read-only plus opening apps. Anything that changes the
   user's data goes through AIOS Chat, where approvals live. */

import { APPS, getApp } from "@/kernel/registry";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { registerAiosModule } from "@/lib/aios-api";
import { briefText } from "@/lib/desk";
import { currentBrief, currentTimeline } from "@/apps/Desk";
import { queryTimeline } from "@/lib/timeline";

type ToolResult = { content: Array<{ type: "text"; text: string }> };
interface ModelContext {
  registerTool(tool: { name: string; description: string; inputSchema: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<ToolResult> }, opts?: { signal?: AbortSignal }): Promise<void> | void;
}

const reply = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

export const WEBMCP_TOOLS = [
  {
    name: "aios_list_apps",
    description: "List the apps installed in this Web-AIOS desktop, with their ids.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => reply(APPS.map((a) => `${a.id}: ${a.name} - ${a.description}`).join("\n")),
  },
  {
    name: "aios_open_app",
    description: "Open one Web-AIOS app by id (see aios_list_apps).",
    inputSchema: { type: "object", properties: { appId: { type: "string" } }, required: ["appId"] },
    execute: async (a: Record<string, unknown>) => {
      const app = getApp(String(a.appId ?? ""));
      if (!app) return reply(`No app "${String(a.appId)}".`);
      bus.emit("app:open", { appId: app.id });
      return reply(`Opened ${app.name}.`);
    },
  },
  {
    name: "aios_list_files",
    description: "List files in a folder of the user's Web-AIOS file system.",
    inputSchema: { type: "object", properties: { dir: { type: "string", description: "Folder path, default /" } } },
    execute: async (a: Record<string, unknown>) => reply(useVFS.getState().list(String(a.dir || "/")).map((n) => `${n.kind === "dir" ? "[dir] " : ""}${n.path} (${n.size} B)`).join("\n") || "Empty."),
  },
  {
    name: "aios_read_file",
    description: "Read a text file from the user's Web-AIOS file system.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (a: Record<string, unknown>) => {
      const n = useVFS.getState().read(String(a.path ?? ""));
      return reply(n && n.kind === "file" ? n.content.slice(0, 20_000) : `No file at ${String(a.path)}.`);
    },
  },
  {
    name: "aios_desk_brief",
    description: "What needs the user's attention right now, computed from their tasks, jobs, files and focus (the Desk brief).",
    inputSchema: { type: "object", properties: {} },
    execute: async () => reply(briefText(currentBrief())),
  },
  {
    name: "aios_timeline",
    description: "Search what the user did on this device by time and words, e.g. 'yesterday', 'tuesday notes', 'last week loop'. Every entry has a time and a source.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: async (a: Record<string, unknown>) => {
      const r = queryTimeline(currentTimeline(), String(a.query ?? ""), Date.now(), new Date().getTimezoneOffset(), 40);
      return reply([`${r.hits.length} entries from ${r.query.label}:`, ...r.hits.map((e) => `${new Date(e.at).toISOString()} [${e.source}] ${e.text}`)].join("\n"));
    },
  },
];

let installed: AbortController | null = null;

export function installWebMcp(): () => void {
  const mc = (typeof document !== "undefined" ? (document as unknown as { modelContext?: ModelContext }).modelContext : undefined);
  if (!mc?.registerTool) {
    registerAiosModule("webmcp", { available: false, tools: [], why: "document.modelContext is not available in this browser (WebMCP is a Chrome origin trial)." });
    return () => {};
  }
  if (installed) return () => {};
  const ctrl = new AbortController();
  installed = ctrl;
  const ok: string[] = [];
  for (const t of WEBMCP_TOOLS) {
    try { void mc.registerTool(t, { signal: ctrl.signal }); ok.push(t.name); } catch { /* one refusal must not stop the rest */ }
  }
  registerAiosModule("webmcp", { available: true, tools: ok });
  return () => { ctrl.abort(); installed = null; };
}
