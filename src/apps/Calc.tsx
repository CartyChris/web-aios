"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AppProps } from "@/kernel/types";
import { cn } from "@/lib/cn";
import { convert, parseConversion, unitsFor, formatNumber, DIMENSIONS, type Dimension } from "@/lib/units";
import { Icon } from "@/shell/icons";

/** Expression history, kept across reloads. */
const useCalcHistory = create<{ items: Array<{ expr: string; value: string }>; push: (e: { expr: string; value: string }) => void; clear: () => void }>()(
  persist(
    (set) => ({
      items: [],
      push: (e) => set((s) => ({ items: [e, ...s.items].slice(0, 200) })),
      clear: () => set({ items: [] }),
    }),
    { name: "webaios.calc.history.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

/** A calculator that evaluates expressions rather than emulating key presses.
 *
 *  The parser is hand-written on purpose: eval() on user text in a page that
 *  holds API keys is not a tradeoff worth making for arithmetic. */
export default function Calc({}: AppProps) {
  const [expr, setExpr] = useState("");
  const history = useCalcHistory((st) => st.items);
  const pushHistory = useCalcHistory((st) => st.push);
  const clearHistory = useCalcHistory((st) => st.clear);
  const [showConv, setShowConv] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const result = (() => {
    if (!expr.trim()) return "";
    // "5 km to mi" is a conversion, not arithmetic.
    const conv = parseConversion(expr);
    if (conv) {
      const r = convert(conv.value, conv.from, conv.to);
      return r.ok ? `${formatNumber(r.value)} ${r.to.id}` : "";
    }
    try {
      const v = evaluate(expr);
      return Number.isFinite(v) ? format(v) : "—";
    } catch {
      return "";
    }
  })();

  const commit = useCallback(() => {
    if (!expr.trim() || !result || result === "—") return;
    pushHistory({ expr, value: result });
    // A conversion result carries a unit, so it cannot be the next operand.
    setExpr(parseConversion(expr) ? "" : result.replace(/,/g, ""));
  }, [expr, result, pushHistory]);

  // Keyboard input, scoped to this window: the listener used to be on the
  // whole page, so typing in another app's textarea also typed into Calc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!rootRef.current || !t || !rootRef.current.contains(t)) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
      if (/^[0-9+\-*/.()%^]$/.test(e.key)) setExpr((s) => s + e.key);
      else if (e.key === "Enter" || e.key === "=") commit();
      else if (e.key === "Backspace") setExpr((s) => s.slice(0, -1));
      else if (e.key === "Escape") setExpr("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit]);

  const keys = [
    ["(", ")", "%", "÷"], ["7", "8", "9", "×"], ["4", "5", "6", "−"], ["1", "2", "3", "+"], ["0", ".", "⌫", "="],
  ];
  const press = (k: string) => {
    if (k === "=") return commit();
    if (k === "⌫") return setExpr((s) => s.slice(0, -1));
    const map: Record<string, string> = { "÷": "/", "×": "*", "−": "-" };
    setExpr((s) => s + (map[k] ?? k));
  };

  return (
    <div ref={rootRef} tabIndex={-1} className="flex h-full flex-col outline-none">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-2 py-1">
        <span className="flex-1 text-[10.5px] text-[var(--muted)]">{history.length ? `${history.length} in history` : "Type, or use the keys"}</span>
        <button className={cn("os-btn !px-2 !py-0.5 text-[10.5px]", showConv && "!border-[var(--accent)] !bg-[var(--accent)]/16")} aria-pressed={showConv} onClick={() => setShowConv((v) => !v)}>
          <Icon name="tune" size={10} /> Units
        </button>
      </div>
      {showConv && <Converter onUse={(v) => setExpr((s) => s + v)} />}
      <div className="min-h-0 flex-1 overflow-y-auto border-b border-[var(--border)] p-2">
        {history.map((h, i) => (
          <button key={i} onClick={() => setExpr(h.expr)} aria-label={`Reuse ${h.expr} = ${h.value}`} className="mb-1 block w-full rounded px-2 py-1 text-right hover:bg-white/6">
            <div className="text-[11px] text-[var(--muted)]">{h.expr}</div>
            <div className="tabular-nums text-[14px]">{h.value}</div>
          </button>
        ))}
        {history.length === 0 && <div className="grid h-full place-items-center text-[11px] text-[var(--muted)]">Type an expression. Supports + − × ÷ % ^ and parentheses, or a conversion like 5 km to mi.</div>}
      </div>

      <div className="shrink-0 p-2.5">
        <input
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          placeholder="0"
          className="os-input mb-1 text-right font-[family-name:var(--font-mono)] text-[20px]"
          style={{ fontSize: 20 }}
        />
        <div className="mb-2 h-6 text-right tabular-nums text-[15px] text-[var(--accent)]">{result}</div>
        <div className="grid grid-cols-4 gap-1.5">
          {keys.flat().map((k) => (
            <button
              key={k}
              onClick={() => press(k)}
              className={cn("os-btn !py-3 text-[15px]", k === "=" && "!bg-[var(--accent)] !text-black")}
            >
              {k}
            </button>
          ))}
          <button className="os-btn col-span-4 !py-1.5 text-[11px]" onClick={() => { setExpr(""); clearHistory(); }}>Clear all</button>
        </div>
      </div>
    </div>
  );
}

/** Units only — a currency needs a live rate, and every number here must be real. */
function Converter({ onUse }: { onUse: (v: string) => void }) {
  const [dim, setDim] = useState<Dimension>("length");
  const [from, setFrom] = useState("km");
  const [to, setTo] = useState("mi");
  const [value, setValue] = useState("1");
  const units = unitsFor(dim);
  const r = convert(Number(value), from, to);
  const out = value.trim() && r.ok ? formatNumber(r.value) : "";
  const pickDim = (d: Dimension) => {
    const u = unitsFor(d);
    setDim(d);
    setFrom(u[0].id);
    setTo(u[Math.min(1, u.length - 1)].id);
  };
  return (
    <div className="shrink-0 space-y-1.5 border-b border-[var(--border)] p-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Quantity">
        {DIMENSIONS.map((d) => (
          <button key={d} aria-pressed={dim === d} onClick={() => pickDim(d)} className={cn("os-btn !px-1.5 !py-0 text-[10px]", dim === d && "!border-[var(--accent)] !bg-[var(--accent)]/16")}>{d}</button>
        ))}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-1">
        <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" aria-label="Value to convert" className="os-input !py-1 text-right text-[13px] tabular-nums" />
        <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From unit" className="os-input !w-auto !py-1 text-[11px]">
          {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <div className="os-input flex items-center justify-end !py-1 text-[13px] tabular-nums text-[var(--accent)]" aria-live="polite" data-testid="calc-convert-out">{out || (r.ok ? "" : r.reason)}</div>
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To unit" className="os-input !w-auto !py-1 text-[11px]">
          {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <div className="flex gap-1">
        <button className="os-btn !py-0.5 text-[10.5px]" aria-label="Swap units" onClick={() => { setFrom(to); setTo(from); }}>Swap</button>
        <button className="os-btn !py-0.5 text-[10.5px]" disabled={!out} onClick={() => onUse(out)}>Use in expression</button>
      </div>
    </div>
  );
}

/* Recursive-descent parser: expr → term → factor → power → primary. */
function evaluate(src: string): number {
  const s = src.replace(/[×x]/g, "*").replace(/[÷]/g, "/").replace(/[−–]/g, "-").replace(/\s+/g, "");
  let i = 0;
  const peek = () => s[i];
  const eat = (c: string) => (s[i] === c ? (i++, true) : false);

  function expr(): number {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  }
  function term(): number {
    let v = power();
    for (;;) {
      if (eat("*")) v *= power();
      else if (eat("/")) {
        const d = power();
        if (d === 0) throw new Error("divide by zero");
        v /= d;
      } else if (eat("%")) v %= power();
      else return v;
    }
  }
  function power(): number {
    const base = unary();
    // Right-associative, so 2^3^2 is 512 rather than 64.
    if (eat("^")) return Math.pow(base, power());
    return base;
  }
  function unary(): number {
    if (eat("-")) return -unary();
    if (eat("+")) return unary();
    return primary();
  }
  function primary(): number {
    if (eat("(")) {
      const v = expr();
      if (!eat(")")) throw new Error("unbalanced parenthesis");
      return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (start === i) throw new Error(`unexpected "${peek() ?? "end"}"`);
    const n = Number(s.slice(start, i));
    if (Number.isNaN(n)) throw new Error("bad number");
    return n;
  }

  const out = expr();
  if (i !== s.length) throw new Error(`trailing input at ${i}`);
  return out;
}

function format(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v.toLocaleString();
  const r = Number(v.toPrecision(12));
  return Math.abs(r) < 1e-7 || Math.abs(r) >= 1e15 ? r.toExponential(6) : String(r);
}
