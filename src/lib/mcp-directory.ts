/* ────────────────────────────────────────────────────────────────────────────
   A directory of MCP servers worth connecting to.

   `lib/mcp.ts` shipped with four localhost editor endpoints seeded into the
   store, which is a reasonable default and a poor directory: you can only
   connect to a server whose URL you already knew. This is the catalogue —
   what each one is, where it runs, and, crucially, whether it can work at all
   from a browser.

   That last column is the one that saves time. An MCP server on your own
   machine is reached DIRECTLY from the page, because "localhost" there means
   your machine; the same URL sent through the server relay means the
   deployment's own loopback, which is both useless and an SSRF hole, and
   `/api/mcp` refuses it by design. A public server is the other way round:
   almost none of them set CORS headers for a browser origin, so it has to go
   through the relay. Getting this backwards produces a network error with no
   explanation, which is the single most common way a hand-written MCP client
   appears to be broken.

   PURE — a data module. Nothing here connects to anything.
   ──────────────────────────────────────────────────────────────────────────── */

export type McpHost = "local" | "public" | "self";

export interface McpDirectoryEntry {
  id: string;
  name: string;
  /** One sentence: what connecting to it gets you. */
  description: string;
  url: string;
  host: McpHost;
  /** What you must do before it will answer. "" means nothing. */
  requires: string;
  docs: string;
  /** Whether the request must be relayed through /api/mcp. Derived, but
   *  stated explicitly so a wrong value is visible in a test rather than as a
   *  silent network error. */
  viaRelay: boolean;
  /** Needs a token the user pastes in. */
  needsToken: boolean;
}

export const MCP_DIRECTORY: McpDirectoryEntry[] = [
  {
    id: "self",
    name: "Web-AIOS (this deployment)",
    description:
      "This OS's own deterministic analysis tools plus every free data service, served over MCP. " +
      "Connecting to it proves the client and the server in this repo agree.",
    url: "/api/harness/mcp",
    host: "self",
    requires: "",
    docs: "https://modelcontextprotocol.io/specification/2025-06-18",
    // Same origin. Neither a relay nor CORS is involved.
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "godot",
    name: "Godot",
    description: "Drive a running Godot editor: inspect the scene tree, create nodes, run the project.",
    url: "http://localhost:8080/mcp",
    host: "local",
    requires: "The Godot MCP addon, enabled, with the editor open.",
    docs: "https://github.com/modelcontextprotocol/servers",
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "unity",
    name: "Unity",
    description: "Drive a running Unity editor: read the hierarchy, create GameObjects, enter play mode.",
    url: "http://localhost:8090/mcp",
    host: "local",
    requires: "A Unity MCP bridge package installed in the project.",
    docs: "https://github.com/modelcontextprotocol/servers",
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "unreal",
    name: "Unreal",
    description: "Drive a running Unreal editor: inspect actors, spawn blueprints, trigger builds.",
    url: "http://localhost:8099/mcp",
    host: "local",
    requires: "An Unreal MCP plugin, enabled in the project.",
    docs: "https://github.com/modelcontextprotocol/servers",
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "blender",
    name: "Blender",
    description: "Drive a running Blender: read the scene, add meshes, render a frame.",
    url: "http://localhost:8765/mcp",
    host: "local",
    requires: "The Blender MCP addon, enabled.",
    docs: "https://github.com/ahujasid/blender-mcp",
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read and write files in directories you explicitly hand it when you start it.",
    url: "http://localhost:3000/mcp",
    host: "local",
    requires: "npx -y @modelcontextprotocol/server-filesystem <dir> --transport http --port 3000",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "git",
    name: "Git",
    description: "Read a local repository: log, diff, blame, branches and file history.",
    url: "http://localhost:3001/mcp",
    host: "local",
    requires: "An MCP git server bound to port 3001 over HTTP.",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "memory",
    name: "Memory",
    description: "A persistent knowledge graph an agent can write to and read back across sessions.",
    url: "http://localhost:3002/mcp",
    host: "local",
    requires: "npx -y @modelcontextprotocol/server-memory bound to port 3002 over HTTP.",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    viaRelay: false,
    needsToken: false,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issues, pull requests, code search and file contents across the repositories your token can see.",
    url: "https://api.githubcopilot.com/mcp/",
    host: "public",
    requires: "A GitHub personal access token pasted below. It stays in this browser.",
    docs: "https://github.com/github/github-mcp-server",
    // Public servers are written for agents, not pages, and set no CORS
    // headers — the request never leaves the browser without the relay.
    viaRelay: true,
    needsToken: true,
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Ask questions about any public GitHub repository and get answers grounded in its code.",
    url: "https://mcp.deepwiki.com/mcp",
    host: "public",
    requires: "",
    docs: "https://deepwiki.com",
    viaRelay: true,
    needsToken: false,
  },
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date documentation and code examples for thousands of libraries, by name and version.",
    url: "https://mcp.context7.com/mcp",
    host: "public",
    requires: "",
    docs: "https://context7.com",
    viaRelay: true,
    needsToken: false,
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    description: "Search models, datasets and Spaces, and read their cards.",
    url: "https://huggingface.co/mcp",
    host: "public",
    requires: "",
    docs: "https://huggingface.co/settings/mcp",
    viaRelay: true,
    needsToken: false,
  },
];

/**
 * The one rule that decides routing, in one place.
 *
 * A localhost server MUST leave from the browser: over there "localhost" is
 * the user's own machine, and a serverless function's loopback is a different
 * machine entirely — one `/api/mcp` refuses to fetch, correctly, because a
 * relay that will reach its own private network is an SSRF hole.
 *
 * A same-origin path needs no relay either; it IS this origin.
 *
 * Everything else is a public server that almost certainly sets no CORS header
 * for a browser origin, so it must be relayed.
 */
export function shouldRelay(url: string): boolean {
  const raw = url.trim();
  if (raw.startsWith("/")) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local") || host.endsWith(".localhost")) {
    return false;
  }
  return true;
}

/** Everything the directory declares, checked against the rule. A `viaRelay`
 *  that disagrees with `shouldRelay` is a wrong entry, and it fails as an
 *  unexplained network error rather than as anything readable — so a test
 *  pins the agreement instead. */
export function directoryDisagreements(): Array<{ id: string; declared: boolean; derived: boolean }> {
  return MCP_DIRECTORY
    .map((e) => ({ id: e.id, declared: e.viaRelay, derived: shouldRelay(e.url) }))
    .filter((x) => x.declared !== x.derived);
}

export function entryById(id: string): McpDirectoryEntry | undefined {
  return MCP_DIRECTORY.find((e) => e.id === id);
}

export const MCP_HOSTS: McpHost[] = ["self", "local", "public"];

export const HOST_LABEL: Record<McpHost, string> = {
  self: "This deployment",
  local: "On your machine",
  public: "Public",
};
