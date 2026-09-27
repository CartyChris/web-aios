"use client";

import { useRef, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { latexToMathML, MATH_PALETTE } from "@/lib/office/mathml";
import { parseMath, type MathFile } from "@/lib/office/files";
import { LATEX_SYSTEM, extractLatex, cleanReply } from "@/lib/office/ai";
import { useOfficeFile, FileBar, AiPanel, TB, useAiCall, downloadBytes, printHtml } from "./common";
import { CopyButton } from "../_ui";
import { cn } from "@/lib/cn";

/* Math: the formula editor. LaTeX in, native MathML out (every current
   browser renders MathML Core), so a formula needs no font download. A file
   holds a list of labelled formulas. The AI writes LaTeX from a description
   and explains or solves a formula step by step. */

const blank = (): MathFile => parseMath({});

export default function MathApp({ args }: AppProps) {
  const f = useOfficeFile("math", args, parseMath, blank);
  const ai = useAiCall();
  const [sel, setSel] = useState(0);
  const [answer, setAnswer] = useState("");
  // Open by default where there is room; on a phone the document comes first.
  const [showAi, setShowAi] = useState(() => typeof window === "undefined" || window.innerWidth >= 700);
  const input = useRef<HTMLTextAreaElement>(null);
  const k = Math.min(sel, f.data.formulas.length - 1);
  const cur = f.data.formulas[k];

  const setCur = (patch: Partial<MathFile["formulas"][number]>) => f.update((d) => ({ ...d, formulas: d.formulas.map((x, i) => (i === k ? { ...x, ...patch } : x)) }));
  const add = () => { f.update((d) => ({ ...d, formulas: [...d.formulas, { id: `f${Date.now().toString(36)}`, latex: "", label: "" }] })); setSel(f.data.formulas.length); };
  const remove = () => { if (f.data.formulas.length < 2) return; f.update((d) => ({ ...d, formulas: d.formulas.filter((_, i) => i !== k) })); setSel(Math.max(0, k - 1)); };
  const insert = (snippet: string) => {
    const t = input.current;
    if (!t) { setCur({ latex: cur.latex + snippet }); return; }
    const s0 = t.selectionStart, s1 = t.selectionEnd;
    const next = cur.latex.slice(0, s0) + snippet + cur.latex.slice(s1);
    setCur({ latex: next });
    requestAnimationFrame(() => { t.focus(); t.setSelectionRange(s0 + snippet.length, s0 + snippet.length); });
  };

  const fromWords = async (desc: string) => {
    const reply = await ai.run(LATEX_SYSTEM, desc, { name: "math.latex", maxTokens: 800 });
    if (reply === null) return;
    const latex = extractLatex(reply);
    if (!latex) { ai.setError("No formula in the reply."); return; }
    f.update((d) => ({ ...d, formulas: [...d.formulas, { id: `f${Date.now().toString(36)}`, latex, label: desc.slice(0, 80) }] }));
    setSel(f.data.formulas.length);
  };
  const explain = async (how: string) => {
    if (!cur.latex.trim()) { ai.setError("Write a formula first."); return; }
    const reply = await ai.run("You are a patient maths tutor. Use plain text; write any maths inline in LaTeX between $ signs.", `${how}\n\nFormula (LaTeX): ${cur.latex}`, { name: "math.explain", maxTokens: 1500 });
    if (reply !== null) setAnswer(cleanReply(reply));
  };

  const mathml = latexToMathML(cur.latex, { display: true });
  const allHtml = () => `<!doctype html><html><head><meta charset="utf-8"><title>${f.name}</title><style>body{font:16px/1.6 Georgia,serif;max-width:46em;margin:3em auto}figure{margin:2em 0;text-align:center}figcaption{color:#666;font-size:.9em}math{font-size:${f.data.size}px}</style></head><body>${f.data.formulas.map((x) => `<figure>${latexToMathML(x.latex, { display: true })}${x.label ? `<figcaption>${x.label.replace(/</g, "&lt;")}</figcaption>` : ""}</figure>`).join("")}</body></html>`;
  const base = f.name.replace(/[^\w .-]/g, "_") || "formulas";

  return (
    <div className="flex h-full flex-col" data-office="math">
      <FileBar icon="math" name={f.name} savedAt={f.savedAt} onRename={f.rename} files={f.files} current={f.path}
        onOpen={(p) => { f.open(p); setSel(0); }} onNew={() => { f.createNew(); setSel(0); }}
        exports={[
          { id: "html", label: "Web page with all formulas (.html)", run: () => downloadBytes(`${base}.html`, allHtml(), "text/html") },
          { id: "pdf", label: "PDF (print, then Save as PDF)", run: () => printHtml(allHtml()) },
          { id: "tex", label: "LaTeX (.tex)", run: () => downloadBytes(`${base}.tex`, f.data.formulas.map((x) => `% ${x.label}\n\\[ ${x.latex} \\]`).join("\n\n"), "application/x-tex") },
          { id: "mml", label: "This formula as MathML (.mml)", run: () => downloadBytes(`${base}.mml`, mathml, "application/mathml+xml") },
        ]}
        extra={<TB label="AI assistant" icon="sparkles" active={showAi} onClick={() => setShowAi((v) => !v)} />}
      />
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] p-2 sm:w-44 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r" aria-label="Formulas">
          {f.data.formulas.map((x, i) => (
            <button key={x.id} className={cn("min-w-[120px] shrink-0 rounded border px-1.5 py-1 text-left text-[11px]", i === k ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-transparent hover:bg-[var(--hover)]")} onClick={() => setSel(i)}>
              <div className="truncate">{x.label || `Formula ${i + 1}`}</div>
              <div className="truncate font-mono text-[10px] text-[var(--muted)]">{x.latex || "(empty)"}</div>
            </button>
          ))}
          <TB label="Add formula" icon="plus" text="Formula" onClick={add} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mx-auto max-w-[760px]">
            <div className="mb-2 flex min-h-[140px] items-center justify-center overflow-x-auto rounded-lg bg-white p-4 text-[#111]" style={{ fontSize: f.data.size }} dangerouslySetInnerHTML={{ __html: mathml }} data-math-preview aria-label="Rendered formula" />
            <div className="mb-2 flex flex-wrap items-center gap-1">
              <input className="os-input !w-auto flex-1 text-[12px]" placeholder="Label (optional)" value={cur.label} onChange={(e) => setCur({ label: e.target.value })} aria-label="Formula label" />
              <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">Size<input type="range" min={14} max={72} value={f.data.size} onChange={(e) => f.update((d) => ({ ...d, size: Number(e.target.value) }))} aria-label="Formula size" /></label>
              <CopyButton text={cur.latex} label="Copy LaTeX" />
              <CopyButton text={mathml} label="Copy MathML" />
              <TB label="Delete formula" icon="trash" onClick={remove} disabled={f.data.formulas.length < 2} />
            </div>
            <textarea ref={input} className="os-input min-h-[90px] w-full font-mono text-[13px]" value={cur.latex} onChange={(e) => setCur({ latex: e.target.value })} spellCheck={false} aria-label="LaTeX source" placeholder="\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}" />
            <div className="mt-2 grid gap-2">
              {MATH_PALETTE.map((g) => (
                <div key={g.group} className="flex flex-wrap items-center gap-1">
                  <span className="w-20 shrink-0 text-[10.5px] text-[var(--muted)]">{g.group}</span>
                  {g.items.map((it) => <button key={it.insert} className="os-btn !px-1.5 !py-0.5 text-[12px]" onClick={() => insert(it.insert)} title={it.insert} aria-label={`Insert ${it.insert}`}>{it.label}</button>)}
                </div>
              ))}
            </div>
          </div>
        </div>
        {showAi && (
          <AiPanel
            title="Math assistant" busy={ai.busy} error={ai.error} partial={ai.partial} provider={ai.provider} model={ai.model} onStop={ai.stop}
            placeholder="Describe a formula: 'the area of a circle', 'Bayes theorem'"
            onFree={(t) => void fromWords(t)}
            actions={[
              { id: "explain", label: "Explain this formula", run: () => void explain("Explain what this formula means and what each symbol stands for.") },
              { id: "solve", label: "Solve or simplify step by step", run: () => void explain("Solve or simplify this step by step, numbering the steps.") },
              { id: "example", label: "Worked example", run: () => void explain("Give one short worked example with concrete numbers.") },
            ]}
          >
            {answer && <div className="whitespace-pre-wrap rounded bg-white/5 p-1.5 text-[11.5px]" data-math-answer>{answer}</div>}
          </AiPanel>
        )}
      </div>
    </div>
  );
}
