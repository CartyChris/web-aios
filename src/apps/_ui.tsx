"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";

/** Shared chrome for every app, so twenty modules look like one product
 *  instead of twenty ports. */

export function AppShell({ sidebar, children, toolbar }: { sidebar?: React.ReactNode; children: React.ReactNode; toolbar?: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {toolbar && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">{toolbar}</div>
      )}
      <div className="app-split flex min-h-0 flex-1">
        {sidebar && <div className="app-sidebar w-52 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">{sidebar}</div>}
        <div className="min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string; icon?: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)] px-2 py-1.5">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn("os-btn shrink-0 !py-1 text-[12px]", active === t.id && "!border-[var(--accent)] !bg-[var(--accent)]/16")}
        >
          {t.icon && <Icon name={t.icon} size={12} className="mr-1 inline-block align-[-1px]" />}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="os-label mb-1">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-[var(--muted)]">{hint}</div>}
    </label>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="os-label">{label}</span>
        <span className="tabular-nums text-[11px] text-[var(--muted)]">{format ? format(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <button onClick={() => onChange(!checked)} className="mb-2 flex w-full items-center gap-2.5 text-left">
      <span className="relative h-5 w-9 shrink-0 rounded-full transition"
        style={{ background: checked ? "var(--accent)" : "color-mix(in srgb, var(--muted) 35%, transparent)" }}>
        <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all" style={{ left: checked ? 18 : 2 }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px]">{label}</span>
        {hint && <span className="block text-[10.5px] text-[var(--muted)]">{hint}</span>}
      </span>
    </button>
  );
}

export function Empty({ icon, title, body, action }: { icon: string; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <div className="mb-3 flex justify-center opacity-45"><Icon name={icon} size={40} /></div>
        <div className="mb-1 font-medium">{title}</div>
        {body && <div className="mx-auto mb-4 max-w-sm text-[12px] text-[var(--muted)]">{body}</div>}
        {action}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[var(--muted)]">
      <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent" style={{ animation: "os-spin 700ms linear infinite" }} />
      {label}
    </span>
  );
}

export function ErrorNote({ error, onDismiss }: { error: string | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div className="mb-2 flex items-start gap-2 rounded-[calc(var(--radius)*0.6)] border border-[var(--danger)] bg-[var(--danger)]/12 p-2.5 text-[12px]">
      <span aria-hidden>!</span>
      <span className="min-w-0 flex-1 break-words">{error}</span>
      {onDismiss && <button onClick={onDismiss} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss"><Icon name="close" size={11} /></button>}
    </div>
  );
}

/** Minimal, dependency-free Markdown renderer.
 *
 *  It escapes the source first and only then introduces tags, so model output
 *  can never inject markup into the OS. Shipping a full parser for what is
 *  mostly headings, lists, code and emphasis was not worth the bundle. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn("os-md text-[13px] leading-relaxed", className)} dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}

// Sentinel used to park fenced code while the rest of the document is
// transformed. Chosen so it cannot collide with real prose.
const FENCE = "@@WAIOS_CODE@@";

export function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const blocks: string[] = [];

  // Pull fenced code out first so its contents are never treated as markup.
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    blocks.push(`<pre class="os-pre" data-lang="${esc(lang)}"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `${FENCE}${blocks.length - 1}${FENCE}`;
  });

  text = esc(text);
  text = text
    .replace(/^######\s+(.*)$/gm, "<h6>$1</h6>")
    .replace(/^#####\s+(.*)$/gm, "<h5>$1</h5>")
    .replace(/^####\s+(.*)$/gm, "<h4>$1</h4>")
    .replace(/^###\s+(.*)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.*)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.*)$/gm, "<h1>$1</h1>")
    .replace(/^\s*&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^\s*[-*]{3,}\s*$/gm, "<hr>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');

  // Group consecutive list items into a single list element.
  text = text.replace(/(?:^[ \t]*[-*+][ \t]+.*$\n?)+/gm, (m) => {
    const items = m.trim().split(/\n/).map((l) => `<li>${l.replace(/^[ \t]*[-*+][ \t]+/, "")}</li>`).join("");
    return `<ul>${items}</ul>\n`;
  });
  text = text.replace(/(?:^[ \t]*\d+\.[ \t]+.*$\n?)+/gm, (m) => {
    const items = m.trim().split(/\n/).map((l) => `<li>${l.replace(/^[ \t]*\d+\.[ \t]+/, "")}</li>`).join("");
    return `<ol>${items}</ol>\n`;
  });

  text = text
    .split(/\n{2,}/)
    .map((p) => (/^\s*<(h\d|ul|ol|pre|blockquote|hr|table)/.test(p.trim()) || p.includes(FENCE) ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`))
    .join("\n");

  const restore = new RegExp(FENCE.replace(/[@]/g, "@") + "(\\d+)" + FENCE, "g");
  return text.replace(restore, (_m, i) => blocks[Number(i)] ?? "");
}

/** Copy-to-clipboard with the confirmation the user actually needs. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      className={cn("os-btn !py-1 text-[11px]", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // The Clipboard API needs a secure context; fall back to a selection copy.
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.append(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        timer.current = setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
