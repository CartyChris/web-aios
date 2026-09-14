"use client";

import { useCallback, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { useSettings } from "@/kernel/settings";
import { ask } from "@/lib/useAI";
import { extractCode } from "./IDE";
import type { AppProps } from "@/kernel/types";
import { uid, download, relTime } from "@/lib/format";
import { Tabs, ErrorNote, Empty, Spinner, CopyButton } from "./_ui";
import { TARGETS, getTarget, FILE_FORMAT, parseProjectFiles, mergeProject, type ProjectFile } from "@/lib/scaffold";
import { downloadZip } from "@/lib/zip";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/* ────────────────────────────────────────────────────────────────────────────
   HTML Studio — merged from NovaOS's App Studio and WebOS's HTML Studio.

   Generate a self-contained single-file app from a prompt, preview it, iterate
   on it with targeted passes (graphics / features / bugfix / custom — NovaOS's
   four prompts, which were the good idea in that file), then install it into
   this OS so it appears in your own library.
   ──────────────────────────────────────────────────────────────────────────── */

export interface UserApp {
  id: string;
  name: string;
  html: string;
  icon: string;
  createdAt: number;
  updatedAt: number;
}

interface StudioState {
  apps: UserApp[];
  install: (name: string, html: string, icon: string) => string;
  update: (id: string, html: string) => void;
  rename: (id: string, name: string, icon: string) => void;
  remove: (id: string) => void;
}

export const useStudio = create<StudioState>()(
  persist(
    (set) => ({
      apps: [],
      install: (name, html, icon) => {
        const id = uid("uapp");
        set((s) => ({ apps: [{ id, name, html, icon, createdAt: Date.now(), updatedAt: Date.now() }, ...s.apps] }));
        return id;
      },
      update: (id, html) => set((s) => ({ apps: s.apps.map((a) => (a.id === id ? { ...a, html, updatedAt: Date.now() } : a)) })),
      rename: (id, name, icon) => set((s) => ({ apps: s.apps.map((a) => (a.id === id ? { ...a, name, icon } : a)) })),
      remove: (id) => set((s) => ({ apps: s.apps.filter((a) => a.id !== id) })),
    }),
    { name: "webaios.studio.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const GENERATOR = `You are Web-AIOS App Studio. You produce complete, self-contained single-file HTML applications.

Hard requirements:
- ONE HTML document, fully self-contained. No build step, no external scripts, no CDN.
- Inline all CSS and JS. Works when opened straight from a file.
- Responsive: usable at 380px wide and at 1400px.
- Respect the host theme by reading CSS custom properties --bg, --text, --accent from the parent where sensible, with your own fallbacks.
- No network calls unless the app is explicitly about the network.
- Output ONLY the HTML document inside one fenced code block.`;

const PASSES: Record<string, string> = {
  graphics: "You are a frontend graphics specialist. Raise the visual quality: typography, spacing, colour, depth, motion. Keep every behaviour working. Output only the complete updated HTML.",
  features: "You are a product engineer. Add the features this app is obviously missing — progression, persistence, settings, keyboard support, whatever fits. Preserve existing controls. Output only the complete updated HTML.",
  bugfix: "You are a debugging engineer. Find and fix runtime errors, edge cases and crashes without changing features. State nothing; output only the complete fixed HTML.",
  mobile: "Make this work properly on a phone: touch targets at least 44px, no horizontal scroll at 380px, safe-area padding, no hover-only interactions. Keep desktop behaviour intact. Output only the complete updated HTML.",
};

export default function Studio({ args }: AppProps) {
  const studio = useStudio();
  const vfs = useVFS();
  const [tab, setTab] = useState("build");
  const [prompt, setPrompt] = useState("");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState("");
  const [running, setRunning] = useState<UserApp | null>(null);
  const [targetId, setTargetId] = useState("single-html");
  const [project, setProject] = useState<ProjectFile[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);

  // Launching from a desktop icon opens that app straight into its sandbox.
  const runArg = args?.runUserApp as string | undefined;
  const [ranArg, setRanArg] = useState<string | undefined>(undefined);
  if (runArg && runArg !== ranArg) {
    setRanArg(runArg);
    const target = studio.apps.find((a) => a.id === runArg);
    if (target) { setRunning(target); setTab("library"); }
  }

  const generate = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    const target = getTarget(targetId);
    setBusy("Generating"); setError(null); setStream("");
    try {
      if (target.id === "single-html") {
        const res = await ask({
          messages: [{ role: "user", content: prompt }],
          system: GENERATOR,
          maxTokens: 16000,
          onDelta: (_d, full) => setStream(full),
        });
        const code = extractCode(res.text);
        if (!code) throw new Error("No HTML document found in the response.");
        setHtml(code);
        setProject(null);
      } else {
        // Multi-file targets get a base scaffold that is always correct, and
        // the model only writes the application code on top of it.
        const res = await ask({
          messages: [{ role: "user", content: `Build: ${prompt}` }],
          system: `${target.brief}\n\n${FILE_FORMAT}\n\nThese files already exist and are correct — do NOT rewrite them: ${target.base(prompt.slice(0, 30)).map((f) => f.path).join(", ")}.\nAt minimum write: ${target.expects.join(", ")}.`,
          maxTokens: 24000,
          onDelta: (_d, full) => setStream(full),
        });
        const files = parseProjectFiles(res.text);
        if (!files.length) throw new Error("No files came back in the expected format. Try again, or use a stronger model.");
        const merged = mergeProject(target.base(prompt.slice(0, 30) || "app"), files);
        setProject(merged);
        setOpenFile(files[0]?.path ?? merged[0]?.path ?? null);
        setHtml("");
      }
      setStream("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally { setBusy(null); }
  }, [prompt, busy, targetId]);

  const exportProject = useCallback(() => {
    const target = getTarget(targetId);
    const name = prompt.split(/[.\n]/)[0].slice(0, 40) || "web-aios-project";
    if (project) {
      downloadZip(name.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-") || "project", project);
      return;
    }
    if (html) {
      downloadZip(name.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-") || "app", [
        { path: "index.html", content: html },
        ...target.base(name),
      ]);
    }
  }, [project, html, prompt, targetId]);

  const pass = useCallback(async (kind: string, custom?: string) => {
    if (!html || busy) return;
    setBusy(kind); setError(null); setStream("");
    try {
      const res = await ask({
        messages: [{ role: "user", content: html }],
        system: custom ?? PASSES[kind],
        maxTokens: 16000,
        onDelta: (_d, full) => setStream(full),
      });
      const code = extractCode(res.text);
      if (!code) throw new Error("No HTML document found in the response.");
      setHtml(code);
      setStream("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pass failed.");
    } finally { setBusy(null); }
  }, [html, busy]);

  const install = useCallback(() => {
    if (!html) return;
    const name = prompt.split(/[.\n]/)[0].slice(0, 40) || "Untitled app";
    const id = studio.install(name, html, "app");
    vfs.write(`/apps/${name.replace(/[^\w -]/g, "")}-${id}.html`, html, { appId: "studio" });
    bus.emit("notify", { title: `Installed "${name}"`, body: "Find it in the Library tab.", kind: "success" });
    setTab("library");
  }, [html, prompt, studio, vfs]);

  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[{ id: "build", label: "Build", icon: "studio" }, { id: "library", label: `Library (${studio.apps.length})`, icon: "app" }]}
        active={tab}
        onChange={setTab}
      />

      {tab === "build" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-[var(--border)] p-2.5">
            <ErrorNote error={error} onDismiss={() => setError(null)} />
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="os-label">Target</span>
              <select
                value={targetId}
                onChange={(e) => { setTargetId(e.target.value); setProject(null); setHtml(""); }}
                className="os-input !w-auto !py-1 text-[11px]"
              >
                {TARGETS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <span className="text-[10.5px] text-[var(--muted)]">{getTarget(targetId).blurb}</span>
            </div>
            <div className="mb-2 flex gap-1.5">
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && generate()}
                placeholder="Describe the app or game to build…"
                className="os-input flex-1 !py-1 text-[12px]"
              />
              <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={generate} disabled={!!busy || !prompt.trim()}>
                {busy === "Generating" ? "Generating…" : "Generate"}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {Object.keys(PASSES).map((k) => (
                <button key={k} className="os-btn !py-1 text-[11px]" onClick={() => pass(k)} disabled={!html || !!busy}>
                  {busy === k ? "…" : k}
                </button>
              ))}
              <button
                className="os-btn !py-1 text-[11px]"
                disabled={!html || !!busy}
                onClick={() => { const c = window.prompt("What should change?"); if (c) pass("custom", `Apply this change to the HTML app, keeping it self-contained: ${c}\n\nOutput only the complete updated HTML.`); }}
              >
                custom…
              </button>
              <div className="flex-1" />
              {busy && <Spinner label={`${stream.length.toLocaleString()} chars`} />}
              {html && (
                <>
                  <span className="os-chip">{(html.length / 1024).toFixed(1)} KB</span>
                  <CopyButton text={html} />
                  <button className="os-btn !py-1 text-[11px]" onClick={() => download("app.html", html, "text/html")}>Download .html</button>
                  <button className="os-btn !py-1 text-[11px]" onClick={exportProject}>Export .zip</button>
                  <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={install}>Install</button>
                </>
              )}
              {project && (
                <>
                  <span className="os-chip">{project.length} files</span>
                  <span className="os-chip">{(project.reduce((a, f) => a + f.content.length, 0) / 1024).toFixed(1)} KB</span>
                  <button
                    className="os-btn !py-1 text-[11px]"
                    onClick={() => {
                      const root = `/projects/${(prompt.split(/[.\n]/)[0] || "project").replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-")}`;
                      for (const f of project) vfs.write(`${root}/${f.path}`, f.content, { appId: "studio" });
                      bus.emit("notify", { title: `Saved ${project.length} files to ${root}`, kind: "success" });
                    }}
                  >
                    Save to Files
                  </button>
                  <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={exportProject}>Export .zip</button>
                </>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 grid grid-cols-1 lg:grid-cols-2">
            {project ? (
              <div className="flex min-h-0">
                <div className="w-48 shrink-0 overflow-y-auto border-r border-[var(--border)] p-1.5">
                  <div className="os-label mb-1 px-1">Project</div>
                  {project.map((f) => (
                    <button
                      key={f.path}
                      onClick={() => setOpenFile(f.path)}
                      className={cn("mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-[11px]", openFile === f.path ? "bg-[var(--accent)]/16" : "hover:bg-white/6")}
                      title={f.path}
                    >
                      {f.path}
                    </button>
                  ))}
                </div>
                <textarea
                  value={busy ? stream : project.find((f) => f.path === openFile)?.content ?? ""}
                  onChange={(e) => setProject(project.map((f) => (f.path === openFile ? { ...f, content: e.target.value } : f)))}
                  readOnly={!!busy}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none bg-transparent p-2.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] outline-none"
                />
              </div>
            ) : (
              <textarea
                value={busy ? stream : html}
                onChange={(e) => setHtml(e.target.value)}
                readOnly={!!busy}
                spellCheck={false}
                placeholder="Generated code appears here and stays editable."
                className="min-h-0 resize-none bg-transparent p-2.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.5] outline-none"
              />
            )}
            <div className="min-h-0 border-l border-[var(--border)]">
              {html ? (
                <iframe srcDoc={html} sandbox="allow-scripts allow-forms allow-modals" className="h-full w-full border-0 bg-white" title="App preview" />
              ) : project ? (
                <div className="h-full overflow-y-auto p-4">
                  <div className="mb-3 font-medium text-[13px]">{getTarget(targetId).name}</div>
                  <p className="mb-3 text-[12px] leading-relaxed text-[var(--muted)]">
                    A real project, not a preview. It carries no Web-AIOS dependency — export it, run it, open it in any editor.
                  </p>
                  <div className="os-card mb-3">
                    <div className="os-label mb-1">Run it</div>
                    <pre className="whitespace-pre-wrap font-[family-name:var(--font-mono)] text-[11px]">{getTarget(targetId).run}</pre>
                  </div>
                  <div className="os-label mb-1">{project.length} files</div>
                  <div className="space-y-0.5 font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--muted)]">
                    {project.map((f) => (
                      <div key={f.path} className="flex justify-between gap-3">
                        <span className="truncate">{f.path}</span>
                        <span className="shrink-0">{(f.content.length / 1024).toFixed(1)} KB</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <Empty icon="app" title="Nothing built yet" body="Pick a target, describe what you want, and build. Single HTML gives you one self-contained file; every other target gives you a real project you can npm install and take anywhere." />
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "library" && (
        running ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
              <button className="os-btn !py-1 text-[11px]" onClick={() => setRunning(null)}>‹ Library</button>
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{running.icon} {running.name}</span>
              <button className="os-btn !py-1 text-[11px]" onClick={() => { setHtml(running.html); setRunning(null); setTab("build"); }}>Edit</button>
            </div>
            <iframe srcDoc={running.html} sandbox="allow-scripts allow-forms allow-modals" className="min-h-0 flex-1 border-0 bg-white" title={running.name} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {studio.apps.length === 0 ? (
              <Empty icon="app" title="No installed apps" body="Build something on the Build tab and press Install. Installed apps run sandboxed inside this OS." />
            ) : (
              <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
                {studio.apps.map((a) => (
                  <div key={a.id} className="os-card">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <span className="text-lg">{a.icon}</span>
                      <input
                        value={a.name}
                        onChange={(e) => studio.rename(a.id, e.target.value, a.icon)}
                        className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium outline-none"
                      />
                    </div>
                    <div className="mb-2 text-[10px] text-[var(--muted)]">{(a.html.length / 1024).toFixed(1)} KB · {relTime(a.updatedAt)}</div>
                    <div className="flex flex-wrap gap-1">
                      <button className="os-btn !px-2 !py-0.5 text-[10.5px]" data-variant="primary" onClick={() => setRunning(a)}>Run</button>
                      <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => { setHtml(a.html); setTab("build"); }}>Edit</button>
                      <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => download(`${a.name}.html`, a.html, "text/html")}>Save</button>
                      <button
                        className="os-btn !px-2 !py-0.5 text-[10.5px]"
                        title="Pin this app to the desktop"
                        onClick={() => {
                          useSettings.getState().addDesktopItem({ kind: "userapp", ref: a.id, x: 140, y: 70 });
                          bus.emit("notify", { title: `Pinned "${a.name}" to the desktop`, kind: "success" });
                        }}
                      >
                        Pin
                      </button>
                      <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => studio.remove(a.id)}><Icon name="close" size={11} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}
