"use client";

import { useCallback, useRef, useState } from "react";
import { useSettings, resolveTokens } from "@/kernel/settings";
import { useCustomWidgets, widgetDocument, widgetStandalone, type CustomWidget } from "@/kernel/widgets";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import { extractCode } from "./IDE";
import { relTime } from "@/lib/format";
import { downloadZip } from "@/lib/zip";
import { ErrorNote, Spinner, Empty, CopyButton } from "./_ui";
import { Icon } from "@/shell/icons";

/* Describe a widget; the model writes it; it runs sandboxed on your desktop,
 * and leaves as a standalone file you can open or edit anywhere. */

const SYSTEM = `You write small, self-contained desktop widgets.

Output ONLY an HTML fragment inside one fenced code block — the markup, a <style> block, and a <script> block. No <html>, <head> or <body> tags; the host supplies those.

Hard requirements:
- Self-contained. No external scripts, stylesheets, fonts or images. No network requests unless the widget is explicitly about fetching something the user named.
- Theme-aware: use the CSS custom properties --bg, --panel-solid, --text, --muted, --accent, --accent2, --border, --radius. Never hard-code colours; the host restyles these when the user changes theme.
- Fits a small box (roughly 260x170 by default) with no scrollbars at that size. Use the full height.
- Transparent background — the host card already provides one.
- Degrade honestly: if something cannot work offline, show what it can and say what is missing rather than faking data.
- Plain JS only. It runs in a sandboxed frame with no access to the host page, so do not attempt to reach parent, localStorage, or cookies — use in-memory state.`;

const EXAMPLES = [
  "A countdown to a date I set, with a ring that empties as it approaches",
  "A pomodoro timer with start/pause and a session counter",
  "A unit converter for metric and imperial, typing in either side",
  "Today's date as a big number with the week number beneath",
  "A dice roller for tabletop games: d4 through d20, with a roll history",
  "A colour palette generator that shows five swatches and their hex codes",
  "A breathing pacer: a circle that expands 4s, holds 4s, contracts 4s",
  "A tally counter with plus, minus and reset",
];

export function WidgetBuilder() {
  const settings = useSettings();
  const store = useCustomWidgets();
  const vfs = useVFS();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ html: string; name: string } | null>(null);
  const [stream, setStream] = useState("");
  const [editing, setEditing] = useState<CustomWidget | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const generate = useCallback(async (instruction?: string, base?: string) => {
    const p = (instruction ?? prompt).trim();
    if (!p || busy) return;
    setBusy(true); setError(null); setStream("");
    try {
      const res = await ask({
        messages: [{ role: "user", content: base ? `Current widget:\n\`\`\`html\n${base}\n\`\`\`\n\nChange it: ${p}` : p }],
        system: SYSTEM,
        maxTokens: 4000,
        onDelta: (_d, full) => setStream(full),
      });
      const code = extractCode(res.text);
      if (!code) throw new Error("No HTML block came back. Try rephrasing, or use a stronger model.");
      setDraft({ html: code, name: p.slice(0, 40) });
      setStream("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally { setBusy(false); }
  }, [prompt, busy]);

  const save = useCallback(() => {
    if (!draft) return;
    if (editing) {
      store.update(editing.id, { html: draft.html, prompt });
      bus.emit("notify", { title: `Updated "${editing.name}"`, kind: "success" });
      setEditing(null);
    } else {
      const id = store.add({ name: draft.name || "Widget", prompt, html: draft.html, icon: "widgets", w: 260, h: 170 });
      settings.addWidget("custom");
      // The newest placed widget is the one we just created; point it at the
      // custom definition so it renders rather than showing "unknown widget".
      const placed = useSettings.getState().widgets;
      const last = placed[placed.length - 1];
      if (last) {
        useSettings.setState({
          widgets: placed.map((w) => (w.id === last.id ? { ...w, customId: id, w: 260, h: 170 } : w)),
        });
      }
      bus.emit("notify", { title: "Widget placed on the desktop", kind: "success" });
    }
    setDraft(null);
    setPrompt("");
  }, [draft, editing, prompt, store, settings]);

  const exportWidget = useCallback((w: CustomWidget) => {
    const tokens = resolveTokens(settings);
    downloadZip(`${w.name.replace(/[^\w -]/g, "").trim() || "widget"}-widget`, [
      { path: "widget.html", content: widgetStandalone(w, tokens) },
      { path: "widget.json", content: JSON.stringify({ __webaios_widget: 1, widget: w }, null, 2) },
      { path: "fragment.html", content: w.html },
      {
        path: "README.md",
        content: `# ${w.name}

Exported from Web-AIOS on ${new Date().toISOString()}.

**Built from the prompt:** ${w.prompt || "(none recorded)"}

## What is in here

| File | What it is |
| --- | --- |
| \`widget.html\` | Standalone. Open it in any browser, or host it anywhere. |
| \`fragment.html\` | Just the markup, styles and script — paste into your own page. |
| \`widget.json\` | Re-importable into Web-AIOS (Personalize → Widgets → Import). |

## Embedding it

\`\`\`html
<iframe src="widget.html" style="width:260px;height:170px;border:0" sandbox="allow-scripts"></iframe>
\`\`\`

## Theming

It reads CSS custom properties, so it follows whatever palette the page around
it defines: \`--bg\`, \`--panel-solid\`, \`--text\`, \`--muted\`, \`--accent\`,
\`--accent2\`, \`--border\`, \`--radius\`. The standalone file has the palette it
was exported with baked into \`:root\` — override those to restyle it.
`,
      },
    ]);
  }, [settings]);

  const preview = draft ? widgetDocument(draft.html, resolveTokens(settings)) : "";

  return (
    <div className="max-w-3xl">
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="os-card mb-3">
        <div className="mb-1.5 flex items-center gap-2">
          <Icon name="spark" size={14} className="text-[var(--accent)]" />
          <span className="font-medium text-[13px]">{editing ? `Refining "${editing.name}"` : "Describe a widget"}</span>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate(undefined, editing?.html); }}
          rows={2}
          placeholder="e.g. a dice roller for d4 through d20 with a roll history"
          className="os-input mb-2 resize-none text-[12px]"
        />
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={() => generate(undefined, editing?.html)} disabled={busy || !prompt.trim()}>
            {busy ? "Building…" : editing ? "Apply change" : "Build widget"}
          </button>
          {busy && <Spinner label={`${stream.length.toLocaleString()} chars`} />}
          {editing && <button className="os-btn !py-1 text-[11px]" onClick={() => { setEditing(null); setDraft(null); setPrompt(""); }}>Cancel</button>}
          <div className="flex-1" />
          <button className="os-btn !py-1 text-[11px]" onClick={() => importRef.current?.click()}>Import…</button>
          <input
            ref={importRef} type="file" accept="application/json" hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                const r = store.importOne(await f.text());
                if (r.ok) bus.emit("notify", { title: "Widget imported", kind: "success" });
                else setError(r.error ?? "Import failed.");
              }
              e.target.value = "";
            }}
          />
        </div>
        {!draft && !busy && (
          <div className="flex flex-wrap gap-1">
            {EXAMPLES.map((x) => (
              <button key={x} className="os-btn !px-2 !py-0.5 !text-[10.5px]" onClick={() => { setPrompt(x); generate(x, editing?.html); }}>
                {x.length > 44 ? x.slice(0, 42) + "…" : x}
              </button>
            ))}
          </div>
        )}
      </div>

      {draft && (
        <div className="os-card mb-3" style={{ borderColor: "var(--accent)" }}>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="os-label">Preview</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="os-input !w-48 !py-0.5 text-[11px]"
              placeholder="Widget name"
            />
            <div className="flex-1" />
            <CopyButton text={draft.html} label="Copy HTML" />
            <button className="os-btn !py-1 text-[11px]" onClick={() => setDraft(null)}>Discard</button>
            <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={save}>
              {editing ? "Save changes" : "Place on desktop"}
            </button>
          </div>
          <div className="mx-auto overflow-hidden rounded-[var(--radius)] border border-[var(--border)]" style={{ width: 264, height: 174, background: "var(--panel)" }}>
            <iframe srcDoc={preview} sandbox="allow-scripts" title="Widget preview" className="h-full w-full border-0" />
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-[var(--muted)]">Edit the code by hand</summary>
            <textarea
              value={draft.html}
              onChange={(e) => setDraft({ ...draft, html: e.target.value })}
              rows={10}
              spellCheck={false}
              className="os-input mt-1.5 resize-y font-[family-name:var(--font-mono)] text-[11px]"
            />
          </details>
        </div>
      )}

      <div className="os-label mb-1.5">Your widgets ({store.widgets.length})</div>
      {store.widgets.length === 0 ? (
        <Empty icon="widgets" title="None yet" body="Describe one above. It runs sandboxed — a generated widget cannot read this page, its storage, or your API keys." />
      ) : (
        <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
          {store.widgets.map((w) => (
            <div key={w.id} className="os-card">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Icon name="widgets" size={13} className="text-[var(--accent)]" />
                <input
                  value={w.name}
                  onChange={(e) => store.update(w.id, { name: e.target.value })}
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium outline-none"
                />
              </div>
              <div className="mb-2 overflow-hidden rounded border border-[var(--border)]" style={{ height: 110 }}>
                <iframe
                  srcDoc={widgetDocument(w.html, resolveTokens(settings))}
                  sandbox="allow-scripts"
                  title={w.name}
                  className="h-full w-full border-0"
                />
              </div>
              <div className="mb-1.5 text-[10px] text-[var(--muted)]">{relTime(w.updatedAt)}</div>
              <div className="flex flex-wrap gap-1">
                <button
                  className="os-btn !px-2 !py-0.5 text-[10.5px]"
                  onClick={() => {
                    const id = settings.addWidget("custom");
                    const placed = useSettings.getState().widgets;
                    const last = placed[placed.length - 1];
                    if (last) {
                      useSettings.setState({ widgets: placed.map((x) => (x.id === last.id ? { ...x, customId: w.id, w: w.w, h: w.h } : x)) });
                    }
                    void id;
                    bus.emit("notify", { title: `Placed "${w.name}"`, kind: "success" });
                  }}
                >
                  Place
                </button>
                <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => { setEditing(w); setDraft({ html: w.html, name: w.name }); setPrompt(""); }}>Refine</button>
                <button className="os-btn !px-2 !py-0.5 text-[10.5px]" onClick={() => exportWidget(w)}>Export</button>
                <button
                  className="os-btn !px-2 !py-0.5 text-[10.5px]"
                  onClick={() => { vfs.write(`/widgets/${w.name.replace(/[^\w -]/g, "")}.html`, widgetStandalone(w, resolveTokens(settings)), { appId: "widgets" }); bus.emit("notify", { title: "Saved to Files", kind: "success" }); }}
                >
                  Save
                </button>
                <button
                  className="os-btn !px-2 !py-0.5 text-[10.5px]"
                  onClick={() => {
                    store.remove(w.id);
                    // Remove any placed instances too, or they render as tombstones.
                    useSettings.setState({ widgets: useSettings.getState().widgets.filter((x) => x.customId !== w.id) });
                  }}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="os-card mt-3 text-[11.5px] leading-relaxed text-[var(--muted)]">
        <b className="text-[var(--text)]">How these run.</b> Each widget is an isolated document with
        <code className="mx-1">allow-scripts</code> but not <code className="mx-1">allow-same-origin</code>, which puts it
        in an opaque origin: it can run its own code and nothing else. It cannot read this page, its storage, or the API
        keys kept there. Export gives you a standalone HTML file plus the re-importable definition.
      </div>
      <div className="mt-2">
        <button
          className="os-btn !py-1 text-[11px]"
          disabled={!store.widgets.length}
          onClick={() => {
            const tokens = resolveTokens(settings);
            downloadZip(`web-aios-widgets-${new Date().toISOString().slice(0, 10)}`, [
              ...store.widgets.flatMap((w) => {
                const slug = w.name.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-") || w.id;
                return [
                  { path: `${slug}/widget.html`, content: widgetStandalone(w, tokens) },
                  { path: `${slug}/widget.json`, content: JSON.stringify({ __webaios_widget: 1, widget: w }, null, 2) },
                ];
              }),
              { path: "README.md", content: `# Web-AIOS widgets\n\n${store.widgets.length} widget(s), exported ${new Date().toISOString()}.\n\nEach folder holds a standalone \`widget.html\` you can open anywhere and a \`widget.json\` you can import back into Web-AIOS.\n` },
            ]);
          }}
        >
          Export all widgets (.zip)
        </button>
      </div>
    </div>
  );
}
