"use client";

import { useEffect, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { fromOutline, toOutline, toPptx, fromPptx, toOdp, fromOdp, toHtmlDeck, THEMES, normaliseTheme, type Deck, type Slide, type Bullet, type Layout } from "@/lib/office/slides";
import { parseDeck } from "@/lib/office/files";
import { DECK_SYSTEM, extractOutline, cleanReply } from "@/lib/office/ai";
import { useOfficeFile, FileBar, AiPanel, TB, useAiCall, pickFile, unzipPackage, downloadPackage, downloadBytes, printHtml, MIME } from "./common";
import { cn } from "@/lib/cn";

/* Impress: presentations. Slides are structured (title, bullets with levels,
   an optional second column or image, speaker notes), laid out by a layout
   and a theme, so a deck exports cleanly to .pptx and .odp and an AI can write
   one as a plain outline. Present mode runs full screen with a notes view. */

const blank = (): Deck => fromOutline("# Untitled deck\n> Subtitle\n\n## First slide\n- A point worth making\n- Another one\n");
const LAYOUTS: Array<[Layout, string]> = [["title", "Title"], ["content", "Bullets"], ["two", "Two columns"], ["image", "Bullets + image"], ["section", "Section"], ["quote", "Quote"]];

const bulletsToText = (bs: Bullet[] = []) => bs.map((b) => `${"  ".repeat(b.level)}${b.text}`).join("\n");
const textToBullets = (t: string): Bullet[] => t.split("\n").filter((l) => l.trim()).map((l) => ({ text: l.trim().replace(/^[-*]\s+/, ""), level: Math.min(3, Math.floor((/^\s*/.exec(l)![0].replace(/\t/g, "  ").length) / 2)) }));

function SlideView({ slide, deck, scale = 1, className }: { slide: Slide; deck: Deck; scale?: number; className?: string }) {
  const th = normaliseTheme(deck.theme);
  const center = slide.layout === "title" || slide.layout === "section";
  const list = (bs: Bullet[] = []) => <ul className="m-0 pl-[1.1em]">{bs.map((b, i) => <li key={i} style={{ marginLeft: `${b.level * 1.2}em`, fontSize: b.level ? "0.85em" : undefined, margin: "0.3em 0" }}>{b.text}</li>)}</ul>;
  return (
    <div className={cn("relative aspect-video w-full overflow-hidden", className)} style={{ background: th.bg, color: th.fg, fontFamily: th.font, fontSize: `${22 * scale}px`, padding: "5% 6%" }} data-slide-layout={slide.layout}>
      {center ? (
        <div className="flex h-full flex-col justify-center text-center">
          <div style={{ fontSize: "2.2em", fontWeight: 700, lineHeight: 1.15 }}>{slide.title}</div>
          {slide.subtitle && <div style={{ fontSize: "1.05em", opacity: 0.8, marginTop: "0.5em" }}>{slide.subtitle}</div>}
        </div>
      ) : (
        <>
          <div style={{ fontSize: "1.5em", fontWeight: 700, color: th.accent, marginBottom: "0.6em", lineHeight: 1.2 }}>{slide.title}</div>
          {slide.layout === "quote" ? (
            <div style={{ fontSize: "1.35em", fontStyle: "italic", margin: "1em 1.5em" }}>{`“${slide.subtitle ?? ""}”`}</div>
          ) : slide.layout === "two" ? (
            <div className="grid grid-cols-2 gap-[4%]"><div>{list(slide.bullets)}</div><div>{list(slide.right)}</div></div>
          ) : (
            <div className={cn("grid gap-[4%]", slide.image ? "grid-cols-[2fr_3fr]" : "grid-cols-1")}>
              <div>{list(slide.bullets)}</div>
              {/* A data: URL from the deck itself; next/image has nothing to optimise. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {slide.image && /^data:image\//.test(slide.image) && <img src={slide.image} alt="" className="max-h-[60%] max-w-full rounded" />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Impress({ args }: AppProps) {
  const f = useOfficeFile("impress", args, parseDeck, blank);
  const ai = useAiCall();
  const [idx, setIdx] = useState(0);
  const [presenting, setPresenting] = useState<null | { i: number; notes: boolean }>(null);
  // Open by default where there is room; on a phone the document comes first.
  const [showAi, setShowAi] = useState(() => typeof window === "undefined" || window.innerWidth >= 700);
  const deck = f.data;
  const i = Math.min(idx, deck.slides.length - 1);
  const slide = deck.slides[i];

  const setSlide = (patch: Partial<Slide>) => f.update((d) => ({ ...d, slides: d.slides.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const addSlide = (after = i, s: Slide = { layout: "content", title: "New slide", bullets: [{ text: "Point", level: 0 }] }) => {
    f.update((d) => ({ ...d, slides: [...d.slides.slice(0, after + 1), s, ...d.slides.slice(after + 1)] }));
    setIdx(after + 1);
  };
  const removeSlide = () => { if (deck.slides.length < 2) return; f.update((d) => ({ ...d, slides: d.slides.filter((_, k) => k !== i) })); setIdx(Math.max(0, i - 1)); };
  const moveSlide = (dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= deck.slides.length) return;
    f.update((d) => { const s = d.slides.slice(); [s[i], s[j]] = [s[j], s[i]]; return { ...d, slides: s }; });
    setIdx(j);
  };
  const duplicate = () => addSlide(i, JSON.parse(JSON.stringify(slide)) as Slide);

  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); setPresenting((p) => p && { ...p, i: Math.min(deck.slides.length - 1, p.i + 1) }); }
      if (["ArrowLeft", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); setPresenting((p) => p && { ...p, i: Math.max(0, p.i - 1) }); }
      if (e.key === "Escape") { setPresenting(null); if (document.fullscreenElement) void document.exitFullscreen?.(); }
      if (e.key === "n" || e.key === "N") setPresenting((p) => p && { ...p, notes: !p.notes });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, deck.slides.length]);

  const present = (from = 0) => {
    setPresenting({ i: from, notes: false });
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const addImage = async () => {
    const file = await pickFile("image/png,image/jpeg,image/gif,image/webp");
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { ai.setError("Images are limited to 4 MB."); return; }
    const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
    setSlide({ image: url, layout: slide.layout === "content" || slide.layout === "image" ? "image" : slide.layout });
  };

  /* ── AI ── */
  const makeDeck = async (topic: string) => {
    const reply = await ai.run(DECK_SYSTEM, `Write a presentation: ${topic}`, { name: "impress.deck", maxTokens: 6000 });
    if (reply === null) return;
    const outline = extractOutline(reply);
    if (!outline) { ai.setError("The reply was not an outline."); return; }
    const d = fromOutline(outline, deck.theme);
    f.createNew({ ...d, theme: deck.theme }, d.title);
    setIdx(0);
  };
  const notesForSlide = async () => {
    const reply = await ai.run("Write speaker notes: what the presenter says for this slide, 2-4 natural sentences. Reply with only the notes.", `Deck: ${deck.title}\nSlide: ${slide.title}\n${bulletsToText(slide.bullets)}\n${bulletsToText(slide.right)}`, { name: "impress.notes", maxTokens: 600 });
    if (reply !== null) setSlide({ notes: cleanReply(reply) });
  };
  const rewriteSlide = async (how: string) => {
    const reply = await ai.run(DECK_SYSTEM, `${how}\nRewrite this one slide and reply with it as an outline (## title then - bullets, and Notes: if there are notes):\n${toOutline({ ...deck, slides: [slide] })}`, { name: "impress.rewrite", maxTokens: 1500 });
    if (reply === null) return;
    const d = fromOutline(extractOutline(reply) ?? "");
    const s = d.slides.find((x) => x.layout !== "title") ?? d.slides[0];
    if (s) setSlide({ title: s.title || slide.title, bullets: s.bullets.length ? s.bullets : slide.bullets, ...(s.right ? { right: s.right } : {}), ...(s.notes ? { notes: s.notes } : {}) });
  };
  const addSlideAbout = async (topic: string) => {
    const reply = await ai.run(DECK_SYSTEM, `Write ONE slide (## title, 3-5 bullets, Notes:) about: ${topic}\nIt goes into the deck "${deck.title}" after the slide "${slide.title}".`, { name: "impress.add", maxTokens: 1200 });
    if (reply === null) return;
    const d = fromOutline(extractOutline(reply) ?? "");
    const s = d.slides.find((x) => x.layout !== "title");
    if (s) addSlide(i, s); else ai.setError("The reply did not contain a slide.");
  };

  /* ── files ── */
  const importFile = async (kind: "pptx" | "odp" | "md") => {
    const file = await pickFile({ pptx: ".pptx", odp: ".odp", md: ".md,.markdown,.txt" }[kind]);
    if (!file) return;
    const d = kind === "pptx" ? fromPptx(await unzipPackage(file), deck.theme) : kind === "odp" ? fromOdp(await unzipPackage(file), deck.theme) : fromOutline(await file.text(), deck.theme);
    f.createNew(parseDeck(d), file.name.replace(/\.[^.]+$/, ""));
    setIdx(0);
  };
  const base = f.name.replace(/[^\w .-]/g, "_") || "presentation";
  const exportsMenu = [
    { id: "pptx", label: "PowerPoint (.pptx)", run: () => downloadPackage(`${base}.pptx`, toPptx(deck, { when: new Date().toISOString() }), MIME.pptx) },
    { id: "odp", label: "OpenDocument presentation (.odp)", run: () => downloadPackage(`${base}.odp`, toOdp(deck, { when: new Date().toISOString() }), MIME.odp) },
    { id: "html", label: "Presentation web page (.html)", run: () => downloadBytes(`${base}.html`, toHtmlDeck(deck), "text/html") },
    { id: "pdf", label: "PDF (print, then Save as PDF)", run: () => printHtml(toHtmlDeck(deck).replace("section{position:absolute", "section{position:relative;page-break-after:always").replace("display:none", "display:block").replace("overflow:hidden", "")) },
    { id: "md", label: "Outline (.md)", run: () => downloadBytes(`${base}.md`, toOutline(deck), "text/markdown") },
  ];
  const importsMenu = [
    { id: "pptx", label: "PowerPoint (.pptx)", run: () => importFile("pptx") },
    { id: "odp", label: "OpenDocument presentation (.odp)", run: () => importFile("odp") },
    { id: "md", label: "Outline (.md)", run: () => importFile("md") },
  ];

  if (presenting) {
    const s = deck.slides[presenting.i];
    return (
      <div className="fixed inset-0 z-[9500] flex flex-col bg-black" data-impress-present onClick={(e) => { const x = e.clientX / window.innerWidth; setPresenting((p) => p && { ...p, i: x > 0.33 ? Math.min(deck.slides.length - 1, p.i + 1) : Math.max(0, p.i - 1) }); }}>
        <div className="flex min-h-0 flex-1 items-center justify-center p-2">
          <div className="w-full max-w-[min(100vw,calc(177.78vh-8rem))]"><SlideView slide={s} deck={deck} scale={Math.max(0.6, Math.min(2.4, window.innerWidth / 900))} /></div>
        </div>
        {presenting.notes && <div className="max-h-[30vh] overflow-y-auto border-t border-white/20 bg-[#111] p-3 text-[15px] text-white/90" data-impress-notes>{s.notes || "No notes for this slide."}</div>}
        <div className="flex items-center gap-3 px-3 py-1 text-[12px] text-white/60" onClick={(e) => e.stopPropagation()}>
          <span>{presenting.i + 1} / {deck.slides.length}</span>
          <button className="rounded px-2 hover:bg-white/10" onClick={() => setPresenting((p) => p && { ...p, notes: !p.notes })}>Notes (N)</button>
          <button className="ml-auto rounded px-2 hover:bg-white/10" onClick={() => { setPresenting(null); if (document.fullscreenElement) void document.exitFullscreen?.(); }}>End (Esc)</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-office="impress">
      <FileBar icon="impress" name={f.name} savedAt={f.savedAt} onRename={f.rename} files={f.files} current={f.path}
        onOpen={(p) => { f.open(p); setIdx(0); }} onNew={() => { f.createNew(); setIdx(0); }}
        imports={importsMenu} exports={exportsMenu}
        extra={<>
          <TB label="Present from the start" icon="play" text="Present" onClick={() => present(0)} />
          <TB label="AI assistant" icon="sparkles" active={showAi} onClick={() => setShowAi((v) => !v)} />
        </>}
      />
      <div className="os-office-toolbar flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1" role="toolbar" aria-label="Slide tools">
        <TB label="New slide" icon="plus" text="Slide" onClick={() => addSlide()} />
        <TB label="Duplicate slide" icon="copy" onClick={duplicate} />
        <TB label="Move slide up" text="Up" onClick={() => moveSlide(-1)} />
        <TB label="Move slide down" text="Down" onClick={() => moveSlide(1)} />
        <TB label="Delete slide" icon="trash" onClick={removeSlide} disabled={deck.slides.length < 2} />
        <select className="os-input !w-auto !py-0.5 text-[11.5px]" value={slide.layout} onChange={(e) => setSlide({ layout: e.target.value as Layout })} aria-label="Layout">
          {LAYOUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <TB label="Add image" icon="image" onClick={() => void addImage()} />
        {slide.image && <TB label="Remove image" text="No image" onClick={() => setSlide({ image: undefined })} />}
        <span className="ml-1 text-[11px] text-[var(--muted)]">Theme</span>
        {Object.entries(THEMES).map(([id, t]) => (
          <button key={id} className={cn("h-5 w-7 rounded border", JSON.stringify(normaliseTheme(deck.theme)) === JSON.stringify(t) ? "border-[var(--accent)]" : "border-white/20")} style={{ background: `linear-gradient(135deg, ${t.bg} 60%, ${t.accent} 60%)` }} onClick={() => f.update((d) => ({ ...d, theme: t }))} aria-label={`Theme ${id}`} title={id} />
        ))}
        <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">Accent<input type="color" value={normaliseTheme(deck.theme).accent} onChange={(e) => f.update((d) => ({ ...d, theme: normaliseTheme({ ...d.theme, accent: e.target.value }) }))} aria-label="Accent colour" className="h-5 w-6" /></label>
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--border)] p-2 sm:w-40 sm:flex-col sm:overflow-y-auto sm:overflow-x-hidden sm:border-b-0 sm:border-r" aria-label="Slides" data-impress-sorter>
          {deck.slides.map((s, k) => (
            <button key={k} className={cn("w-28 shrink-0 rounded border-2 text-left sm:w-full", k === i ? "border-[var(--accent)]" : "border-transparent hover:border-white/20")} onClick={() => setIdx(k)} onDoubleClick={() => present(k)} aria-label={`Slide ${k + 1}: ${s.title}`} aria-current={k === i}>
              <div className="pointer-events-none"><SlideView slide={s} deck={deck} scale={0.22} /></div>
              <div className="truncate px-1 text-[10px] text-[var(--muted)]">{k + 1}. {s.title}</div>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mx-auto max-w-[760px]">
            <SlideView slide={slide} deck={deck} scale={0.8} className="rounded shadow-xl" />
            <div className="mt-3 grid gap-2 text-[12px]">
              <label className="grid gap-0.5"><span className="text-[var(--muted)]">Title</span><input className="os-input" value={slide.title} onChange={(e) => setSlide({ title: e.target.value })} /></label>
              {(slide.layout === "title" || slide.layout === "section" || slide.layout === "quote") && (
                <label className="grid gap-0.5"><span className="text-[var(--muted)]">{slide.layout === "quote" ? "Quote" : "Subtitle"}</span><input className="os-input" value={slide.subtitle ?? ""} onChange={(e) => setSlide({ subtitle: e.target.value })} /></label>
              )}
              {slide.layout !== "title" && slide.layout !== "section" && slide.layout !== "quote" && (
                <div className={cn("grid gap-2", slide.layout === "two" && "sm:grid-cols-2")}>
                  <label className="grid gap-0.5"><span className="text-[var(--muted)]">Bullets (one per line; indent with two spaces)</span><textarea className="os-input min-h-[110px] font-mono text-[12px]" value={bulletsToText(slide.bullets)} onChange={(e) => setSlide({ bullets: textToBullets(e.target.value) })} onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); const t = e.currentTarget; const s0 = t.selectionStart; t.setRangeText("  ", s0, s0, "end"); setSlide({ bullets: textToBullets(t.value) }); } }} /></label>
                  {slide.layout === "two" && <label className="grid gap-0.5"><span className="text-[var(--muted)]">Right column</span><textarea className="os-input min-h-[110px] font-mono text-[12px]" value={bulletsToText(slide.right)} onChange={(e) => setSlide({ right: textToBullets(e.target.value) })} /></label>}
                </div>
              )}
              <label className="grid gap-0.5"><span className="text-[var(--muted)]">Speaker notes</span><textarea className="os-input min-h-[70px] text-[12px]" value={slide.notes ?? ""} onChange={(e) => setSlide({ notes: e.target.value })} /></label>
            </div>
          </div>
        </div>
        {showAi && (
          <AiPanel
            title="Deck assistant" busy={ai.busy} error={ai.error} partial={ai.partial} provider={ai.provider} model={ai.model} onStop={ai.stop}
            placeholder="Topic for a whole new deck, e.g. 'a 7-slide pitch for a bakery app'"
            onFree={(t) => void makeDeck(t)}
            actions={[
              { id: "notes", label: "Write speaker notes", run: () => void notesForSlide() },
              { id: "tighten", label: "Tighten this slide", run: () => void rewriteSlide("Make it tighter: fewer, shorter bullets.") },
              { id: "punchy", label: "Make it punchier", run: () => void rewriteSlide("Make the title and bullets punchier and more concrete.") },
              { id: "next", label: "Add a slide after this", run: () => void addSlideAbout(`what logically follows "${slide.title}"`) },
            ]}
          >
            <p className="text-[10.5px] leading-snug text-[var(--muted)]">A new deck opens as its own document; the one you have stays as it is.</p>
          </AiPanel>
        )}
      </div>
    </div>
  );
}
