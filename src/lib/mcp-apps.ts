/* MCP Apps, host side: the pure half.

   Per the MCP Apps extension (modelcontextprotocol/ext-apps, spec 2026-01-26):
   a tool links a UI resource through _meta.ui.resourceUri; the resource is a
   ui:// URI with mimeType "text/html;profile=mcp-app"; the host renders it in a
   sandboxed iframe under a CSP and speaks JSON-RPC 2.0 over postMessage
   (ui/initialize, ui/notifications/initialized, ui/notifications/tool-input,
   ui/notifications/tool-result, tools/call, ui/message, ui/open-link,
   ui/notifications/size-changed).

   This module decides what the host does with each message from a view.
   Checking WHERE a message came from (event.source) is the caller's job. */

export interface AppTool {
  name: string;
  _meta?: { ui?: { resourceUri?: string; visibility?: string[] } };
}

export const APP_MIME = "text/html;profile=mcp-app";

export function uiResourceUri(tool: AppTool): string | null {
  const uri = tool._meta?.ui?.resourceUri;
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : null;
}

export function isAppResource(mime: string | undefined): boolean {
  return !!mime && mime.replace(/\s+/g, "").toLowerCase() === APP_MIME;
}

/** The spec's default CSP when a resource declares none. */
export const DEFAULT_APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'";

/** The document the iframe is given: the server's HTML with a CSP meta tag
 *  placed first, so no script in it can run before the policy applies. */
export function appSrcDoc(html: string, csp = DEFAULT_APP_CSP): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (h) => `${h}${meta}`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

export type HostAction =
  | { kind: "respond"; message: Record<string, unknown> }
  | { kind: "call-tool"; id: string | number; name: string; args: Record<string, unknown> }
  | { kind: "message"; text: string }
  | { kind: "open-link"; url: string }
  | { kind: "resize"; height: number }
  | { kind: "initialized" }
  | { kind: "ignore"; reason: string };

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const error = (id: unknown, code: number, message: string) => ({ kind: "respond" as const, message: { jsonrpc: "2.0", id, error: { code, message } } });

export interface HostContext {
  hostInfo: { name: string; version: string };
  theme: "light" | "dark";
  /** Tools of the SAME server the view may call. Anything else is refused. */
  allowedTools: string[];
}

export function routeViewMessage(raw: unknown, ctx: HostContext): HostAction {
  if (!isRec(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string") return { kind: "ignore", reason: "not a JSON-RPC 2.0 message" };
  const { id, method } = raw;
  const params = isRec(raw.params) ? raw.params : {};
  const isRequest = typeof id === "string" || typeof id === "number";
  switch (method) {
    case "ui/initialize":
      if (!isRequest) return { kind: "ignore", reason: "ui/initialize must be a request" };
      return { kind: "respond", message: { jsonrpc: "2.0", id, result: { protocolVersion: "2026-01-26", hostInfo: ctx.hostInfo, hostCapabilities: { tools: {}, openLinks: {}, message: {} }, hostContext: { theme: ctx.theme } } } };
    case "ui/notifications/initialized":
      return { kind: "initialized" };
    case "tools/call": {
      if (!isRequest) return { kind: "ignore", reason: "tools/call must be a request" };
      const name = typeof params.name === "string" ? params.name : "";
      if (!ctx.allowedTools.includes(name)) return error(id, -32602, `Tool "${name}" is not available to this app.`);
      return { kind: "call-tool", id, name, args: isRec(params.arguments) ? params.arguments : {} };
    }
    case "ui/message": {
      const text = typeof params.text === "string" ? params.text : isRec(params.content) && typeof params.content.text === "string" ? params.content.text : "";
      if (!text.trim()) return isRequest ? error(id, -32602, "ui/message needs text") : { kind: "ignore", reason: "empty ui/message" };
      return { kind: "message", text: text.slice(0, 4000) };
    }
    case "ui/open-link": {
      const url = typeof params.url === "string" ? params.url : "";
      if (!/^https?:\/\//i.test(url)) return isRequest ? error(id, -32602, "only http(s) links can be opened") : { kind: "ignore", reason: "non-http link" };
      return { kind: "open-link", url };
    }
    case "ui/notifications/size-changed": {
      const h = Number(params.height);
      return Number.isFinite(h) && h > 0 ? { kind: "resize", height: Math.min(1200, Math.round(h)) } : { kind: "ignore", reason: "bad height" };
    }
    default:
      return isRequest ? error(id, -32601, `Method not found: ${method}`) : { kind: "ignore", reason: `unknown notification ${method}` };
  }
}

export const toolInputNotification = (args: Record<string, unknown>) => ({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: args } });
export const toolResultNotification = (result: unknown) => ({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
