"use client";

import { useMemo, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { runQuery, schemaText, coerce, inferType, type Table, type ColType, type QueryResult } from "@/lib/office/basedb";
import { parseBase, type BaseFile, newName, FOLDER } from "@/lib/office/files";
import { parseCsv, toCsv, gridToCells } from "@/lib/office/sheetio";
import { SQL_SYSTEM, extractSql } from "@/lib/office/ai";
import { useOfficeFile, FileBar, AiPanel, TB, useAiCall, pickFile, downloadBytes } from "./common";
import { cn } from "@/lib/cn";

/* Base: small databases. Typed tables you fill in like a sheet, and SELECT
   queries over them -- written by hand or by the AI from a question in
   English (schema supplied, SQL shown, then run here; never anything but
   SELECT). Results export as CSV or open in Sheets. */

const blank = (): BaseFile => ({
  tables: [{ name: "contacts", columns: [{ name: "name", type: "text" }, { name: "email", type: "text" }, { name: "joined", type: "date" }, { name: "orders", type: "number" }], rows: [["Ann Lee", "ann@example.com", "2026-03-02", 4], ["Bo Chen", "bo@example.com", "2026-06-18", 1]] }],
  queries: [{ name: "Most orders", sql: "SELECT name, orders FROM contacts ORDER BY orders DESC" }],
});
const TYPES: ColType[] = ["text", "number", "date", "bool"];

export default function Base({ args }: AppProps) {
  const f = useOfficeFile("base", args, parseBase, blank);
  const ai = useAiCall();
  const [tab, setTab] = useState<{ kind: "table"; i: number } | { kind: "query" }>({ kind: "table", i: 0 });
  const [sql, setSql] = useState(f.data.queries[0]?.sql ?? "SELECT * FROM contacts");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [qerr, setQerr] = useState<string | null>(null);
  // Open by default where there is room; on a phone the document comes first.
  const [showAi, setShowAi] = useState(() => typeof window === "undefined" || window.innerWidth >= 700);
  const [filter, setFilter] = useState("");
  const table = tab.kind === "table" ? f.data.tables[Math.min(tab.i, f.data.tables.length - 1)] : undefined;

  const setTable = (i: number, t: Table) => f.update((d) => ({ ...d, tables: d.tables.map((x, k) => (k === i ? t : x)) }));
  const tIndex = tab.kind === "table" ? Math.min(tab.i, f.data.tables.length - 1) : -1;

  const run = (q = sql) => {
    try { setResult(runQuery(f.data.tables, q)); setQerr(null); }
    catch (e) { setResult(null); setQerr((e as Error).message); }
  };

  const addTable = () => {
    const names = new Set(f.data.tables.map((t) => t.name));
    let n = f.data.tables.length + 1;
    while (names.has(`table${n}`)) n++;
    f.update((d) => ({ ...d, tables: [...d.tables, { name: `table${n}`, columns: [{ name: "name", type: "text" }, { name: "value", type: "number" }], rows: [] }] }));
    setTab({ kind: "table", i: f.data.tables.length });
  };
  const importCsv = async () => {
    const file = await pickFile(".csv,.tsv,.txt");
    if (!file) return;
    const grid = parseCsv(await file.text());
    if (grid.length < 1) return;
    const header = grid[0].map((h, i) => h.trim().replace(/[^A-Za-z0-9_]/g, "_") || `col${i + 1}`);
    const types = header.map((_, j) => inferType(grid.slice(1).map((r) => r[j] ?? "")));
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_").toLowerCase() || "imported";
    const t: Table = { name: f.data.tables.some((x) => x.name === name) ? `${name}_2` : name, columns: header.map((h, j) => ({ name: h, type: types[j] })), rows: grid.slice(1).filter((r) => r.some((x) => x.trim())).map((r) => header.map((_, j) => coerce(r[j] ?? "", types[j]))) };
    f.update((d) => ({ ...d, tables: [...d.tables, t] }));
    setTab({ kind: "table", i: f.data.tables.length });
  };
  const toSheets = (res: QueryResult, title: string) => {
    const grid = [res.columns, ...res.rows.map((r) => r.map((v) => (v === null ? "" : String(v))))];
    const p = newName("sheets", new Set(Object.keys(useVFS.getState().nodes)), title.replace(/[/\\]/g, "-"));
    useVFS.getState().mkdir(FOLDER.sheets);
    useVFS.getState().write(p, JSON.stringify({ wb: { sheets: [{ name: "Query", cells: gridToCells(grid) }] }, formats: {}, colWidths: {} }), { appId: "base" });
    bus.emit("app:open", { appId: "sheets", args: { path: p } });
  };

  const ask = async (question: string) => {
    const reply = await ai.run(SQL_SYSTEM, `Schema:\n${schemaText(f.data.tables)}\n\nQuestion: ${question}`, { name: "base.sql", maxTokens: 800 });
    if (reply === null) return;
    const q = extractSql(reply);
    if (!q) { ai.setError("No SELECT query in the reply."); return; }
    setTab({ kind: "query" });
    setSql(q);
    run(q);
  };

  const visibleRows = useMemo(() => {
    if (!table) return [];
    const q = filter.trim().toLowerCase();
    return table.rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || r.some((v) => v !== null && String(v).toLowerCase().includes(q)));
  }, [table, filter]);

  const base = f.name.replace(/[^\w .-]/g, "_") || "database";

  return (
    <div className="flex h-full flex-col" data-office="base">
      <FileBar icon="base" name={f.name} savedAt={f.savedAt} onRename={f.rename} files={f.files} current={f.path}
        onOpen={(p) => { f.open(p); setTab({ kind: "table", i: 0 }); setResult(null); }} onNew={() => { f.createNew(); setTab({ kind: "table", i: 0 }); }}
        imports={[{ id: "csv", label: "Table from CSV", run: importCsv }]}
        exports={[
          ...(table ? [{ id: "tcsv", label: `Table "${table.name}" as CSV`, run: () => downloadBytes(`${table.name}.csv`, toCsv([table.columns.map((c) => c.name), ...table.rows.map((r) => r.map((v) => (v === null ? "" : String(v))))]), "text/csv") }] : []),
          ...(result ? [{ id: "rcsv", label: "Query result as CSV", run: () => downloadBytes(`${base} query.csv`, toCsv([result.columns, ...result.rows.map((r) => r.map((v) => (v === null ? "" : String(v))))]), "text/csv") }] : []),
          { id: "json", label: "Whole database (.json)", run: () => downloadBytes(`${base}.json`, JSON.stringify(f.data, null, 2), "application/json") },
        ]}
        extra={<TB label="AI assistant" icon="sparkles" active={showAi} onClick={() => setShowAi((v) => !v)} />}
      />
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] p-2 text-[12px] sm:w-40 sm:flex-col sm:border-b-0 sm:border-r" aria-label="Tables and queries">
          <div className="os-label hidden sm:block">Tables</div>
          {f.data.tables.map((t, i) => <button key={t.name} className={cn("shrink-0 truncate rounded px-2 py-1 text-left", tab.kind === "table" && tIndex === i ? "bg-[var(--accent)]/20" : "hover:bg-[var(--hover)]")} onClick={() => setTab({ kind: "table", i })}>{t.name} <span className="text-[10px] text-[var(--muted)]">{t.rows.length}</span></button>)}
          <TB label="New table" icon="plus" text="Table" onClick={addTable} />
          <div className="os-label mt-2 hidden sm:block">Queries</div>
          <button className={cn("shrink-0 rounded px-2 py-1 text-left", tab.kind === "query" ? "bg-[var(--accent)]/20" : "hover:bg-[var(--hover)]")} onClick={() => setTab({ kind: "query" })}>SQL query</button>
          {f.data.queries.map((q) => <button key={q.name} className="shrink-0 truncate rounded px-2 py-1 text-left text-[11px] text-[var(--muted)] hover:bg-[var(--hover)]" onClick={() => { setTab({ kind: "query" }); setSql(q.sql); run(q.sql); }}>{q.name}</button>)}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-2">
          {table && (
            <div data-base-table={table.name}>
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <input className="os-input !w-40 !py-0.5 text-[12px]" defaultValue={table.name} key={table.name} aria-label="Table name" onBlur={(e) => { const n = e.target.value.replace(/[^A-Za-z0-9_]/g, "_"); if (n && !f.data.tables.some((t, k) => k !== tIndex && t.name === n)) setTable(tIndex, { ...table, name: n }); }} />
                <TB label="Add row" icon="plus" text="Row" onClick={() => setTable(tIndex, { ...table, rows: [...table.rows, table.columns.map(() => null)] })} />
                <TB label="Add column" icon="plus" text="Column" onClick={() => setTable(tIndex, { ...table, columns: [...table.columns, { name: `col${table.columns.length + 1}`, type: "text" }], rows: table.rows.map((r) => [...r, null]) })} />
                <input className="os-input !w-40 !py-0.5 text-[12px]" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter rows" />
                {f.data.tables.length > 1 && <TB label={`Delete table ${table.name}`} icon="trash" onClick={() => { f.update((d) => ({ ...d, tables: d.tables.filter((_, k) => k !== tIndex) })); setTab({ kind: "table", i: 0 }); }} />}
              </div>
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    {table.columns.map((c, j) => (
                      <th key={j} className="border border-[var(--border)] px-1 py-0.5 text-left font-medium">
                        <input className="w-full bg-transparent font-medium outline-none" defaultValue={c.name} key={`${table.name}-${j}-${c.name}`} aria-label={`Column ${j + 1} name`} onBlur={(e) => { const n = e.target.value.replace(/[^A-Za-z0-9_]/g, "_"); if (n) setTable(tIndex, { ...table, columns: table.columns.map((x, k) => (k === j ? { ...x, name: n } : x)) }); }} />
                        <select className="bg-transparent text-[10px] text-[var(--muted)]" value={c.type} aria-label={`Column ${c.name} type`} onChange={(e) => { const type = e.target.value as ColType; setTable(tIndex, { ...table, columns: table.columns.map((x, k) => (k === j ? { ...x, type } : x)), rows: table.rows.map((r) => r.map((v, k) => (k === j ? coerce(v, type) : v))) }); }}>
                          {TYPES.map((t) => <option key={t}>{t}</option>)}
                        </select>
                      </th>
                    ))}
                    <th className="w-6 border border-[var(--border)]" />
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.slice(0, 1000).map(({ r, i }) => (
                    <tr key={i}>
                      {table.columns.map((c, j) => (
                        <td key={j} className="border border-[var(--border)] p-0">
                          {c.type === "bool" ? (
                            <input type="checkbox" className="mx-1" checked={r[j] === true} aria-label={`${c.name}, row ${i + 1}`} onChange={(e) => setTable(tIndex, { ...table, rows: table.rows.map((row, k) => (k === i ? row.map((v, m) => (m === j ? e.target.checked : v)) : row)) })} />
                          ) : (
                            <input
                              className={cn("w-full bg-transparent px-1 py-0.5 outline-none focus:bg-[var(--accent)]/10", c.type === "number" && "text-right")}
                              type={c.type === "date" ? "date" : "text"}
                              defaultValue={r[j] === null ? "" : String(r[j])}
                              key={`${i}-${j}-${String(r[j])}`}
                              aria-label={`${c.name}, row ${i + 1}`}
                              onBlur={(e) => { const v = coerce(e.target.value, c.type); if (v !== r[j]) setTable(tIndex, { ...table, rows: table.rows.map((row, k) => (k === i ? row.map((x, m) => (m === j ? v : x)) : row)) }); }}
                            />
                          )}
                        </td>
                      ))}
                      <td className="border border-[var(--border)] text-center"><button className="text-[10px] text-[var(--muted)] hover:text-[var(--danger)]" onClick={() => setTable(tIndex, { ...table, rows: table.rows.filter((_, k) => k !== i) })} aria-label={`Delete row ${i + 1}`}>x</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visibleRows.length > 1000 && <p className="mt-1 text-[11px] text-[var(--muted)]">Showing 1,000 of {visibleRows.length} rows; use a query for the rest.</p>}
            </div>
          )}
          {tab.kind === "query" && (
            <div data-base-query>
              <textarea className="os-input min-h-[90px] w-full font-mono text-[12.5px]" value={sql} onChange={(e) => setSql(e.target.value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); } }} aria-label="SQL query" spellCheck={false} />
              <div className="my-1.5 flex flex-wrap gap-1">
                <TB label="Run query" icon="play" text="Run" onClick={() => run()} />
                <TB label="Save query" icon="save" text="Save" onClick={() => { const name = window.prompt("Name this query"); if (name) f.update((d) => ({ ...d, queries: [...d.queries.filter((q) => q.name !== name), { name: name.slice(0, 80), sql }] })); }} />
                {result && <TB label="Open result in Sheets" icon="sheets" text="Open in Sheets" onClick={() => toSheets(result, "Query result")} />}
                <span className="self-center text-[10.5px] text-[var(--muted)]">SELECT only. Ctrl+Enter runs.</span>
              </div>
              {qerr && <p className="text-[12px] text-[var(--danger)]" role="alert">{qerr}</p>}
              {result && (
                <div className="overflow-auto">
                  <div className="mb-1 text-[11px] text-[var(--muted)]" aria-live="polite">{result.rows.length} row{result.rows.length === 1 ? "" : "s"}</div>
                  <table className="w-full border-collapse text-[12px]" data-base-result>
                    <thead><tr>{result.columns.map((c, j) => <th key={j} className="border border-[var(--border)] px-1.5 py-0.5 text-left font-medium">{c}</th>)}</tr></thead>
                    <tbody>{result.rows.slice(0, 1000).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={cn("border border-[var(--border)] px-1.5 py-0.5", typeof v === "number" && "text-right")}>{v === null ? "" : String(v)}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
        {showAi && (
          <AiPanel
            title="Ask the database" busy={ai.busy} error={ai.error} partial={ai.partial} provider={ai.provider} model={ai.model} onStop={ai.stop}
            placeholder="Ask in plain English: 'who joined this year, most orders first?'"
            onFree={(t) => void ask(t)}
            actions={[
              { id: "overview", label: "Count rows in each table", run: () => { setTab({ kind: "query" }); const t = f.data.tables[0]; if (t) { const q = `SELECT COUNT(*) AS rows FROM ${t.name}`; setSql(q); run(q); } } },
            ]}
          >
            <p className="text-[10.5px] leading-snug text-[var(--muted)]">The model writes SQL from your table names and columns only (not the data); the query is shown, and runs here.</p>
          </AiPanel>
        )}
      </div>
    </div>
  );
}
