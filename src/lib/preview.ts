import type { ProjectFile } from "./scaffold";

/* ────────────────────────────────────────────────────────────────────────────
   Live preview for real, multi-file projects.

   A single HTML file previews itself. Everything else — React, TypeScript,
   three.js, a canvas game — normally needs `npm install && npm run dev` before
   you can see a single pixel, which makes "generate a project" feel like
   filing paperwork rather than building something.

   So this bundles in the browser. Inside a sandboxed iframe it:

     1. transpiles every source file with Babel (TypeScript + JSX),
     2. resolves each file's relative imports depth-first and turns each
        transpiled module into a blob URL, rewriting its import specifiers to
        point at the blob URLs of its dependencies,
     3. maps bare specifiers — react, three, zustand — through an import map
        to a CDN,
     4. imports the entry module.

   Depth-first matters: a blob URL's contents are fixed the moment it is
   created, so a module can only be built once every module it imports already
   has a URL. That is the whole reason this is a recursive linker and not a
   loop.

   The generated document is entirely self-contained — it is also exactly what
   gets stored when you install a project as an app, so an app you built runs
   from the desktop with no build step and no server.
   ──────────────────────────────────────────────────────────────────────────── */

export interface PreviewResult {
  /** A full HTML document for an iframe's srcDoc, when one can be made. */
  html?: string;
  /** Why not, when it cannot. Shown to the user verbatim. */
  reason?: string;
  /** What the preview is actually doing, so nobody mistakes it for the real thing. */
  note?: string;
}

/** Bare specifiers get pinned versions where a mismatch would actually break.
 *
 *  `?external=` is load-bearing on the React ones: without it esm.sh serves
 *  react-dom its own copy of React, two renderers fight over one tree, and you
 *  get "invalid hook call" on a project that is perfectly correct. */
const PINS: Record<string, string> = {
  react: "https://esm.sh/react@19.2.0",
  "react/jsx-runtime": "https://esm.sh/react@19.2.0/jsx-runtime",
  "react/jsx-dev-runtime": "https://esm.sh/react@19.2.0/jsx-dev-runtime",
  "react-dom": "https://esm.sh/react-dom@19.2.0?external=react",
  "react-dom/client": "https://esm.sh/react-dom@19.2.0/client?external=react",
  three: "https://esm.sh/three@0.180.0",
  "three/examples/jsm/controls/OrbitControls.js": "https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js",
  "three/addons/controls/OrbitControls.js": "https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js",
  "@react-three/fiber": "https://esm.sh/@react-three/fiber@9?external=react,react-dom,three",
  "@react-three/drei": "https://esm.sh/@react-three/drei@10?external=react,react-dom,three,@react-three/fiber",
  zustand: "https://esm.sh/zustand@5?external=react",
};

const SOURCE_RE = /\.(tsx?|jsx?|mjs)$/;
const ENTRY_CANDIDATES = [
  "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
  "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
  "client/src/main.tsx", "client/src/main.ts",
  "main.ts", "main.js", "index.ts", "index.js",
];

/** Bare specifiers imported anywhere in the project, for the import map. */
function bareSpecifiers(files: ProjectFile[]): string[] {
  const found = new Set<string>();
  const re = /(?:from|import)\s*\(?\s*["']([^."'][^"']*)["']/g;
  for (const f of files) {
    if (!SOURCE_RE.test(f.path)) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.content))) {
      const spec = m[1];
      // Node built-ins have no browser equivalent; skip rather than emit a
      // map entry that 404s and takes the whole preview down with it.
      if (spec.startsWith("node:")) continue;
      found.add(spec);
    }
  }
  return [...found];
}

function importMap(files: ProjectFile[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const spec of bareSpecifiers(files)) {
    map[spec] = PINS[spec] ?? `https://esm.sh/${spec}`;
  }
  // React's automatic JSX runtime is injected by Babel, so it is imported
  // without ever appearing in anyone's source.
  if (files.some((f) => /\.[jt]sx$/.test(f.path))) {
    map["react"] ??= PINS.react;
    map["react/jsx-runtime"] = PINS["react/jsx-runtime"];
    map["react/jsx-dev-runtime"] = PINS["react/jsx-dev-runtime"];
  }
  return map;
}

/** The `<body>` markup a project's own index.html declares, minus its module
 *  script — the loader takes over that job. */
function shellBody(files: ProjectFile[]): { body: string; entryHint: string | null } {
  const index = files.find((f) => f.path === "index.html" || f.path === "client/index.html");
  if (!index) return { body: '<div id="root"></div>', entryHint: null };
  const bodyMatch = index.content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : index.content;
  const script = body.match(/<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/i);
  const entryHint = script ? script[1].replace(/^\.?\//, "") : null;
  body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  return { body, entryHint };
}

const esc = (s: string) => s.replace(/<\/script>/gi, "<\\/script>");

export function buildPreview(files: ProjectFile[], targetId: string): PreviewResult {
  // One document that already is the app.
  const single = files.find((f) => f.path === "index.html");
  if (targetId === "single-html" && single) {
    return { html: single.content, note: "The document itself, running as-is." };
  }

  const NO_BROWSER: Record<string, string> = {
    "node-api": "An Express service runs on Node, not in a page. Export it and `npm install && npm run dev` — the README has the commands.",
    "python-api": "A FastAPI service needs a Python runtime. Export it and `uvicorn app.main:app --reload`.",
    cli: "A command-line program has no page to render. Export it and run `node bin/cli.js --help`.",
    godot: "Godot projects open in the Godot editor. Export the folder, open project.godot, and press F5 — or drive the editor live from the MCP tab.",
    unity: "Unity projects open in the Unity editor. Export it into your project's Assets/ folder — or drive the editor live from the MCP tab.",
    unreal: "Unreal projects open in the Unreal editor. Export it, right-click the .uproject to generate project files — or drive the editor live from the MCP tab.",
  };
  if (NO_BROWSER[targetId]) return { reason: NO_BROWSER[targetId] };

  const sources = files.filter((f) => SOURCE_RE.test(f.path) || f.path.endsWith(".css"));
  if (!sources.length) return { reason: "No source files to run yet." };

  const { body, entryHint } = shellBody(files);

  // Next.js has no client entry to point at — it mounts app/page.tsx for you.
  // Synthesising one is what makes a generated Next app previewable at all.
  let entry = entryHint && files.some((f) => f.path === entryHint) ? entryHint : null;
  let synthetic: ProjectFile | null = null;
  if (!entry) entry = ENTRY_CANDIDATES.find((c) => files.some((f) => f.path === c)) ?? null;
  if (!entry) {
    const page = files.find((f) => /^(app|src\/app)\/page\.tsx$/.test(f.path));
    if (page) {
      synthetic = {
        path: "__preview_entry.tsx",
        content: `import { createRoot } from "react-dom/client";\nimport Page from "./${page.path}";\ncreateRoot(document.getElementById("root")!).render(<Page />);\n`,
      };
      entry = synthetic.path;
    }
  }
  if (!entry) {
    const only = sources.find((f) => SOURCE_RE.test(f.path));
    entry = only?.path ?? null;
  }
  if (!entry) return { reason: "Could not work out which file starts this project." };

  const all = synthetic ? [...files, synthetic] : files;
  const fileMap: Record<string, string> = {};
  for (const f of all) if (SOURCE_RE.test(f.path) || f.path.endsWith(".css")) fileMap[f.path] = f.content;

  const map = importMap(all);
  const globalCss = all.filter((f) => f.path.endsWith(".css") && !usedByImport(all, f.path)).map((f) => f.content).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script type="importmap">${JSON.stringify({ imports: map })}</script>
<style>
  html,body{margin:0;min-height:100%}
  #__err{position:fixed;inset:auto 0 0 0;max-height:52vh;overflow:auto;background:#1b0d12;color:#ffb4b4;
    font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;padding:12px 14px;white-space:pre-wrap;
    border-top:2px solid #ff5d5d;display:none;z-index:2147483647}
  #__err b{color:#fff}
</style>
<style id="__projectcss">${globalCss}</style>
</head>
<body>
${body}
<pre id="__err"></pre>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.28.4/babel.min.js"></script>
<script>window.__FILES = ${esc(JSON.stringify(fileMap))}; window.__ENTRY = ${JSON.stringify(entry)};</script>
<script>
${LOADER}
</script>
</body>
</html>`;

  return {
    html,
    note: "Transpiled and linked in your browser. Dependencies come from esm.sh, so this needs a connection — the exported project does not.",
  };
}

/** A CSS file that some module imports is injected by the loader when that
 *  module loads; one nobody imports is a global stylesheet and goes in `<head>`. */
function usedByImport(files: ProjectFile[], cssPath: string): boolean {
  const leaf = cssPath.split("/").pop()!;
  return files.some((f) => SOURCE_RE.test(f.path) && new RegExp(`["'][^"']*${leaf.replace(/\./g, "\\.")}["']`).test(f.content));
}

/* The in-page linker. Kept as a string so it ships inside the generated
   document rather than being part of this app's bundle. */
const LOADER = String.raw`
(function () {
  var FILES = window.__FILES, ENTRY = window.__ENTRY;
  var cache = new Map(), building = new Set(), urls = [];

  function fail(title, e) {
    var box = document.getElementById("__err");
    box.style.display = "block";
    box.innerHTML = "<b>" + title + "</b>\n" + String((e && e.stack) || e);
    try { parent.postMessage({ __preview: "error", message: String((e && e.message) || e) }, "*"); } catch (_) {}
  }

  // Resolve a relative specifier against the importing file, trying the
  // extensions a bundler would — which is why source can say "./App" at all.
  function resolve(spec, from) {
    var base = from.split("/").slice(0, -1);
    spec.split("/").forEach(function (p) {
      if (p === "." || p === "") return;
      if (p === "..") base.pop(); else base.push(p);
    });
    var path = base.join("/");
    var cands = [path, path + ".tsx", path + ".ts", path + ".jsx", path + ".js",
                 path + "/index.tsx", path + "/index.ts", path + "/index.jsx", path + "/index.js"];
    for (var i = 0; i < cands.length; i++) if (Object.prototype.hasOwnProperty.call(FILES, cands[i])) return cands[i];
    return null;
  }

  function transpile(src, path) {
    var isTs = /\.tsx?$/.test(path), isX = /x$/.test(path);
    var presets = [];
    if (isTs) presets.push(["typescript", { allExtensions: true, isTSX: isX, onlyRemoveTypeImports: true }]);
    presets.push(["react", { runtime: "automatic" }]);
    return Babel.transform(src, { presets: presets, filename: path, sourceType: "module", compact: false }).code;
  }

  function link(path) {
    if (cache.has(path)) return Promise.resolve(cache.get(path));

    // A cycle would otherwise recurse forever. Import cycles are legal in ESM
    // but cannot be expressed with blob URLs, so say so plainly instead of
    // hanging the tab.
    if (building.has(path)) return Promise.reject(new Error("Import cycle through " + path + " — blob-linked previews cannot express one. Break the cycle and it will run."));
    building.add(path);

    if (path.slice(-4) === ".css") {
      var st = document.createElement("style");
      st.textContent = FILES[path];
      document.head.appendChild(st);
      var stub = URL.createObjectURL(new Blob(["export default {};"], { type: "text/javascript" }));
      cache.set(path, stub); building.delete(path); urls.push(stub);
      return Promise.resolve(stub);
    }

    var code;
    try { code = transpile(FILES[path], path); }
    catch (e) { building.delete(path); return Promise.reject(new Error(path + ": " + e.message)); }

    // Every relative specifier this module mentions, resolved to a real file.
    var specRe = /(from\s*|import\s*|import\(\s*|export\s+\*\s+from\s*)(["'])(\.[^"']*)\2/g;
    var deps = [], m;
    while ((m = specRe.exec(code))) {
      var target = resolve(m[3], path);
      if (target && deps.indexOf(target) === -1) deps.push(target);
    }

    return deps.reduce(function (p, d) {
      return p.then(function () { return link(d); });
    }, Promise.resolve()).then(function () {
      var out = code.replace(specRe, function (whole, lead, q, spec) {
        var target = resolve(spec, path);
        var url = target && cache.get(target);
        return url ? lead + q + url + q : whole;
      });
      var url = URL.createObjectURL(new Blob([out], { type: "text/javascript" }));
      cache.set(path, url); building.delete(path); urls.push(url);
      return url;
    });
  }

  window.addEventListener("error", function (e) { fail("Runtime error", e.error || e.message); });
  window.addEventListener("unhandledrejection", function (e) { fail("Unhandled rejection", e.reason); });

  function boot() {
    link(ENTRY)
      .then(function (url) { return import(url); })
      .then(function () { try { parent.postMessage({ __preview: "ready" }, "*"); } catch (_) {} })
      .catch(function (e) { fail("Could not start the project", e); });
  }

  if (window.Babel) boot();
  else {
    var waited = 0;
    var t = setInterval(function () {
      if (window.Babel) { clearInterval(t); boot(); }
      else if ((waited += 60) > 12000) { clearInterval(t); fail("Compiler did not load", new Error("The in-browser transpiler could not be fetched. Preview needs a network connection; the exported project does not.")); }
    }, 60);
  }
})();
`;
