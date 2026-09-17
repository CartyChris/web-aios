"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import { useUserApps, type UserApp } from "@/kernel/userapps";
import { UPGRADE_INTENTS, diffVersions } from "@/lib/appversions";
import { upgradeApp } from "@/lib/app-upgrade";
import { ask } from "@/lib/useAI";
import { extractCode } from "./IDE";
import type { AppProps } from "@/kernel/types";
import { download, relTime, uid } from "@/lib/format";
import { Tabs, ErrorNote, Empty, Spinner, CopyButton } from "./_ui";
import { TARGETS, TARGET_GROUPS, getTarget, FILE_FORMAT, parseProjectFiles, mergeProject, type ProjectFile } from "@/lib/scaffold";
import { buildPreview } from "@/lib/preview";
import { downloadZip, rawSize } from "@/lib/zip";
import { MEDIA_MODELS, generateMedia, awaitMedia, getMediaModel } from "@/lib/media";
import { useMcp, connect as mcpConnect, callTool, toolCatalogue, type McpServer } from "@/lib/mcp";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   AI Studio.

   This replaces HTML Studio, which could make exactly one thing: a single
   self-contained HTML document. That was a fine way to make something in five
   minutes and a poor way to make anything you intended to keep.

   Everything you can build here is built by a model and previewed live:

     Build   fifteen targets — a page, a React app, a full-stack product, a
             three.js scene, an installable PWA, a Godot/Unity/Unreal project.
             Multi-file projects are transpiled and linked in the browser
             (lib/preview.ts), so you see them run without a build step.
     Image   image models, with the result droppable into the filesystem or
             straight onto the desktop as a wallpaper.
     Video   video models, which are long-running jobs, polled with progress.
     MCP     tools on a running editor. This is how a prompt reaches Godot or
             Unity: they are programs, not APIs, and MCP is the protocol that
             lets a model drive one.
     Library everything you have built. Run it, edit it, export it as a real
             project, or pin it to the desktop as an app.
   ──────────────────────────────────────────────────────────────────────────── */

const SINGLE_HTML_BRIEF = `You are Web-AIOS AI Studio. You produce complete, self-contained single-file HTML applications.

Hard requirements:
- ONE HTML document, fully self-contained. No build step, no external scripts, no CDN.
- Inline all CSS and JS. Works when opened straight from a file.
- Responsive: genuinely usable at 380px wide and at 1400px.
- Read --bg, --text and --accent from the parent where sensible, with your own fallbacks, so it matches the host theme.
- Keyboard accessible. Touch targets at least 44px.
- No network calls unless the app is explicitly about the network.
- Output ONLY the HTML document inside one fenced code block.`;

const PASSES: Record<string, { label: string; icon: string; prompt: string }> = {
  polish: { label: "Polish", icon: "brush", prompt: "You are a frontend graphics specialist. Raise the visual quality: typography, spacing, colour, depth, motion, empty states. Keep every behaviour working." },
  features: { label: "Add features", icon: "plus", prompt: "You are a product engineer. Add the features this is obviously missing — persistence, settings, keyboard support, progression, undo. Preserve every existing control." },
  bugfix: { label: "Fix bugs", icon: "check", prompt: "You are a debugging engineer. Find and fix runtime errors, race conditions and edge cases without changing features." },
  mobile: { label: "Make it mobile", icon: "home", prompt: "Make this work properly on a phone: touch targets at least 44px, no horizontal scroll at 380px, safe-area padding, no hover-only interactions. Keep desktop behaviour intact." },
  perf: { label: "Make it fast", icon: "spark", prompt: "You are a performance engineer. Remove layout thrash, unnecessary re-renders and O(n²) work. Do not change behaviour or visual design." },
  a11y: { label: "Accessibility", icon: "eye", prompt: "You are an accessibility engineer. Add semantic elements, labels, focus management, roles and visible focus rings. Keep the design." },
};

const IDEAS = [
  "a tide-clock that shows my day as a rising and falling line",
  "a 3D solar system I can fly through with the mouse",
  "a habit tracker where each day is a hexagon in a honeycomb",
  "a synth that plays whatever I type as a melody",
  "a full-stack link shortener with an admin page",
  "an isometric tower-defence game with three tower types",
  "a markdown editor with live preview and word-count goals",
  "a pixel-art editor that exports a sprite sheet",
];

type Tab = "build" | "image" | "video" | "mcp" | "library";

export default function AIStudio({ args }: AppProps) {
  const [tab, setTab] = useState<Tab>((args?.tab as Tab) ?? "build");
  const apps = useUserApps((s) => s.apps);
  const [running, setRunning] = useState<UserApp | null>(null);

  // Launching from a desktop icon runs that app straight away.
  const runArg = args?.runUserApp as string | undefined;
  const [ranArg, setRanArg] = useState<string | undefined>(undefined);
  if (runArg && runArg !== ranArg) {
    setRanArg(runArg);
    const target = apps.find((a) => a.id === runArg);
    if (target) { setRunning(target); setTab("library"); }
  }

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "build", label: "Build", icon: "aistudio" },
          { id: "image", label: "Image", icon: "image" },
          { id: "video", label: "Video", icon: "video" },
          { id: "mcp", label: "Engines & MCP", icon: "mcp" },
          { id: "library", label: `Library (${apps.length})`, icon: "app" },
        ]}
        active={tab}
        onChange={(t) => setTab(t as Tab)}
      />
      {tab === "build" && <BuildTab />}
      {tab === "image" && <MediaTab kind="image" />}
      {tab === "video" && <MediaTab kind="video" />}
      {tab === "mcp" && <McpTab />}
      {tab === "library" && <LibraryTab running={running} setRunning={setRunning} onBuild={() => setTab("build")} />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   BUILD
   ══════════════════════════════════════════════════════════════════════════ */

function BuildTab() {
  const vfs = useVFS();
  const userApps = useUserApps();
  const [group, setGroup] = useState<(typeof TARGET_GROUPS)[number]["id"]>("web");
  const [targetId, setTargetId] = useState("single-html");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stream, setStream] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "code">("preview");
  const [previewKey, setPreviewKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const target = getTarget(targetId);

  // The preview is derived, never stored: editing a file re-links the project
  // on the next render, which is what makes the editor feel live.
  const preview = useMemo(() => (files ? buildPreview(files, targetId) : null), [files, targetId]);

  // The preview iframe reports its own failures back up, so a project that
  // compiles but throws on line one says so instead of showing a blank page.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __preview?: string; message?: string };
      if (d?.__preview === "error") setRuntimeError(d.message ?? "Unknown error");
      if (d?.__preview === "ready") setRuntimeError(null);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const name = useMemo(
    () => (prompt.split(/[.\n]/)[0] || "project").replace(/[^\w -]/g, "").trim().slice(0, 40) || "project",
    [prompt],
  );

  const generate = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy("Building"); setError(null); setStream(""); setRuntimeError(null);
    try {
      if (target.id === "single-html") {
        const res = await ask({
          messages: [{ role: "user", content: prompt }],
          system: SINGLE_HTML_BRIEF,
          maxTokens: 16000,
          onDelta: (_d, full) => setStream(full),
        });
        const code = extractCode(res.text);
        if (!code) throw new Error("No HTML document came back. Try again, or pick a stronger model in Settings.");
        setFiles([{ path: "index.html", content: code }, ...target.base(name)]);
        setOpenFile("index.html");
      } else {
        const base = target.base(name);
        const res = await ask({
          messages: [{ role: "user", content: `Build: ${prompt}` }],
          system: `${target.brief}\n\n${FILE_FORMAT}\n\nThese files already exist and are correct — do NOT rewrite them: ${base.map((f) => f.path).join(", ")}.\nAt minimum write: ${target.expects.join(", ")}.`,
          maxTokens: 24000,
          onDelta: (_d, full) => setStream(full),
        });
        const written = parseProjectFiles(res.text);
        if (!written.length) throw new Error("No files came back in the expected format. Try again, or pick a stronger model in Settings.");
        const merged = mergeProject(base, written);
        setFiles(merged);
        setOpenFile(written[0]?.path ?? merged[0]?.path ?? null);
      }
      setStream("");
      setPreviewKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Build failed.");
    } finally { setBusy(null); }
  }, [prompt, busy, target, name]);

  /** A refinement pass. Multi-file projects send the whole tree and get the
   *  whole tree back — a patch format would be cheaper and is exactly where
   *  models produce half-applied edits. */
  const pass = useCallback(async (kind: string, custom?: string) => {
    if (!files || busy) return;
    setBusy(kind); setError(null); setStream("");
    try {
      const instruction = custom ?? PASSES[kind].prompt;
      if (targetId === "single-html") {
        const html = files.find((f) => f.path === "index.html")?.content ?? "";
        const res = await ask({
          messages: [{ role: "user", content: html }],
          system: `${instruction}\n\nOutput only the complete updated HTML document in one fenced code block.`,
          maxTokens: 16000,
          onDelta: (_d, full) => setStream(full),
        });
        const code = extractCode(res.text);
        if (!code) throw new Error("No HTML came back from that pass.");
        setFiles(files.map((f) => (f.path === "index.html" ? { ...f, content: code } : f)));
      } else {
        const source = files
          .filter((f) => !/^(README\.md|\.gitignore|package-lock\.json)$/.test(f.path))
          .map((f) => `=== ${f.path} ===\n${f.content}`)
          .join("\n");
        const res = await ask({
          messages: [{ role: "user", content: source }],
          system: `${instruction}\n\n${FILE_FORMAT}\n\nReturn ONLY the files you actually changed. Write each one in full.`,
          maxTokens: 24000,
          onDelta: (_d, full) => setStream(full),
        });
        const changed = parseProjectFiles(res.text);
        if (!changed.length) throw new Error("That pass returned no files.");
        setFiles(mergeProject(files, changed));
      }
      setStream("");
      setPreviewKey((k) => k + 1);
      setRuntimeError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pass failed.");
    } finally { setBusy(null); }
  }, [files, busy, targetId]);

  /** Hand the preview's own runtime error back to the model. This is the pass
   *  that matters most: the failure text is far better evidence than "fix bugs". */
  const repair = useCallback(() => {
    if (!runtimeError) return;
    pass("bugfix", `The project throws this error when it runs:\n\n${runtimeError}\n\nFind the cause and fix it. Change nothing else.`);
  }, [runtimeError, pass]);

  const install = useCallback(() => {
    if (!files) return;
    const built = buildPreview(files, targetId);
    if (!built.html) {
      bus.emit("notify", { title: "This target has no browser runtime", body: built.reason, kind: "warn" });
      return;
    }
    const id = targetId === "single-html"
      ? userApps.install(name, built.html, "app", { prompt, target: targetId, files })
      : userApps.installProject(name, files, built.html, targetId, target.icon, prompt);
    useSettings.getState().addDesktopItem({ kind: "userapp", ref: id, x: 140, y: 70 });
    bus.emit("notify", { title: `Installed "${name}"`, body: "It is in your Library and pinned to the desktop.", kind: "success" });
  }, [files, targetId, name, userApps, prompt, target.icon]);

  const saveToFiles = useCallback(() => {
    if (!files) return;
    const root = `/projects/${name.replace(/\s+/g, "-")}`;
    for (const f of files) vfs.write(`${root}/${f.path}`, f.content, { appId: "studio" });
    bus.emit("notify", { title: `Saved ${files.length} files to ${root}`, kind: "success" });
  }, [files, name, vfs]);

  const totalKb = files ? rawSize(files) / 1024 : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Target picker ── */}
      <div className="shrink-0 border-b border-[var(--border)] px-2.5 py-2">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        {/* Two steps instead of one wall: what kind of thing, then which one.
            Fifteen targets shown at once is a specification, not a choice. */}
        <div className="mb-1.5 flex gap-1 overflow-x-auto">
          {TARGET_GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                setGroup(g.id);
                const first = TARGETS.find((t) => t.group === g.id);
                if (first) { setTargetId(first.id); setFiles(null); setRuntimeError(null); }
              }}
              title={g.hint}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-[11.5px] transition",
                group === g.id ? "bg-[var(--accent)]/20 text-[var(--text)] ring-1 ring-[var(--accent)]" : "text-[var(--muted)] hover:bg-white/6",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="mb-1.5 flex flex-wrap gap-1">
          {TARGETS.filter((t) => t.group === group).map((t) => (
            <button
              key={t.id}
              onClick={() => { setTargetId(t.id); setFiles(null); setRuntimeError(null); }}
              title={t.blurb}
              className={cn("os-btn !py-1 text-[11px]", targetId === t.id && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
            >
              <Icon name={t.icon} size={11} className="mr-1" />{t.name}
            </button>
          ))}
        </div>
        <div className="mb-1.5 text-[10.5px] text-[var(--muted)]">{target.blurb}</div>

        <div className="flex gap-1.5">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generate()}
            placeholder={`Describe the ${target.group === "engine" ? "game systems" : target.group === "service" ? "service" : "app"} to build…`}
            className="os-input min-w-0 flex-1 !py-1 text-[12px]"
          />
          <button className="os-btn shrink-0 !py-1 text-[11px]" data-variant="primary" onClick={generate} disabled={!!busy || !prompt.trim()}>
            <Icon name="wand" size={11} className="mr-1" />{busy === "Building" ? "Building…" : "Build"}
          </button>
        </div>

        {!files && !busy && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-[var(--muted)]">Try:</span>
            {IDEAS.slice(0, 4).map((i) => (
              <button key={i} className="os-chip hover:!border-[var(--accent)]" onClick={() => setPrompt(i)}>{i}</button>
            ))}
            <button className="os-chip" title="Another four" onClick={() => setPrompt(IDEAS[Math.floor(Math.random() * IDEAS.length)])}>
              <Icon name="refresh" size={10} />
            </button>
          </div>
        )}

        {files && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {Object.entries(PASSES).map(([k, v]) => (
              <button key={k} className="os-btn !py-1 text-[11px]" onClick={() => pass(k)} disabled={!!busy} title={v.prompt}>
                <Icon name={v.icon} size={11} className="mr-1" />{busy === k ? "…" : v.label}
              </button>
            ))}
            <button
              className="os-btn !py-1 text-[11px]"
              disabled={!!busy}
              onClick={() => { const c = window.prompt("What should change?"); if (c) pass("custom", `Apply this change: ${c}`); }}
            >
              Custom…
            </button>
            <div className="flex-1" />
            {busy && <Spinner label={`${stream.length.toLocaleString()} chars`} />}
            <span className="os-chip">{files.length} files · {totalKb.toFixed(1)} KB</span>
          </div>
        )}
      </div>

      {/* ── Runtime error from the preview ── */}
      {runtimeError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-[11.5px]">
          <Icon name="warning" size={12} />
          <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)]">{runtimeError}</span>
          <button className="os-btn !py-0.5 text-[10.5px]" data-variant="primary" onClick={repair} disabled={!!busy}>Fix it</button>
        </div>
      )}

      {/* ── Editor + preview ── */}
      {!files ? (
        <Empty
          icon="aistudio"
          title={busy ? "Building…" : "Nothing built yet"}
          body={
            busy
              ? `${stream.length.toLocaleString()} characters so far.`
              : "Pick what you are making, describe it, and build. Anything with a browser runtime previews live — React and TypeScript are transpiled and linked right here, so you see it run without npm install."
          }
        />
      ) : (
        <div className="app-split flex min-h-0 flex-1">
          {/* files */}
          <div className="app-sidebar w-48 shrink-0 overflow-y-auto border-r border-[var(--border)] p-1.5">
            <div className="os-label mb-1 px-1">Project</div>
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => { setOpenFile(f.path); setView("code"); }}
                className={cn("mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-[11px]", openFile === f.path ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
                title={f.path}
              >
                {f.path}
              </button>
            ))}
            <div className="mt-2 space-y-1 border-t border-[var(--border)] pt-2">
              <button className="os-btn w-full !py-1 text-[11px]" onClick={saveToFiles}>Save to Files</button>
              <button className="os-btn w-full !py-1 text-[11px]" onClick={() => downloadZip(name, files)}>
                <Icon name="package" size={11} className="mr-1" />Export .zip
              </button>
              <button className="os-btn w-full !py-1 text-[11px]" data-variant="primary" onClick={install}>
                <Icon name="pin" size={11} className="mr-1" />Install as app
              </button>
            </div>
          </div>

          {/* main pane */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] px-2 py-1">
              <button onClick={() => setView("preview")} className={cn("os-btn !py-0.5 text-[11px]", view === "preview" && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                <Icon name="live" size={11} className="mr-1" />Preview
              </button>
              <button onClick={() => setView("code")} className={cn("os-btn !py-0.5 text-[11px]", view === "code" && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                <Icon name="ide" size={11} className="mr-1" />Code
              </button>
              <div className="flex-1" />
              {view === "preview" && preview?.html && (
                <button className="os-btn !py-0.5 text-[11px]" onClick={() => setPreviewKey((k) => k + 1)} title="Re-run the preview">
                  <Icon name="refresh" size={11} />
                </button>
              )}
              {view === "code" && openFile && <CopyButton text={files.find((f) => f.path === openFile)?.content ?? ""} />}
              {view === "code" && openFile && (
                <button className="os-btn !py-0.5 text-[11px]" onClick={() => download(openFile.split("/").pop()!, files.find((f) => f.path === openFile)?.content ?? "", "text/plain")}>
                  Save file
                </button>
              )}
            </div>

            {view === "code" ? (
              <textarea
                value={busy ? stream : files.find((f) => f.path === openFile)?.content ?? ""}
                onChange={(e) => setFiles(files.map((f) => (f.path === openFile ? { ...f, content: e.target.value } : f)))}
                readOnly={!!busy}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-transparent p-2.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] outline-none"
              />
            ) : preview?.html ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <iframe
                  key={previewKey}
                  srcDoc={preview.html}
                  sandbox="allow-scripts allow-forms allow-modals allow-popups"
                  className="min-h-0 flex-1 border-0 bg-white"
                  title="Live preview"
                />
                {preview.note && <div className="shrink-0 border-t border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--muted)]">{preview.note}</div>}
              </div>
            ) : (
              <NoPreview reason={preview?.reason ?? "No preview."} target={targetId} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NoPreview({ reason, target }: { reason: string; target: string }) {
  const t = getTarget(target);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-lg">
        <div className="mb-2 flex items-center gap-2">
          <Icon name={t.icon} size={18} style={{ color: "var(--accent)" }} />
          <span className="text-[14px] font-medium">{t.name}</span>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--muted)]">{reason}</p>
        <div className="os-card mb-3">
          <div className="os-label mb-1">Run it</div>
          <pre className="whitespace-pre-wrap font-[family-name:var(--font-mono)] text-[11px]">{t.run}</pre>
        </div>
        <p className="text-[11.5px] leading-relaxed text-[var(--muted)]">
          This is real source, not a sketch — it carries no Web-AIOS dependency. Export it and it opens in any editor.
        </p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   IMAGE / VIDEO
   ══════════════════════════════════════════════════════════════════════════ */

interface MediaItem { id: string; url: string; prompt: string; model: string; kind: "image" | "video"; at: number }

function MediaTab({ kind }: { kind: "image" | "video" }) {
  const vfs = useVFS();
  const settings = useSettings();
  const models = useMemo(() => MEDIA_MODELS.filter((m) => m.kind === kind), [kind]);
  const [modelId, setModelId] = useState(models[0].id);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<string>("");
  const [customModel, setCustomModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const abort = useRef<AbortController | null>(null);

  const model = getMediaModel(modelId) ?? models[0];
  const apiKey = settings.ai.keys[model.provider];

  const run = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true); setError(null); setElapsed(0);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const first = await generateMedia({
        modelId, prompt,
        size: size || model.sizes?.[0],
        apiKey,
        model: model.custom ? customModel.trim() : undefined,
        web: settings.ai.webAccess,
        signal: ctrl.signal,
      });
      const done = await awaitMedia(modelId, first, { apiKey, signal: ctrl.signal, onTick: setElapsed });
      if (done.status === "error" || !done.dataUrl) throw new Error(done.error ?? "Generation failed.");
      setItems((prev) => [{ id: uid("m"), url: done.dataUrl!, prompt: done.revisedPrompt || prompt, model: model.name, kind, at: Date.now() }, ...prev]);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : "Generation failed.");
    } finally { setBusy(false); abort.current = null; }
  }, [prompt, busy, modelId, size, model, apiKey, kind, customModel, settings.ai.webAccess]);

  /** Data URLs go into the OS filesystem so every other app can reach them —
   *  that is what makes a generated image an asset rather than a screenshot. */
  const saveToFiles = (item: MediaItem) => {
    const ext = item.kind === "image" ? "png" : "mp4";
    const path = `/media/${item.kind}s/${item.prompt.slice(0, 32).replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-") || item.id}.${ext}`;
    vfs.write(path, item.url, { appId: "studio" });
    bus.emit("notify", { title: `Saved to ${path}`, kind: "success" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[var(--border)] p-2.5">
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <select value={modelId} onChange={(e) => { setModelId(e.target.value); setSize(""); }} className="os-input !w-auto !py-1 text-[11px]">
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {model.sizes && (
            <select value={size || model.sizes[0]} onChange={(e) => setSize(e.target.value)} className="os-input !w-auto !py-1 text-[11px]">
              {model.sizes.map((sz) => <option key={sz} value={sz}>{sz}</option>)}
            </select>
          )}
          {model.approxUsd && <span className="os-chip" title="Rough list price per generation">~${model.approxUsd.toFixed(2)}</span>}
          <span className={cn("os-chip", !apiKey && "!border-[var(--warning,var(--danger))]")} title={apiKey ? "Using your stored key" : "No key stored — the deployment's key is used if it has one"}>
            {model.provider}{apiKey ? " · key" : " · no key"}
          </span>
        </div>
        {model.custom && (
          <input
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="openrouter model id, e.g. google/gemini-3-pro-image"
            className="os-input mb-2 !py-1 font-[family-name:var(--font-mono)] text-[11px]"
          />
        )}
        {model.note && <div className="mb-2 text-[10.5px] leading-snug text-[var(--muted)]">{model.note}</div>}
        {kind === "video" && (
          <div className="mb-2 text-[10.5px] leading-snug text-[var(--muted)]">
            OpenRouter does not host video generation — of its 445 models, none declare video output — so video goes
            direct to Google or OpenAI with that provider&rsquo;s own key. Images can go either way.
          </div>
        )}
        <div className="flex gap-1.5">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
            rows={2}
            placeholder={kind === "image" ? "Describe the image — subject, style, lighting, framing…" : "Describe the shot — subject, camera move, mood…"}
            className="os-input min-w-0 flex-1 resize-y !py-1 text-[12px]"
          />
          <div className="flex shrink-0 flex-col gap-1">
            <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={run} disabled={busy || !prompt.trim() || (model.custom && !customModel.trim())}>
              <Icon name="wand" size={11} className="mr-1" />{busy ? "Working…" : "Generate"}
            </button>
            {busy && <button className="os-btn !py-1 text-[11px]" onClick={() => abort.current?.abort()}>Cancel</button>}
          </div>
        </div>
        {busy && (
          <div className="mt-1.5">
            <Spinner label={kind === "video" ? `Rendering — ${elapsed}s elapsed. Video jobs run for minutes.` : "Generating…"} />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <Empty
            icon={kind === "image" ? "image" : "video"}
            title={kind === "image" ? "No images yet" : "No video yet"}
            body={
              kind === "image"
                ? "Generated images go into the OS filesystem, so Notes, Media and the wallpaper picker can all reach them."
                : "Video is a long-running job on every provider: it is submitted, then polled. Expect minutes, not seconds, and leave this window open."
            }
          />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {items.map((it) => (
              <div key={it.id} className="os-card !p-2">
                <div className="mb-1.5 overflow-hidden rounded-[calc(var(--radius)*0.5)] border border-[var(--border)] bg-black/25">
                  {it.kind === "image"
                    /* eslint-disable-next-line @next/next/no-img-element */
                    ? <img src={it.url} alt={it.prompt} className="block w-full" />
                    : <video src={it.url} controls className="block w-full" />}
                </div>
                <div className="mb-1.5 line-clamp-2 text-[10.5px] text-[var(--muted)]" title={it.prompt}>{it.prompt}</div>
                <div className="flex flex-wrap gap-1">
                  <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => saveToFiles(it)}>Save to Files</button>
                  <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => download(`${it.id}.${it.kind === "image" ? "png" : "mp4"}`, it.url, "")}>Download</button>
                  {it.kind === "image" && (
                    <button
                      className="os-btn !px-2 !py-0.5 text-[10.5px]"
                      title="Use as the desktop wallpaper"
                      onClick={() => { settings.set("wallpaperImage", it.url); settings.set("wallpaper", "image"); bus.emit("notify", { title: "Wallpaper set", kind: "success" }); }}
                    >
                      Set wallpaper
                    </button>
                  )}
                  <span className="os-chip !px-1.5 !py-0 !text-[9px]">{it.model}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MCP — engines and other running programs
   ══════════════════════════════════════════════════════════════════════════ */

function McpTab() {
  const mcp = useMcp();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ id: string; tool: string; ok: boolean; text: string }>>([]);
  const [goal, setGoal] = useState("");
  const [argText, setArgText] = useState("{}");
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  const server = mcp.servers.find((s) => s.id === activeId) ?? null;
  const conn = server ? mcp.connections[server.id] : undefined;

  const doConnect = useCallback(async (s: McpServer) => {
    setBusy(s.id); setError(null);
    try {
      mcp.setConnection(s.id, await mcpConnect(s));
    } catch (e) {
      setError(`${s.name}: ${e instanceof Error ? e.message : "Could not connect."}`);
      mcp.setConnection(s.id, null);
    } finally { setBusy(null); }
  }, [mcp]);

  const invoke = useCallback(async (tool: string, args: Record<string, unknown>) => {
    if (!server) return;
    setBusy(tool);
    const out = await callTool(server, conn?.sessionId, tool, args);
    setLog((l) => [{ id: uid("call"), tool, ok: out.ok, text: out.text }, ...l].slice(0, 40));
    setBusy(null);
    return out;
  }, [server, conn]);

  /** Let a model drive the editor.
   *
   *  The tool call is asked for as a JSON block rather than through each
   *  provider's own function-calling schema. That is deliberate: it works
   *  identically on all twelve providers including a local Ollama, and a
   *  desktop OS whose headline feature only works on two vendors is not much
   *  of an OS. */
  const runAgent = useCallback(async () => {
    if (!server || !conn || !goal.trim()) return;
    setBusy("agent"); setError(null);
    try {
      let context = "";
      for (let step = 0; step < 6; step++) {
        const res = await ask({
          maxTokens: 900,
          system: `You are driving ${conn.serverName ?? server.name} through MCP tools. Available tools:\n\n${toolCatalogue(conn.tools)}\n\nReply with ONE tool call as a fenced json block:\n\`\`\`json\n{"tool":"name","arguments":{}}\n\`\`\`\nWhen the goal is met, reply with exactly DONE and one sentence saying what you did. Never invent a tool that is not listed.`,
          messages: [{ role: "user", content: `Goal: ${goal}${context ? `\n\nSo far:\n${context}` : ""}` }],
        });
        const block = res.text.match(/```json\s*([\s\S]*?)```/);
        if (!block) {
          setLog((l) => [{ id: uid("call"), tool: "agent", ok: true, text: res.text.trim() }, ...l]);
          break;
        }
        let call: { tool?: string; arguments?: Record<string, unknown> };
        try { call = JSON.parse(block[1]); } catch { throw new Error("The model produced a malformed tool call."); }
        if (!call.tool) break;
        const out = await invoke(call.tool, call.arguments ?? {});
        context += `\n${call.tool}(${JSON.stringify(call.arguments ?? {})}) -> ${(out?.text ?? "").slice(0, 600)}`;
        if (!out?.ok) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The agent run failed.");
    } finally { setBusy(null); }
  }, [server, conn, goal, invoke]);

  const tool = conn?.tools.find((t) => t.name === selectedTool);

  return (
    <div className="app-split flex min-h-0 flex-1">
      <div className="app-sidebar w-56 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
        <div className="os-label mb-1.5">Servers</div>
        {mcp.servers.map((s) => {
          const c = mcp.connections[s.id];
          return (
            <button
              key={s.id}
              onClick={() => { setActiveId(s.id); setSelectedTool(null); }}
              className={cn("mb-1 block w-full rounded-[calc(var(--radius)*0.5)] border px-2 py-1.5 text-left", activeId === s.id ? "border-[var(--accent)] bg-[var(--accent)]/12" : "border-[var(--border)]")}
            >
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c ? "var(--accent)" : "color-mix(in srgb, var(--muted) 50%, transparent)" }} />
                <span className="min-w-0 flex-1 truncate text-[12px]">{s.name}</span>
              </div>
              <div className="truncate text-[9.5px] text-[var(--muted)]">{c ? `${c.tools.length} tools` : s.url}</div>
            </button>
          );
        })}
        <button
          className="os-btn mt-1 w-full !py-1 text-[11px]"
          onClick={() => {
            const url = window.prompt("MCP server URL", "http://localhost:8080/mcp");
            if (!url) return;
            const name = window.prompt("Name it", "My server") ?? "Server";
            setActiveId(mcp.add({ name, url, enabled: true }));
          }}
        >
          + Add server
        </button>
        <p className="mt-3 text-[10px] leading-relaxed text-[var(--muted)]">
          A localhost server is called straight from your browser, because a serverless function has no route to your
          machine — so it must send CORS headers for this origin. Public servers can go through the relay instead.
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!server ? (
          <Empty
            icon="mcp"
            title="Drive a real editor"
            body="Godot, Unity, Unreal and Blender all have MCP servers. Point one at its URL and the tools it exposes become things a model can actually do — open a scene, add a node, build the project — rather than code you paste in yourself."
          />
        ) : (
          <>
            <div className="shrink-0 border-b border-[var(--border)] p-2.5">
              <ErrorNote error={error} onDismiss={() => setError(null)} />
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <input
                  value={server.url}
                  onChange={(e) => mcp.update(server.id, { url: e.target.value })}
                  className="os-input min-w-0 flex-1 !py-1 font-[family-name:var(--font-mono)] text-[11px]"
                />
                <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={() => doConnect(server)} disabled={busy === server.id}>
                  {busy === server.id ? "Connecting…" : conn ? "Reconnect" : "Connect"}
                </button>
                <button className="os-btn !py-1 text-[11px]" onClick={() => { mcp.remove(server.id); setActiveId(null); }}>
                  <Icon name="close" size={11} />
                </button>
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                <input type="checkbox" checked={!!server.viaRelay} onChange={(e) => mcp.update(server.id, { viaRelay: e.target.checked })} />
                Route through this deployment (public servers only — private addresses are refused)
              </label>
              {conn && (
                <div className="mt-2 flex gap-1.5">
                  <input
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && runAgent()}
                    placeholder={`Tell the model what to do in ${conn.serverName ?? server.name}…`}
                    className="os-input min-w-0 flex-1 !py-1 text-[12px]"
                  />
                  <button className="os-btn shrink-0 !py-1 text-[11px]" data-variant="primary" onClick={runAgent} disabled={!!busy || !goal.trim()}>
                    {busy === "agent" ? "Working…" : "Run"}
                  </button>
                </div>
              )}
            </div>

            <div className="app-split flex min-h-0 flex-1">
              <div className="app-sidebar w-56 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
                <div className="os-label mb-1.5">Tools {conn ? `(${conn.tools.length})` : ""}</div>
                {!conn && <div className="text-[11px] text-[var(--muted)]">Not connected.</div>}
                {conn?.tools.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => {
                      setSelectedTool(t.name);
                      const req = t.inputSchema?.required ?? [];
                      setArgText(JSON.stringify(Object.fromEntries(req.map((r) => [r, ""])), null, 2));
                    }}
                    className={cn("mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-[11px]", selectedTool === t.name ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
                    title={t.description}
                  >
                    {t.name}
                  </button>
                ))}
              </div>

              <div className="min-w-0 flex-1 overflow-y-auto p-2.5">
                {tool && (
                  <div className="os-card mb-3">
                    <div className="mb-1 text-[12.5px] font-medium">{tool.name}</div>
                    {tool.description && <div className="mb-2 text-[11px] text-[var(--muted)]">{tool.description}</div>}
                    <textarea
                      value={argText}
                      onChange={(e) => setArgText(e.target.value)}
                      rows={5}
                      spellCheck={false}
                      className="os-input mb-1.5 resize-y !py-1 font-[family-name:var(--font-mono)] text-[11px]"
                    />
                    <button
                      className="os-btn !py-1 text-[11px]"
                      data-variant="primary"
                      disabled={!!busy}
                      onClick={() => {
                        try { invoke(tool.name, JSON.parse(argText)); }
                        catch { setError("Arguments must be valid JSON."); }
                      }}
                    >
                      Call
                    </button>
                  </div>
                )}
                <div className="os-label mb-1.5">Output</div>
                {log.length === 0 && <div className="text-[11px] text-[var(--muted)]">Nothing called yet.</div>}
                {log.map((l) => (
                  <div key={l.id} className="mb-1.5 rounded-[calc(var(--radius)*0.5)] border px-2 py-1.5" style={{ borderColor: l.ok ? "var(--border)" : "var(--danger)" }}>
                    <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--muted)]">
                      <Icon name={l.ok ? "check" : "warning"} size={10} />{l.tool}
                    </div>
                    <pre className="whitespace-pre-wrap break-words font-[family-name:var(--font-mono)] text-[10.5px]">{l.text}</pre>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   LIBRARY
   ══════════════════════════════════════════════════════════════════════════ */

function LibraryTab({ running, setRunning, onBuild }: { running: UserApp | null; setRunning: (a: UserApp | null) => void; onBuild: () => void }) {
  const store = useUserApps();
  const settings = useSettings();
  const [panelFor, setPanelFor] = useState<string | null>(null);

  if (running) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
          <button className="os-btn !py-1 text-[11px]" onClick={() => setRunning(null)}>‹ Library</button>
          <Icon name={running.icon || "app"} size={13} style={{ color: "var(--accent)" }} />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{running.name}</span>
          {running.files && (
            <button className="os-btn !py-1 text-[11px]" onClick={() => downloadZip(running.name, running.files!)}>
              <Icon name="package" size={11} className="mr-1" />Export .zip
            </button>
          )}
        </div>
        <iframe
          srcDoc={running.html}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className="min-h-0 flex-1 border-0 bg-white"
          title={running.name}
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {store.apps.length === 0 ? (
        <Empty
          icon="app"
          title="Nothing built yet"
          body="Anything you build here can be installed as a real app: it gets a desktop icon, opens in its own window, and still exports as source you can take anywhere."
          action={<button className="os-btn" data-variant="primary" onClick={onBuild}>Build something</button>}
        />
      ) : (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
          {store.apps.map((a) => (
            <div key={a.id} className="os-card">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Icon name={a.icon || "app"} size={15} style={{ color: "var(--accent)" }} />
                <input
                  value={a.name}
                  onChange={(e) => store.rename(a.id, e.target.value, a.icon)}
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium outline-none"
                />
              </div>
              <div className="mb-2 flex flex-wrap items-center gap-1 text-[10px] text-[var(--muted)]">
                <span className="os-chip !px-1.5 !py-0 !text-[9px]">{a.kind === "project" ? `${a.files?.length ?? 0} files` : "single file"}</span>
                {a.target && <span className="os-chip !px-1.5 !py-0 !text-[9px]">{getTarget(a.target).name}</span>}
                <span>{relTime(a.updatedAt)}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                <button className="os-btn !px-2 !py-0.5 text-[10.5px]" data-variant="primary" onClick={() => setRunning(a)}>Run</button>
                <button
                  className="os-btn !px-2 !py-0.5 text-[10.5px]"
                  title="Pin this app to the desktop"
                  onClick={() => {
                    settings.addDesktopItem({ kind: "userapp", ref: a.id, x: 140, y: 70 });
                    bus.emit("notify", { title: `Pinned "${a.name}" to the desktop`, kind: "success" });
                  }}
                >
                  <Icon name="pin" size={11} />
                </button>
                <button
                  className="os-btn !px-2 !py-0.5 text-[10.5px]"
                  onClick={() => (a.files ? downloadZip(a.name, a.files) : download(`${a.name}.html`, a.html, "text/html"))}
                >
                  <Icon name="download" size={11} />
                </button>
                <button
                  className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", panelFor === a.id && "!border-[var(--accent)]")}
                  title="Upgrade with AI, or revert to an earlier version"
                  onClick={() => setPanelFor(panelFor === a.id ? null : a.id)}
                >
                  <Icon name="wand" size={11} />
                  <span className="ml-1">{store.historyFor(a.id).length}</span>
                </button>
                <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => store.remove(a.id)}>
                  <Icon name="close" size={11} />
                </button>
              </div>
              {panelFor === a.id && <VersionPanel app={a} onRan={() => setRunning(store.get(a.id) ?? a)} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   UPGRADE AND REVERT

   The panel that makes "rewrite my app with AI" a tool rather than a gamble.
   Every rewrite is committed as a version, so the worse result is one click
   from being undone — and the undo appends rather than truncating, so the
   attempt you reverted is still there if you change your mind again.
   ══════════════════════════════════════════════════════════════════════════ */

function VersionPanel({ app, onRan }: { app: UserApp; onRan: () => void }) {
  const store = useUserApps();
  const [intent, setIntent] = useState(UPGRADE_INTENTS[0].id);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const history = store.historyFor(app.id);
  const needsDetail = intent === "feature" || intent === "fix";

  const run = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setNote(null);
    const r = await upgradeApp({ appId: app.id, intentId: intent, detail, signal: ctrl.signal });
    setBusy(false);
    abort.current = null;
    if (!r.ok) setNote(r.reason);
    else {
      setDetail("");
      setNote(`Saved as a new version. ${r.changedFiles} file(s), $${r.costUsd.toFixed(4)}.`);
      onRan();
    }
  };

  return (
    <div className="mt-2 border-t border-[var(--border)] pt-2">
      <div className="os-label mb-1">Upgrade with AI</div>
      <select className="os-input mb-1.5 w-full !py-1 text-[11px]" value={intent} onChange={(e) => setIntent(e.target.value)}>
        {UPGRADE_INTENTS.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
      </select>
      <input
        className="os-input mb-1.5 w-full text-[11px]"
        placeholder={needsDetail ? "Describe it — required" : "Anything to add (optional)"}
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !busy) void run(); }}
      />
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {busy ? (
          <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <button
            className="os-btn !px-2 !py-0.5 text-[10.5px]"
            data-variant="primary"
            onClick={() => void run()}
            disabled={needsDetail && !detail.trim()}
          >
            <Icon name="wand" size={11} className="mr-1" />Rewrite
          </button>
        )}
        {busy && <span className="text-[10.5px] text-[var(--muted)]">Working. Nothing is replaced until it returns.</span>}
      </div>
      {note && <p className="mb-2 text-[10.5px] leading-snug text-[var(--muted)]">{note}</p>}

      <div className="os-label mb-1">History ({history.length})</div>
      <div className="space-y-0.5">
        {history.slice().reverse().map((v, i) => {
          const isCurrent = i === 0;
          const previous = history[history.length - 2 - i];
          const d = previous ? diffVersions(previous, v) : null;
          return (
            <div key={v.id} className="flex items-start gap-1.5 text-[10.5px]">
              <Icon
                name={isCurrent ? "check" : v.source === "revert" ? "arrowUp" : "circle"}
                size={11}
                className="mt-0.5 shrink-0"
                style={{ color: isCurrent ? "var(--ok)" : "var(--muted)" }}
              />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate", isCurrent && "font-medium")}>{v.label}</span>
                <span className="block text-[var(--muted)]">
                  {relTime(v.at)}
                  {d && !d.identical ? ` · ${d.summary}` : ""}
                </span>
              </span>
              {!isCurrent && (
                <button
                  className="os-btn shrink-0 !px-1.5 !py-0 !text-[10px]"
                  title="Restore this version. Nothing is deleted — the restore is itself a new version."
                  onClick={() => {
                    const r = store.revertApp(app.id, v.id);
                    setNote(r.ok ? `Restored "${v.label}". Nothing was deleted.` : r.reason);
                    if (r.ok) onRan();
                  }}
                >
                  Restore
                </button>
              )}
            </div>
          );
        })}
        {history.length === 0 && (
          <p className="text-[10.5px] text-[var(--muted)]">
            No history yet. Apps built before this feature start recording from their next change.
          </p>
        )}
      </div>
    </div>
  );
}
