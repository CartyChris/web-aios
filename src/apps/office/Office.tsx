"use client";

import { useMemo } from "react";
import type { AppProps } from "@/kernel/types";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { appForPath, newName, FOLDER, type OfficeApp } from "@/lib/office/files";
import { fromMarkdown } from "@/lib/office/doc";
import { fromOutline, THEMES } from "@/lib/office/slides";
import { layoutGraph } from "@/lib/office/draw";
import { relTime } from "@/lib/format";
import { Icon } from "@/shell/icons";

/* Office: the start centre, as in LibreOffice. New documents of every kind,
   templates that are real documents rather than pictures of them, and the
   office files already in the OS filesystem. */

const APPS: Array<{ app: OfficeApp; name: string; icon: string; blurb: string }> = [
  { app: "writer", name: "Writer", icon: "writer", blurb: "Documents: .docx, .odt, PDF" },
  { app: "sheets", name: "Sheets", icon: "sheets", blurb: "Spreadsheets: .xlsx, .ods, .csv" },
  { app: "impress", name: "Impress", icon: "impress", blurb: "Presentations: .pptx, .odp" },
  { app: "draw", name: "Draw", icon: "drawapp", blurb: "Diagrams: .svg, .png, .odg" },
  { app: "math", name: "Math", icon: "math", blurb: "Formulas: LaTeX to MathML" },
  { app: "base", name: "Base", icon: "base", blurb: "Databases with SQL" },
];

const TEMPLATES: Array<{ app: OfficeApp; name: string; make: () => unknown }> = [
  { app: "writer", name: "Letter", make: () => fromMarkdown("Your Name\n\n123 Street, City\n\n27 September 2026\n\nDear Recipient,\n\nI am writing to...\n\nSincerely,\n\nYour Name", "Letter") },
  { app: "writer", name: "Resume", make: () => fromMarkdown("# Your Name\n\nemail@example.com | city | portfolio\n\n## Experience\n\n### Role, Company (2023 - now)\n\n- Achievement with a number\n- Another achievement\n\n## Skills\n\n- Skill one\n- Skill two\n\n## Education\n\nDegree, School (year)", "Resume") },
  { app: "writer", name: "Meeting notes", make: () => fromMarkdown("# Meeting notes\n\n**Date:** \n\n**Attendees:** \n\n## Agenda\n\n1. \n\n## Decisions\n\n- \n\n## Action items\n\n| Owner | Task | Due |\n| --- | --- | --- |\n|  |  |  |", "Meeting notes") },
  { app: "sheets", name: "Monthly budget", make: () => ({ wb: { sheets: [{ name: "Budget", cells: { A1: "Category", B1: "Planned", C1: "Actual", D1: "Difference", A2: "Rent", B2: "1200", C2: "1200", A3: "Groceries", B3: "400", C3: "455", A4: "Transport", B4: "120", C4: "90", A5: "Fun", B5: "150", C5: "210", A6: "Total", B6: "=SUM(B2:B5)", C6: "=SUM(C2:C5)", D2: "=B2-C2", D3: "=B3-C3", D4: "=B4-C4", D5: "=B5-C5", D6: "=B6-C6" } }] }, formats: { Budget: { A1: { b: true }, B1: { b: true }, C1: { b: true }, D1: { b: true }, A6: { b: true }, B6: { b: true, nf: "$#,##0.00" }, C6: { b: true, nf: "$#,##0.00" }, D6: { b: true, nf: "$#,##0.00" } } }, colWidths: {} }) },
  { app: "sheets", name: "Invoice", make: () => ({ wb: { sheets: [{ name: "Invoice", cells: { A1: "INVOICE", A3: "Item", B3: "Qty", C3: "Price", D3: "Amount", A4: "Design work", B4: "10", C4: "85", D4: "=B4*C4", A5: "Hosting", B5: "1", C5: "20", D5: "=B5*C5", C7: "Subtotal", D7: "=SUM(D4:D5)", C8: "Tax 8%", D8: "=ROUND(D7*8%,2)", C9: "Total", D9: "=D7+D8" } }] }, formats: { Invoice: { A1: { b: true }, C9: { b: true }, D9: { b: true, nf: "$#,##0.00" }, D7: { nf: "$#,##0.00" }, D8: { nf: "$#,##0.00" } } }, colWidths: {} }) },
  { app: "impress", name: "Pitch deck", make: () => fromOutline("# Product name\n> One line on what it does\n\n## The problem\n- Who hurts, and how much\n- Why now\n\n## The solution\n- What it does\n- Why it wins\n\n## Traction\n- Users, revenue, growth\n\n## The ask\n- Amount and what it buys\nNotes: End on the one number that matters.", THEMES.midnight) },
  { app: "draw", name: "Flowchart", make: () => ({ shapes: layoutGraph({ nodes: [{ id: "s", label: "Start", shape: "ellipse" }, { id: "a", label: "Do the thing" }, { id: "d", label: "Did it work?", shape: "diamond" }, { id: "e", label: "Done", shape: "ellipse" }], edges: [{ from: "s", to: "a" }, { from: "a", to: "d" }, { from: "d", to: "e", label: "yes" }, { from: "d", to: "a", label: "no" }] }), bg: "#ffffff" }) },
];

export default function Office({}: AppProps) {
  const nodes = useVFS((s) => s.nodes);
  const recent = useMemo(() => Object.values(nodes).filter((n) => n.kind === "file" && appForPath(n.path)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 24), [nodes]);
  const open = (app: OfficeApp, path?: string) => bus.emit("app:open", { appId: app, args: path ? { path } : undefined });
  const fromTemplate = (t: (typeof TEMPLATES)[number]) => {
    const p = newName(t.app, new Set(Object.keys(useVFS.getState().nodes)), t.name);
    useVFS.getState().mkdir(FOLDER[t.app]);
    useVFS.getState().write(p, JSON.stringify(t.make()), { appId: t.app });
    open(t.app, p);
  };
  return (
    <div className="h-full overflow-y-auto p-4" data-office="start">
      <div className="mb-1 text-[20px] font-semibold">Office</div>
      <p className="mb-4 text-[12.5px] text-[var(--muted)]">Documents, spreadsheets, presentations, drawings, formulas and databases. Files open and save as Word, Excel, PowerPoint and OpenDocument, and every app has an AI assistant that uses the model you chose in Settings.</p>
      <div className="mb-5 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        {APPS.map((a) => (
          <button key={a.app} className="os-card flex flex-col items-start gap-1 !p-3 text-left hover:border-[var(--accent)]" onClick={() => open(a.app)} data-office-new={a.app}>
            <Icon name={a.icon} size={22} />
            <span className="text-[13px] font-medium">{a.name}</span>
            <span className="text-[11px] text-[var(--muted)]">{a.blurb}</span>
          </button>
        ))}
      </div>
      <div className="os-label mb-1">Templates</div>
      <div className="mb-5 flex flex-wrap gap-1.5">
        {TEMPLATES.map((t) => <button key={t.name} className="os-btn !py-1 text-[12px]" onClick={() => fromTemplate(t)} data-office-template={t.name}><Icon name={APPS.find((a) => a.app === t.app)!.icon} size={12} /> {t.name}</button>)}
      </div>
      <div className="os-label mb-1">Recent</div>
      {recent.length ? (
        <div className="grid gap-1">
          {recent.map((n) => {
            const app = appForPath(n.path)!;
            return (
              <button key={n.path} className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]" onClick={() => open(app, n.path)}>
                <Icon name={APPS.find((a) => a.app === app)!.icon} size={14} />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{n.name.replace(/\.[^.]+$/, "")}</span>
                <span className="shrink-0 text-[10.5px] text-[var(--muted)]">{relTime(n.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      ) : <p className="text-[12px] text-[var(--muted)]">Nothing yet. Start with one of the apps above.</p>}
    </div>
  );
}
