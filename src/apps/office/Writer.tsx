"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { toHtml, toDocx, toOdt, toMarkdown, fromMarkdown, fromDocx, fromOdt, wordCount, docText, type Doc } from "@/lib/office/doc";
import { parseDoc } from "@/lib/office/files";
import { WRITER_ACTIONS, TRANSLATE_TO, EDIT_SYSTEM, writerPrompt, cleanReply } from "@/lib/office/ai";
import { useOfficeFile, FileBar, AiPanel, TB, useAiCall, pickFile, unzipPackage, downloadPackage, downloadBytes, printHtml, MIME } from "./common";
import { domToDoc, htmlToDoc } from "./dom";
import { cn } from "@/lib/cn";

/* Writer: a word processor. The page is contentEditable; the document is the
   block model in lib/office/doc.ts, rebuilt from the page on every edit and
   stored as JSON in the OS filesystem. Real .docx and .odt go in and out;
   PDF is the browser's print-to-PDF. AI edits apply to the selection (or
   write at the caret) using the model chosen in Settings. */

const blank = (): Doc => ({ title: "Untitled", blocks: [{ t: "h", level: 1, runs: [{ text: "Untitled document" }] }, { t: "p", runs: [] }] });

const STYLES: Array<[string, string]> = [["p", "Body text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["h4", "Heading 4"], ["blockquote", "Quote"], ["pre", "Code block"]];
const FONTS = ["Georgia, serif", "system-ui, sans-serif", "'Times New Roman', serif", "Inter, system-ui, sans-serif", "'Courier New', monospace"];
const COLORS = ["#111111", "#c0392b", "#d35400", "#b7950b", "#1e8449", "#1f618d", "#7d3c98", "#566573"];

const exec = (cmd: string, value?: string) => document.execCommand(cmd, false, value);

export default function Writer({ args }: AppProps) {
  const f = useOfficeFile("writer", args, parseDoc, blank);
  const ai = useAiCall();
  const page = useRef<HTMLDivElement>(null);
  // Open by default where there is room; on a phone the document comes first.
  const [showAi, setShowAi] = useState(() => typeof window === "undefined" || window.innerWidth >= 700);
  const [showNav, setShowNav] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [font, setFont] = useState(FONTS[0]);
  const [paper, setPaper] = useState<"white" | "theme">("white");
  const [find, setFind] = useState<null | { q: string; r: string; n: number | null }>(null);
  const [block, setBlock] = useState("p");
  const [translateTo, setTranslateTo] = useState("Spanish");

  // Render the stored document into the page when a file opens -- and only
  // then: re-rendering on every keystroke would throw the caret away.
  const renderedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!page.current || renderedFor.current === f.path) return;
    renderedFor.current = f.path;
    page.current.innerHTML = toHtml(f.data);
  }, [f.path, f.data]);

  const sync = useCallback(() => {
    if (!page.current) return;
    const d = domToDoc(page.current, f.name);
    f.update(d);
  }, [f]);

  const onInput = () => sync();

  const onPaste = (e: React.ClipboardEvent) => {
    const html = e.clipboardData.getData("text/html");
    if (!html) return; // plain text pastes as plain text by itself
    e.preventDefault();
    exec("insertHTML", toHtml(htmlToDoc(html)));
    sync();
  };

  // Keep the block-style menu in step with where the caret is.
  useEffect(() => {
    const onSel = () => {
      const s = document.getSelection();
      if (!s?.anchorNode || !page.current?.contains(s.anchorNode)) return;
      let n: Node | null = s.anchorNode;
      while (n && n !== page.current) {
        if (n.nodeType === 1) {
          const t = (n as HTMLElement).tagName.toLowerCase();
          if (["h1", "h2", "h3", "h4", "blockquote", "pre", "p"].includes(t)) { setBlock(t); return; }
        }
        n = n.parentNode;
      }
      setBlock("p");
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const cmd = (c: string, v?: string) => { page.current?.focus(); exec(c, v); sync(); };

  const insertTable = () => {
    const rows = 3, cols = 3;
    cmd("insertHTML", `<table>${Array.from({ length: rows }, (_, r) => `<tr>${Array.from({ length: cols }, () => (r ? "<td>&nbsp;</td>" : "<th>Header</th>")).join("")}</tr>`).join("")}</table><p><br></p>`);
  };
  const insertImage = async () => {
    const file = await pickFile("image/png,image/jpeg,image/gif,image/webp");
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { ai.setError("Images are limited to 4 MB so the document stays quick to save."); return; }
    const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
    cmd("insertImage", url);
  };
  const insertLink = () => {
    const url = window.prompt("Link address (https://...)");
    if (url && /^(https?:|mailto:)/i.test(url)) cmd("createLink", url);
  };

  /* ── AI ── */

  const selection = (): { range: Range; text: string } | null => {
    const s = document.getSelection();
    if (!s || !s.rangeCount || !page.current) return null;
    const range = s.getRangeAt(0);
    if (!page.current.contains(range.commonAncestorContainer)) return null;
    return { range, text: s.toString() };
  };

  const applyResult = (result: string, range: Range | null) => {
    const clean = cleanReply(result);
    page.current?.focus();
    const s = document.getSelection();
    if (range && s) { s.removeAllRanges(); s.addRange(range); }
    else if (s && page.current && !page.current.contains(s.anchorNode)) {
      const r = document.createRange();
      r.selectNodeContents(page.current);
      r.collapse(false);
      s.removeAllRanges();
      s.addRange(r);
    }
    // Structured replies (headings, lists) go in as blocks; plain text keeps the paragraph it lands in.
    if (/^(#{1,4}\s|[-*]\s|\d+\.\s|>\s)/m.test(clean) || clean.includes("\n\n")) exec("insertHTML", toHtml(fromMarkdown(clean)));
    else exec("insertText", clean);
    sync();
  };

  const runAction = async (instruction: string, needsSelection: boolean, name: string) => {
    const sel = selection();
    const text = sel?.text.trim() ? sel.text : "";
    if (needsSelection && !text) { ai.setError("Select some text first."); return; }
    const all = docText(f.data);
    const input = text || all.slice(-6000);
    const reply = await ai.run(EDIT_SYSTEM, writerPrompt(instruction, input, text ? all : ""), { name: `writer.${name}` });
    if (reply === null) return;
    if (!text && sel) sel.range.collapse(false);
    applyResult(reply, text ? sel!.range : sel?.range ?? null);
  };

  const freeForm = async (request: string) => {
    const sel = selection();
    const text = sel?.text.trim() ? sel.text : "";
    const prompt = text
      ? writerPrompt(request, text, docText(f.data))
      : `${request}\n\nWrite it as document text (Markdown for headings and lists). The document so far, for context:\n"""\n${docText(f.data).slice(-6000)}\n"""`;
    const reply = await ai.run(EDIT_SYSTEM, prompt, { name: "writer.ask" });
    if (reply !== null) applyResult(reply, sel?.range ?? null);
  };

  /* ── find and replace (text nodes only, so formatting survives) ── */

  const doFind = (replaceAll: boolean) => {
    if (!find?.q || !page.current) return;
    const walker = document.createTreeWalker(page.current, NodeFilter.SHOW_TEXT);
    let count = 0;
    const re = new RegExp(find.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? "";
      const m = t.match(re);
      if (!m) continue;
      count += m.length;
      if (replaceAll) n.textContent = t.replace(re, find.r);
    }
    setFind({ ...find, n: count });
    if (replaceAll) sync();
  };

  /* ── import / export ── */

  const importFile = async (kind: "docx" | "odt" | "md" | "html") => {
    const accept = { docx: ".docx", odt: ".odt", md: ".md,.markdown,.txt", html: ".html,.htm" }[kind];
    const file = await pickFile(accept);
    if (!file) return;
    const title = file.name.replace(/\.[^.]+$/, "");
    let doc: Doc;
    if (kind === "docx") doc = fromDocx(await unzipPackage(file), title);
    else if (kind === "odt") doc = fromOdt(await unzipPackage(file), title);
    else if (kind === "html") doc = htmlToDoc(await file.text(), title);
    else doc = fromMarkdown(await file.text(), title);
    renderedFor.current = undefined;
    f.createNew(parseDoc(doc), title);
  };

  const base = f.name.replace(/[^\w .-]/g, "_") || "document";
  const exportsMenu = [
    { id: "docx", label: "Word document (.docx)", run: () => downloadPackage(`${base}.docx`, toDocx({ ...f.data, title: f.name }, { when: new Date().toISOString() }), MIME.docx) },
    { id: "odt", label: "OpenDocument text (.odt)", run: () => downloadPackage(`${base}.odt`, toOdt({ ...f.data, title: f.name }, { when: new Date().toISOString() }), MIME.odt) },
    { id: "pdf", label: "PDF (print, then Save as PDF)", run: () => printHtml(toHtml({ ...f.data, title: f.name }, { standalone: true })) },
    { id: "html", label: "Web page (.html)", run: () => downloadBytes(`${base}.html`, toHtml({ ...f.data, title: f.name }, { standalone: true }), "text/html") },
    { id: "md", label: "Markdown (.md)", run: () => downloadBytes(`${base}.md`, toMarkdown(f.data), "text/markdown") },
    { id: "txt", label: "Plain text (.txt)", run: () => downloadBytes(`${base}.txt`, docText(f.data), "text/plain") },
  ];
  const importsMenu = [
    { id: "docx", label: "Word document (.docx)", run: () => importFile("docx") },
    { id: "odt", label: "OpenDocument text (.odt)", run: () => importFile("odt") },
    { id: "md", label: "Markdown or text", run: () => importFile("md") },
    { id: "html", label: "Web page (.html)", run: () => importFile("html") },
  ];

  const stats = useMemo(() => wordCount(f.data), [f.data]);
  const headings = f.data.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.t === "h") as Array<{ b: Extract<Doc["blocks"][number], { t: "h" }>; i: number }>;

  const jumpTo = (idx: number) => {
    const hs = page.current?.querySelectorAll("h1,h2,h3,h4");
    const k = headings.findIndex((h) => h.i === idx);
    hs?.[k]?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="flex h-full flex-col" data-office="writer">
      <FileBar
        icon="writer" name={f.name} savedAt={f.savedAt} onRename={f.rename} files={f.files} current={f.path}
        onOpen={(p) => { renderedFor.current = undefined; f.open(p); }}
        onNew={() => { renderedFor.current = undefined; f.createNew(); }}
        imports={importsMenu} exports={exportsMenu}
        extra={<>
          <TB label="Navigator" icon="layout" active={showNav} onClick={() => setShowNav((v) => !v)} />
          <TB label="AI assistant" icon="sparkles" active={showAi} onClick={() => setShowAi((v) => !v)} />
        </>}
      />
      <div className="os-office-toolbar flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1" role="toolbar" aria-label="Formatting">
        <TB label="Undo" text="Undo" onClick={() => cmd("undo")} />
        <TB label="Redo" text="Redo" onClick={() => cmd("redo")} />
        <select className="os-input !w-auto !py-0.5 text-[11.5px]" value={block} onChange={(e) => { setBlock(e.target.value); cmd("formatBlock", e.target.value); }} aria-label="Paragraph style">
          {STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="os-input !w-auto !py-0.5 text-[11.5px]" value={font} onChange={(e) => setFont(e.target.value)} aria-label="Page font">
          {FONTS.map((x) => <option key={x} value={x}>{x.split(",")[0].replace(/'/g, "")}</option>)}
        </select>
        <TB label="Bold" text="B" className="font-bold" onClick={() => cmd("bold")} />
        <TB label="Italic" text="I" className="italic" onClick={() => cmd("italic")} />
        <TB label="Underline" text="U" className="underline" onClick={() => cmd("underline")} />
        <TB label="Strikethrough" text="S" className="line-through" onClick={() => cmd("strikeThrough")} />
        <TB label="Inline code" text="</>" onClick={() => { const s = document.getSelection()?.toString(); if (s) cmd("insertHTML", `<code>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code>`); }} />
        <span className="flex items-center gap-0.5" aria-label="Text colour">
          {COLORS.map((c) => <button key={c} className="h-4 w-4 rounded-sm border border-white/20" style={{ background: c }} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("foreColor", c)} aria-label={`Text colour ${c}`} title={c} />)}
        </span>
        <TB label="Align left" text="Left" onClick={() => cmd("justifyLeft")} />
        <TB label="Centre" text="Centre" onClick={() => cmd("justifyCenter")} />
        <TB label="Align right" text="Right" onClick={() => cmd("justifyRight")} />
        <TB label="Justify" text="Justify" onClick={() => cmd("justifyFull")} />
        <TB label="Bulleted list" text="List" onClick={() => cmd("insertUnorderedList")} />
        <TB label="Numbered list" text="1. List" onClick={() => cmd("insertOrderedList")} />
        <TB label="Indent" text="Indent" onClick={() => cmd("indent")} />
        <TB label="Outdent" text="Outdent" onClick={() => cmd("outdent")} />
        <TB label="Link" icon="link" onClick={insertLink} />
        <TB label="Insert table" text="Table" onClick={insertTable} />
        <TB label="Insert image" icon="image" onClick={() => void insertImage()} />
        <TB label="Horizontal rule" text="Rule" onClick={() => cmd("insertHorizontalRule")} />
        <TB label="Page break" text="Break" onClick={() => cmd("insertHTML", `<div style="page-break-after:always" data-pagebreak="1" class="os-pagebreak"></div><p><br></p>`)} />
        <TB label="Clear formatting" text="Clear" onClick={() => cmd("removeFormat")} />
        <TB label="Find and replace" icon="search" active={!!find} onClick={() => setFind(find ? null : { q: "", r: "", n: null })} />
        <select className="os-input !w-auto !py-0.5 text-[11.5px]" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom">
          {[0.75, 0.9, 1, 1.15, 1.3, 1.5].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
        </select>
        <TB label={paper === "white" ? "Dark page" : "White page"} text={paper === "white" ? "Dark page" : "White page"} onClick={() => setPaper((p) => (p === "white" ? "theme" : "white"))} />
      </div>
      {find && (
        <form className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1 text-[11.5px]" onSubmit={(e) => { e.preventDefault(); doFind(false); }}>
          <input className="os-input !w-40 !py-0.5" placeholder="Find" value={find.q} onChange={(e) => setFind({ ...find, q: e.target.value, n: null })} aria-label="Find" autoFocus />
          <input className="os-input !w-40 !py-0.5" placeholder="Replace with" value={find.r} onChange={(e) => setFind({ ...find, r: e.target.value })} aria-label="Replace with" />
          <button className="os-btn !py-0.5" type="submit">Count</button>
          <button className="os-btn !py-0.5" type="button" onClick={() => doFind(true)} disabled={!find.q}>Replace all</button>
          {find.n !== null && <span className="text-[var(--muted)]" aria-live="polite">{find.n} match{find.n === 1 ? "" : "es"}</span>}
        </form>
      )}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {showNav && (
          <nav className="max-h-40 shrink-0 overflow-y-auto border-b border-[var(--border)] p-2 text-[11.5px] sm:max-h-none sm:w-44 sm:border-b-0 sm:border-r" aria-label="Headings">
            <div className="os-label mb-1">Navigator</div>
            {headings.length ? headings.map(({ b, i }) => (
              <button key={i} className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-[var(--hover)]" style={{ paddingLeft: `${(b.level - 1) * 10 + 4}px` }} onClick={() => jumpTo(i)}>{b.runs.map((r) => r.text).join("") || "(empty heading)"}</button>
            )) : <div className="text-[var(--muted)]">No headings yet.</div>}
          </nav>
        )}
        <div className="min-h-0 flex-1 overflow-auto bg-black/20 p-3 sm:p-6" onClick={(e) => { if (e.target === e.currentTarget) page.current?.focus(); }}>
          <div
            ref={page}
            className={cn("os-writer-page mx-auto min-h-full max-w-[816px] rounded-sm px-6 py-8 shadow-2xl outline-none sm:px-[72px] sm:py-[72px]", paper === "white" ? "bg-white text-[#1a1a1a]" : "bg-[var(--panel-solid)] text-[var(--text)]")}
            style={{ fontFamily: font, fontSize: `${16 * zoom}px`, lineHeight: 1.6 }}
            contentEditable
            suppressContentEditableWarning
            spellCheck
            role="textbox"
            aria-multiline="true"
            aria-label={`Document: ${f.name}`}
            onInput={onInput}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "b") { e.preventDefault(); cmd("bold"); }
              if ((e.metaKey || e.ctrlKey) && e.key === "i") { e.preventDefault(); cmd("italic"); }
              if ((e.metaKey || e.ctrlKey) && e.key === "u") { e.preventDefault(); cmd("underline"); }
              if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); setFind({ q: document.getSelection()?.toString() ?? "", r: "", n: null }); }
            }}
          />
        </div>
        {showAi && (
          <AiPanel
            title="Writing assistant"
            busy={ai.busy} error={ai.error} partial={ai.partial} provider={ai.provider} model={ai.model} onStop={ai.stop}
            placeholder="Ask for anything: draft a section, rewrite the selection..."
            onFree={(t) => void freeForm(t)}
            actions={[
              ...WRITER_ACTIONS.map((a) => ({ id: a.id, label: a.label, run: () => void runAction(a.instruction, a.needsSelection, a.id) })),
              { id: "translate", label: `Translate to ${translateTo}`, run: () => void runAction(`Translate this into ${translateTo}. Keep formatting.`, true, "translate") },
            ]}
          >
            <label className="text-[11px] text-[var(--muted)]">
              Translate to{" "}
              <select className="os-input !w-auto !py-0.5 text-[11px]" value={translateTo} onChange={(e) => setTranslateTo(e.target.value)}>
                {TRANSLATE_TO.map((l) => <option key={l}>{l}</option>)}
              </select>
            </label>
            <p className="text-[10.5px] leading-snug text-[var(--muted)]">Select text for the rewrite actions; with nothing selected, a request writes at the caret. Undo reverses any AI edit.</p>
          </AiPanel>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-[var(--border)] px-2 py-0.5 text-[10.5px] text-[var(--muted)]" data-writer-status>
        <span>{stats.words} words</span>
        <span>{stats.chars} characters</span>
        <span>{f.data.blocks.filter((b) => b.t === "pagebreak").length + 1} section{f.data.blocks.some((b) => b.t === "pagebreak") ? "s" : ""}</span>
      </div>
    </div>
  );
}
