"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import { useUserApps, type UserApp } from "@/kernel/userapps";
import { UPGRADE_INTENTS, diffVersions } from "@/lib/appversions";
import { upgradeApp } from "@/lib/app-upgrade";
import { ask } from "@/lib/useAI";
import { extractCode, explainNoCode } from "@/lib/extract-code";
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
import { trackJob } from "@/kernel/jobs";
import {
  TEMPLATES, injectBridge, readBridge, pushConsole, fixPrompt, lineDiff, diffStats, hunks,
  pushBuildVersion, changedPath, type Template, type ConsoleEntry, type BuildVersion,
} from "@/lib/studio-kit";

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

export default function AIStudio({ args, win }: AppProps) {
  const [tab, setTab] = useState<Tab>((args?.tab as Tab) ?? "build");
  const apps = useUserApps((s) => s.apps);
  const [running, setRunning] = useState<UserApp | null>(null);

  /* Re-opening an ALREADY-OPEN studio window does refresh this window's args --
     wm.open stores `args: opts.args ?? w.args` on the focus path -- but a
     useState initializer only reads them once, at mount. So a second
     "Build in AI Studio" click from For You used to arrive here as a new prop
     and be silently discarded, leaving the first suggestion's prompt in the box
     and whatever tab the user was on. Consume it the same way runUserApp is
     consumed below: adjust during render when the incoming value differs from
     the one last taken. */
  const promptArg = typeof args?.prompt === "string" ? args.prompt : "";
  const [tookPrompt, setTookPrompt] = useState(promptArg);
  if (promptArg && promptArg !== tookPrompt) {
    setTookPrompt(promptArg);
    setTab("build");
  }

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
      {tab === "build" && <BuildTab initialPrompt={typeof args?.prompt === "string" ? args.prompt : ""} windowId={win?.id} />}
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

/** `initialPrompt` lets another app hand AI Studio an idea to build. */
function BuildTab({ initialPrompt = "", windowId }: { initialPrompt?: string; windowId?: string }) {
  const vfs = useVFS();
  const userApps = useUserApps();
  const [group, setGroup] = useState<(typeof TARGET_GROUPS)[number]["id"]>("web");
  const [targetId, setTargetId] = useState("single-html");
  const [prompt, setPrompt] = useState(initialPrompt);
  /* Same reason as the promptArg block in AIStudio: this component stays mounted
     across a re-open, so a changed initialPrompt has to be adopted explicitly.
     Gated on an actual CHANGE, so typing in the box is never overwritten. */
  const [tookInitial, setTookInitial] = useState(initialPrompt);
  if (initialPrompt && initialPrompt !== tookInitial) {
    setTookInitial(initialPrompt);
    setPrompt(initialPrompt);
  }
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stream, setStream] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "code" | "diff">("preview");
  const [previewKey, setPreviewKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  /* Every generate, pass, manual snapshot and rollback is a version. A
     rollback APPENDS a version with the old content, so it is itself undoable. */
  const [versions, setVersions] = useState<BuildVersion[]>([]);
  const [diffFor, setDiffFor] = useState<string | null>(null);
  /* The preview's console, forwarded by the injected bridge. The token is
     minted per run in the handlers that re-run the preview, never in render. */
  const [runToken, setRunToken] = useState("");
  const [consoleLog, setConsoleLog] = useState<Array<ConsoleEntry & { count: number }>>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [autoFix, setAutoFix] = useState<{ attempt: number; max: number } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const filesRef = useRef<ProjectFile[] | null>(null);
  const consoleRef = useRef<Array<ConsoleEntry & { count: number }>>([]);
  const stopRef = useRef(false);

  const target = getTarget(targetId);

  // The preview is derived, never stored: editing a file re-links the project
  // on the next render, which is what makes the editor feel live.
  const preview = useMemo(() => (files ? buildPreview(files, targetId) : null), [files, targetId]);
  // What the iframe actually runs: the preview plus the console bridge. The
  // exported file never carries the bridge.
  const previewDoc = useMemo(() => {
    if (!preview?.html) return null;
    const origin = typeof window === "undefined" ? "*" : window.location.origin;
    return injectBridge(preview.html, runToken, origin);
  }, [preview, runToken]);

  /* Messages are accepted only from THIS preview's window, and bridge
     messages only with this run's token. The app runs without
     allow-same-origin, so postMessage is the only way it can speak at all. */
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const d = e.data as { __preview?: string; message?: string };
      if (d?.__preview === "error") {
        setRuntimeError(d.message ?? "Unknown error");
        consoleRef.current = pushConsole(consoleRef.current, { level: "error", text: d.message ?? "Unknown error" });
        setConsoleLog(consoleRef.current);
        return;
      }
      if (d?.__preview === "ready") { setRuntimeError(null); return; }
      const entry = readBridge(e.data, runToken);
      if (!entry) return;
      consoleRef.current = pushConsole(consoleRef.current, entry);
      setConsoleLog(consoleRef.current);
      if (entry.level === "error") setRuntimeError((r) => r ?? entry.text);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [runToken]);

  const name = useMemo(
    () => (prompt.split(/[.\n]/)[0] || "project").replace(/[^\w -]/g, "").trim().slice(0, 40) || "project",
    [prompt],
  );

  /** Re-run the preview from a clean console. */
  const rerun = useCallback(() => {
    consoleRef.current = [];
    setConsoleLog([]);
    setRuntimeError(null);
    setRunToken(uid("run"));
    setPreviewKey((k) => k + 1);
  }, []);

  /** The one way files change as a step: state, the ref the fix loop reads,
   *  and a version. */
  const commit = useCallback((next: ProjectFile[], label: string) => {
    filesRef.current = next;
    setFiles(next);
    setVersions((v) => pushBuildVersion(v, { id: uid("bv"), at: Date.now(), label, files: next }));
  }, []);

  const jobTarget = useMemo(() => ({ appId: "studio", args: { tab: "build" }, windowId }), [windowId]);

  const generate = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy("Building"); setError(null); setStream(""); setRuntimeError(null); setDiffFor(null);
    try {
      await trackJob({ kind: "ai", title: `AI Studio: building ${name}`, detail: target.name, target: jobTarget }, async (report) => {
        let reported = 0;
        const onDelta = (_d: string, full: string) => {
          setStream(full);
          // The count is real; a percentage would be a guess, so there is none.
          if (full.length - reported >= 800) { reported = full.length; report(undefined, `${full.length.toLocaleString()} chars received`); }
        };
        if (target.id === "single-html") {
          const res = await ask({ messages: [{ role: "user", content: prompt }], system: SINGLE_HTML_BRIEF, maxTokens: 16000, onDelta });
          const code = extractCode(res.text);
          if (!code) throw new Error(explainNoCode(res.text));
          commit([{ path: "index.html", content: code }, ...target.base(name)], `Built: ${prompt.slice(0, 40)}`);
          setOpenFile("index.html");
        } else {
          const base = target.base(name);
          const res = await ask({
            messages: [{ role: "user", content: `Build: ${prompt}` }],
            system: `${target.brief}\n\n${FILE_FORMAT}\n\nThese files already exist and are correct — do NOT rewrite them: ${base.map((f) => f.path).join(", ")}.\nAt minimum write: ${target.expects.join(", ")}.`,
            maxTokens: 24000,
            onDelta,
          });
          const written = parseProjectFiles(res.text);
          if (!written.length) throw new Error("No files came back in the expected format. Try again, or pick a stronger model in Settings.");
          const merged = mergeProject(base, written);
          commit(merged, `Built: ${prompt.slice(0, 40)}`);
          setOpenFile(written[0]?.path ?? merged[0]?.path ?? null);
        }
      });
      setStream("");
      setView("preview");
      rerun();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Build failed.");
    } finally { setBusy(null); }
  }, [prompt, busy, target, name, commit, rerun, jobTarget]);

  /** One refinement pass over the CURRENT files (read from the ref, so the fix
   *  loop's second attempt sees the first attempt's result). Throws on failure. */
  const runPass = useCallback(async (kind: string, instruction: string, onChars?: (n: number) => void) => {
    const current = filesRef.current;
    if (!current) throw new Error("Nothing built yet.");
    setStream("");
    const onDelta = (_d: string, full: string) => { setStream(full); onChars?.(full.length); };
    if (targetId === "single-html") {
      const html = current.find((f) => f.path === "index.html")?.content ?? "";
      const res = await ask({
        messages: [{ role: "user", content: html }],
        system: `${instruction}\n\nOutput only the complete updated HTML document in one fenced code block.`,
        maxTokens: 16000,
        onDelta,
      });
      const code = extractCode(res.text);
      if (!code) throw new Error(explainNoCode(res.text));
      commit(current.map((f) => (f.path === "index.html" ? { ...f, content: code } : f)), PASSES[kind]?.label ?? "Custom change");
    } else {
      const source = current
        .filter((f) => !/^(README\.md|\.gitignore|package-lock\.json)$/.test(f.path))
        .map((f) => `=== ${f.path} ===\n${f.content}`)
        .join("\n");
      const res = await ask({
        messages: [{ role: "user", content: source }],
        system: `${instruction}\n\n${FILE_FORMAT}\n\nReturn ONLY the files you actually changed. Write each one in full.`,
        maxTokens: 24000,
        onDelta,
      });
      const changed = parseProjectFiles(res.text);
      if (!changed.length) throw new Error("That pass returned no files.");
      commit(mergeProject(current, changed), PASSES[kind]?.label ?? "Custom change");
    }
    setStream("");
  }, [targetId, commit]);

  /** A refinement pass, tracked as a job. Multi-file projects send the whole
   *  tree and get the changed files back — a patch format would be cheaper and
   *  is exactly where models produce half-applied edits. */
  const pass = useCallback(async (kind: string, custom?: string) => {
    if (!filesRef.current || busy) return;
    setBusy(kind); setError(null); setDiffFor(null);
    try {
      const label = PASSES[kind]?.label ?? "Custom change";
      await trackJob({ kind: "ai", title: `AI Studio: ${label}`, detail: name, target: jobTarget }, async (report) => {
        let reported = 0;
        await runPass(kind, custom ?? PASSES[kind].prompt, (n) => {
          if (n - reported >= 800) { reported = n; report(undefined, `${n.toLocaleString()} chars received`); }
        });
      });
      rerun();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pass failed.");
    } finally { setBusy(null); }
  }, [busy, name, jobTarget, runPass, rerun]);

  /** Hand the preview's own errors back to the model. The failure text is far
   *  better evidence than "fix bugs". */
  const repair = useCallback(() => {
    const p = fixPrompt(consoleRef.current) || (runtimeError ? fixPrompt([{ level: "error", text: runtimeError }]) : "");
    if (p) void pass("bugfix", p);
  }, [runtimeError, pass]);

  /**
   * The fix loop: send the console errors, re-run the preview, wait for it to
   * report, and go again while errors remain — up to `max` attempts. Progress
   * is attempts made out of attempts allowed, which is a real fraction.
   */
  const runAutoFix = useCallback(async (max = 3) => {
    if (busy || !filesRef.current) return;
    stopRef.current = false;
    setBusy("autofix"); setError(null); setDiffFor(null);
    let fixed = false;
    try {
      await trackJob({ kind: "ai", title: `AI Studio: fixing ${name}`, target: jobTarget }, async (report) => {
        for (let attempt = 1; attempt <= max; attempt++) {
          const p = fixPrompt(consoleRef.current);
          if (!p) { fixed = true; return; }
          if (stopRef.current) return;
          setAutoFix({ attempt, max });
          report((attempt - 1) / max, `Attempt ${attempt} of ${max}`);
          await runPass("bugfix", p);
          rerun();
          // Give the new build time to load and report before judging it.
          await new Promise((r) => setTimeout(r, 3500));
        }
        fixed = !fixPrompt(consoleRef.current);
      });
      bus.emit("notify", {
        title: fixed ? "No errors left in the preview" : "Errors remain after the fix attempts",
        body: fixed ? undefined : "Open the console to see what is still failing.",
        kind: fixed ? "success" : "warn",
        target: jobTarget,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The fix loop failed.");
    } finally { setBusy(null); setAutoFix(null); }
  }, [busy, name, jobTarget, runPass, rerun]);

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

  /** One self-contained document: the linked preview, without the bridge. */
  const exportHtml = useCallback(() => {
    if (!preview?.html) return;
    download(`${name.replace(/\s+/g, "-") || "app"}.html`, preview.html, "text/html");
  }, [preview, name]);

  const restore = useCallback((v: BuildVersion) => {
    commit(v.files.map((f) => ({ ...f })), `Rolled back to "${v.label}"`);
    setDiffFor(null);
    setView("preview");
    rerun();
  }, [commit, rerun]);

  const pickTemplate = useCallback((t: Template) => {
    const tg = getTarget(t.target);
    setGroup(tg.group);
    setTargetId(tg.id);
    setPrompt(t.prompt);
  }, []);

  const totalKb = files ? rawSize(files) / 1024 : 0;
  const errors = consoleLog.filter((e) => e.level === "error").reduce((a, e) => a + e.count, 0);
  const warns = consoleLog.filter((e) => e.level === "warn").reduce((a, e) => a + e.count, 0);
  const diffVersion = versions.find((v) => v.id === diffFor) ?? null;

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
                if (first) { setTargetId(first.id); setFiles(null); filesRef.current = null; setRuntimeError(null); setVersions([]); }
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
              onClick={() => { setTargetId(t.id); setFiles(null); filesRef.current = null; setRuntimeError(null); setVersions([]); }}
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
            aria-label="What to build"
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
            <button className="os-chip" title="Another idea" aria-label="Another idea" onClick={() => setPrompt(IDEAS[Math.floor(Math.random() * IDEAS.length)])}>
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
            {busy && <Spinner label={autoFix ? `Fix attempt ${autoFix.attempt} of ${autoFix.max} · ${stream.length.toLocaleString()} chars` : `${stream.length.toLocaleString()} chars`} />}
            {busy === "autofix" && (
              <button className="os-btn !py-0.5 text-[10.5px]" onClick={() => { stopRef.current = true; }} title="Stop after the current attempt">Stop</button>
            )}
            <span className="os-chip">{files.length} files · {totalKb.toFixed(1)} KB</span>
          </div>
        )}
      </div>

      {/* ── Runtime error from the preview ── */}
      {runtimeError && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-[11.5px]">
          <Icon name="warning" size={12} />
          <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)]">{runtimeError}</span>
          <button className="os-btn !py-0.5 text-[10.5px]" data-variant="primary" onClick={repair} disabled={!!busy}>Fix it</button>
          <button className="os-btn !py-0.5 text-[10.5px]" onClick={() => void runAutoFix(3)} disabled={!!busy} title="Fix, re-run, and repeat while errors remain (up to 3 attempts)">
            <Icon name="loop" size={11} className="mr-1" />Fix until clean
          </button>
        </div>
      )}

      {/* ── Editor + preview ── */}
      {!files ? (
        busy ? (
          <Empty icon="aistudio" title="Building…" body={`${stream.length.toLocaleString()} characters so far.`} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="os-label mb-1.5">Start from a template</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 190px), 1fr))" }}>
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => pickTemplate(t)}
                  className={cn("os-card !p-2.5 text-left transition hover:-translate-y-0.5", prompt === t.prompt && "!border-[var(--accent)]")}
                >
                  <div className="mb-1 flex items-center gap-1.5">
                    <Icon name={t.icon} size={14} style={{ color: "var(--accent)" }} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{t.title}</span>
                  </div>
                  <div className="text-[10.5px] leading-snug text-[var(--muted)]">{t.blurb}</div>
                  <div className="mt-1.5"><span className="os-chip !px-1.5 !py-0 !text-[9px]">{getTarget(t.target).name}</span></div>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
              Picking a template fills in the target and the description; press Build when it says what you want. Anything with a browser
              runtime previews live — React and TypeScript are transpiled and linked right here, so you see it run without npm install.
            </p>
          </div>
        )
      ) : (
        <div className="app-split flex min-h-0 flex-1">
          {/* files + history */}
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
              <button className="os-btn w-full !py-1 text-[11px]" onClick={exportHtml} disabled={!preview?.html} title={preview?.html ? "One self-contained file that runs anywhere" : preview?.reason}>
                <Icon name="download" size={11} className="mr-1" />Export .html
              </button>
              <button className="os-btn w-full !py-1 text-[11px]" data-variant="primary" onClick={install}>
                <Icon name="pin" size={11} className="mr-1" />Install as app
              </button>
            </div>

            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <div className="mb-1 flex items-center gap-1 px-1">
                <span className="os-label !mb-0 flex-1">History ({versions.length})</span>
                <button
                  className="os-btn !px-1.5 !py-0 !text-[10px]"
                  disabled={!!busy}
                  title="Save the current files as a version"
                  onClick={() => files && commit(files.map((f) => ({ ...f })), "Manual snapshot")}
                >
                  <Icon name="save" size={10} className="mr-0.5" />Snapshot
                </button>
              </div>
              {versions.slice().reverse().map((v, i) => (
                <div key={v.id} className={cn("mb-0.5 rounded px-1.5 py-1", diffFor === v.id && "bg-[var(--accent)]/12")}>
                  <div className="flex items-center gap-1">
                    <span className={cn("min-w-0 flex-1 truncate text-[10.5px]", i === 0 && "font-medium")} title={v.label}>{v.label}</span>
                    {i === 0 && <span className="os-chip !px-1 !py-0 !text-[8.5px]">now</span>}
                  </div>
                  <div className="flex items-center gap-1 text-[9.5px] text-[var(--muted)]">
                    <span className="flex-1">{relTime(v.at)}</span>
                    {i > 0 && (
                      <>
                        <button className="underline-offset-2 hover:underline" onClick={() => { setDiffFor(v.id); setView("diff"); }} aria-label={`Compare "${v.label}" with the current files`}>Diff</button>
                        <button className="underline-offset-2 hover:underline" disabled={!!busy} onClick={() => restore(v)} aria-label={`Roll back to "${v.label}"`}>Restore</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* main pane */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1">
              <button onClick={() => setView("preview")} className={cn("os-btn !py-0.5 text-[11px]", view === "preview" && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                <Icon name="live" size={11} className="mr-1" />Preview
              </button>
              <button onClick={() => setView("code")} className={cn("os-btn !py-0.5 text-[11px]", view === "code" && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                <Icon name="ide" size={11} className="mr-1" />Code
              </button>
              {diffVersion && (
                <button onClick={() => setView("diff")} className={cn("os-btn !py-0.5 text-[11px]", view === "diff" && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>
                  <Icon name="layers" size={11} className="mr-1" />Diff
                </button>
              )}
              <div className="flex-1" />
              {view === "preview" && preview?.html && (
                <button className="os-btn !py-0.5 text-[11px]" onClick={rerun} title="Re-run the preview" aria-label="Re-run the preview">
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

            {view === "diff" && diffVersion ? (
              <DiffPane from={diffVersion} to={files} onRestore={() => restore(diffVersion)} busy={!!busy} />
            ) : view === "code" ? (
              <textarea
                value={busy ? stream : files.find((f) => f.path === openFile)?.content ?? ""}
                onChange={(e) => { const next = files.map((f) => (f.path === openFile ? { ...f, content: e.target.value } : f)); filesRef.current = next; setFiles(next); }}
                readOnly={!!busy}
                spellCheck={false}
                aria-label={openFile ? `Source of ${openFile}` : "Source"}
                className="min-h-0 flex-1 resize-none bg-transparent p-2.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] outline-none"
              />
            ) : previewDoc ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <iframe
                  ref={iframeRef}
                  key={previewKey}
                  srcDoc={previewDoc}
                  // Never allow-same-origin: the app stays an opaque origin.
                  sandbox="allow-scripts allow-forms allow-modals allow-popups"
                  className="min-h-0 flex-1 border-0 bg-white"
                  title="Live preview"
                />
                <ConsoleStrip
                  entries={consoleLog}
                  errors={errors}
                  warns={warns}
                  open={consoleOpen}
                  setOpen={setConsoleOpen}
                  busy={!!busy}
                  onFix={repair}
                  onAutoFix={() => void runAutoFix(3)}
                  onClear={() => { consoleRef.current = []; setConsoleLog([]); }}
                />
                {preview?.note && <div className="shrink-0 border-t border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--muted)]">{preview.note}</div>}
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

/** The preview's console: counts always visible, entries on demand. */
function ConsoleStrip({ entries, errors, warns, open, setOpen, busy, onFix, onAutoFix, onClear }: {
  entries: Array<ConsoleEntry & { count: number }>;
  errors: number;
  warns: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  busy: boolean;
  onFix: () => void;
  onAutoFix: () => void;
  onClear: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1 text-[10.5px]">
        <button className="flex items-center gap-1" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
          <span className="font-medium">Console</span>
        </button>
        <span className={cn("os-chip !px-1.5 !py-0 !text-[9.5px] tabular-nums", errors > 0 && "!border-[var(--danger)] !text-[var(--danger)]")}>{errors} error{errors === 1 ? "" : "s"}</span>
        <span className="os-chip !px-1.5 !py-0 !text-[9.5px] tabular-nums">{warns} warning{warns === 1 ? "" : "s"}</span>
        <span className="text-[var(--muted)] tabular-nums">{entries.length} line{entries.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        {errors > 0 && (
          <>
            <button className="os-btn !px-2 !py-0 !text-[10px]" data-variant="primary" disabled={busy} onClick={onFix}>Fix it</button>
            <button className="os-btn !px-2 !py-0 !text-[10px]" disabled={busy} onClick={onAutoFix}>Fix until clean</button>
          </>
        )}
        {entries.length > 0 && <button className="os-btn !px-2 !py-0 !text-[10px]" onClick={onClear}>Clear</button>}
      </div>
      {open && (
        <div className="max-h-40 overflow-y-auto border-t border-[var(--border)] px-2 py-1 font-[family-name:var(--font-mono)] text-[10.5px]">
          {entries.length === 0 && <div className="py-1 text-[var(--muted)]">Nothing logged by this run.</div>}
          {entries.map((e, i) => (
            <div key={i} className="flex gap-1.5 border-b border-[var(--border)]/40 py-0.5 last:border-0" style={{ color: e.level === "error" ? "var(--danger)" : e.level === "warn" ? "var(--warning, var(--accent2))" : undefined }}>
              <span className="w-10 shrink-0 opacity-70">{e.level}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{e.text}</span>
              {e.count > 1 && <span className="shrink-0 opacity-70">x{e.count}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A real line diff between a version and the current files, cut to the
 *  changed hunks. */
function DiffPane({ from, to, onRestore, busy }: { from: BuildVersion; to: ProjectFile[]; onRestore: () => void; busy: boolean }) {
  const path = changedPath(from.files, to);
  const [picked, setPicked] = useState<string | null>(null);
  const file = picked ?? path;
  const before = from.files.find((f) => f.path === file)?.content ?? "";
  const after = to.find((f) => f.path === file)?.content ?? "";
  const d = useMemo(() => (file ? lineDiff(before, after) : null), [file, before, after]);
  const stats = d ? diffStats(d) : null;
  const paths = [...new Set([...from.files.map((f) => f.path), ...to.map((f) => f.path)])]
    .filter((p) => from.files.find((f) => f.path === p)?.content !== to.find((f) => f.path === p)?.content);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5 text-[11px]">
        <span className="min-w-0 truncate">&ldquo;{from.label}&rdquo; <Icon name="chevronRight" size={9} /> now</span>
        {paths.length > 1 && (
          <select value={file ?? ""} onChange={(e) => setPicked(e.target.value)} className="os-input !w-auto !py-0.5 text-[10.5px]" aria-label="File to compare">
            {paths.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        {stats && <span className="os-chip !py-0 !text-[10px] tabular-nums">+{stats.added} -{stats.removed}</span>}
        <div className="flex-1" />
        <button className="os-btn !py-0.5 text-[10.5px]" data-variant="primary" disabled={busy} onClick={onRestore}>Restore this version</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 font-[family-name:var(--font-mono)] text-[10.5px] leading-[1.45]">
        {!file ? (
          <div className="p-3 text-[var(--muted)]">No differences: this version matches the current files.</div>
        ) : !d ? (
          <div className="p-3 text-[var(--muted)]">This change is too large to diff line by line here ({before.split("\n").length.toLocaleString()} and {after.split("\n").length.toLocaleString()} lines).</div>
        ) : (
          hunks(d, 3).map((l, i) =>
            l.op === "gap" ? (
              <div key={i} className="my-0.5 text-[var(--muted)]">··· {l.skipped} unchanged line{l.skipped === 1 ? "" : "s"}</div>
            ) : (
              <div
                key={i}
                className="whitespace-pre-wrap break-all px-1"
                style={{
                  background: l.op === "add" ? "color-mix(in srgb, var(--ok, #22c55e) 16%, transparent)" : l.op === "del" ? "color-mix(in srgb, var(--danger) 16%, transparent)" : undefined,
                }}
              >
                <span className="mr-1.5 select-none opacity-60">{l.op === "add" ? "+" : l.op === "del" ? "-" : " "}</span>{l.text || " "}
              </div>
            ),
          )
        )}
      </div>
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
    const out = await callTool(server, conn?.sessionId, tool, args, undefined, conn?.protocol);
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

  if (running) return <RunningApp app={running} onBack={() => setRunning(null)} onUpdated={(a) => setRunning(a)} />;

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

/** A library app running in its sandbox, with its console forwarded and a
 *  one-click AI repair that commits as a new, revertible version. */
function RunningApp({ app, onBack, onUpdated }: { app: UserApp; onBack: () => void; onUpdated: (a: UserApp) => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [runToken, setRunToken] = useState(`run_${app.id}_${app.updatedAt}`);
  const [log, setLog] = useState<Array<ConsoleEntry & { count: number }>>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [runKey, setRunKey] = useState(0);
  const doc = useMemo(
    () => injectBridge(app.html, runToken, typeof window === "undefined" ? "*" : window.location.origin),
    [app.html, runToken],
  );

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const entry = readBridge(e.data, runToken);
      if (entry) setLog((l) => pushConsole(l, entry));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [runToken]);

  const rerun = () => { setLog([]); setRunToken(uid("run")); setRunKey((k) => k + 1); };

  const fix = async () => {
    const detail = fixPrompt(log);
    if (!detail || busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await trackJob(
        { kind: "ai", title: `Fixing ${app.name}`, target: { appId: "studio", args: { tab: "library", runUserApp: app.id } } },
        async () => upgradeApp({ appId: app.id, intentId: "fix", detail }),
      );
      if (!r.ok) setNote(r.reason);
      else {
        setNote(`Saved as a new version (${r.changedFiles} file(s), $${r.costUsd.toFixed(4)}). The old one is under Versions.`);
        const next = useUserApps.getState().get(app.id);
        if (next) onUpdated(next);
        rerun();
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : "The fix failed.");
    } finally { setBusy(false); }
  };

  const errors = log.filter((e) => e.level === "error").reduce((a, e) => a + e.count, 0);
  const warns = log.filter((e) => e.level === "warn").reduce((a, e) => a + e.count, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
        <button className="os-btn !py-1 text-[11px]" onClick={onBack}>‹ Library</button>
        <Icon name={app.icon || "app"} size={13} style={{ color: "var(--accent)" }} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{app.name}</span>
        <button className="os-btn !py-1 text-[11px]" onClick={rerun} aria-label="Restart the app" title="Restart"><Icon name="refresh" size={11} /></button>
        <button className="os-btn !py-1 text-[11px]" onClick={() => download(`${app.name.replace(/\s+/g, "-")}.html`, app.html, "text/html")}>
          <Icon name="download" size={11} className="mr-1" />.html
        </button>
        {app.files && (
          <button className="os-btn !py-1 text-[11px]" onClick={() => downloadZip(app.name, app.files!)}>
            <Icon name="package" size={11} className="mr-1" />Export .zip
          </button>
        )}
      </div>
      {note && <p className="shrink-0 border-b border-[var(--border)] px-2.5 py-1 text-[10.5px] text-[var(--muted)]" role="status">{note}</p>}
      <iframe
        ref={iframeRef}
        key={runKey}
        srcDoc={doc}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className="min-h-0 flex-1 border-0 bg-white"
        title={app.name}
      />
      <ConsoleStrip
        entries={log} errors={errors} warns={warns} open={open} setOpen={setOpen} busy={busy}
        onFix={() => void fix()} onAutoFix={() => void fix()} onClear={() => setLog([])}
      />
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
