"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { cn } from "@/lib/cn";

/** A calculator that evaluates expressions rather than emulating key presses.
 *
 *  The parser is hand-written on purpose: eval() on user text in a page that
 *  holds API keys is not a tradeoff worth making for arithmetic. */
export default function Calc({}: AppProps) {
  const [expr, setExpr] = useState("");
  const [history, setHistory] = useState<Array<{ expr: string; value: string }>>([]);

  const result = (() => {
    if (!expr.trim()) return "";
    try {
      const v = evaluate(expr);
      return Number.isFinite(v) ? format(v) : "—";
    } catch {
      return "";
    }
  })();

  const commit = useCallback(() => {
    if (!expr.trim() || !result || result === "—") return;
    setHistory((h) => [{ expr, value: result }, ...h].slice(0, 60));
    setExpr(result);
  }, [expr, result]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
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
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto border-b border-[var(--border)] p-2">
        {history.map((h, i) => (
          <button key={i} onClick={() => setExpr(h.expr)} className="mb-1 block w-full rounded px-2 py-1 text-right hover:bg-white/6">
            <div className="text-[11px] text-[var(--muted)]">{h.expr}</div>
            <div className="tabular-nums text-[14px]">{h.value}</div>
          </button>
        ))}
        {history.length === 0 && <div className="grid h-full place-items-center text-[11px] text-[var(--muted)]">Type an expression. Supports + − × ÷ % ^ and parentheses.</div>}
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
          <button className="os-btn col-span-4 !py-1.5 text-[11px]" onClick={() => { setExpr(""); setHistory([]); }}>Clear all</button>
        </div>
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
