"use client";

import { useMemo, useState } from "react";
import type { AppProps } from "@/kernel/types";
import { useCustomWidgets } from "@/kernel/widgets";
import { useCustomThemes, allThemes } from "@/kernel/customthemes";
import { useUpdates, currentTuning } from "@/kernel/updates";
import { ask } from "@/lib/useAI";
import {
  TUNABLE, updatePrompt, parseUpdate, planApply, validateTheme, describe,
  type UpdateProposal, type ProposedTheme, type Rejected,
} from "@/lib/sysupdate";
import { passesGates } from "@/lib/palette";
import { ModelOverride, overrideOpts, type ModelChoice } from "@/shell/ModelOverride";
import { Empty, ErrorNote, Spinner, Tabs } from "./_ui";
import { Icon } from "@/shell/icons";
import { TrialBar, useUpdateTrial } from "./_updateTrial";
import { TRIAL_MS } from "@/lib/trial";

/* An OS that can rewrite itself, without being able to break itself.
 *
 * The three affordances that make that true are all in this file's UI rather
 * than hidden in a confirm dialog: you SEE the theme rendered before it is
 * yours, you can EDIT any of it, and every apply is one click from being
 * undone. Everything the model sends is validated in src/lib/sysupdate.ts
 * first — see the trust rules at the top of that file. */

const TUNABLE_BY_KEY = new Map(TUNABLE.map((t) => [t.key, t]));
const fmt = (v: unknown) =>
  typeof v === "boolean" ? (v ? "on" : "off") : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v ?? "unset");

type Tab = "propose" | "history";

export default function Updates({}: AppProps) {
  const [tab, setTab] = useState<Tab>("propose");
  const versions = useUpdates((s) => s.versions);
  return (
    <div className="flex h-full flex-col">
      <Tabs
        tabs={[
          { id: "propose", label: "Propose", icon: "sparkles" },
          { id: "history", label: `History (${versions.length})`, icon: "backup" },
        ]}
        active={tab}
        onChange={(t) => setTab(t as Tab)}
      />
      {tab === "propose" ? <ProposeTab /> : <HistoryTab />}
      <TrialBar />
    </div>
  );
}

/* ── propose ─────────────────────────────────────────────────────────────── */

const IDEAS = [
  "A warm, low-contrast theme for working at night",
  "Make the whole OS feel faster and less decorated",
  "A high-contrast theme I can read in direct sunlight",
  "Add a widget that shows what I should do next",
  "Something playful — round corners, bright accents",
];

function ProposeTab() {
  const [want, setWant] = useState("");
  const [choice, setChoice] = useState<ModelChoice>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<UpdateProposal | null>(null);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [include, setInclude] = useState<{ themes: boolean[]; widgets: boolean[]; tuning: boolean[] }>({ themes: [], widgets: [], tuning: [] });

  const generatedThemes = useCustomThemes((s) => s.themes);
  const customWidgets = useCustomWidgets((s) => s.widgets);

  const generate = async () => {
    setBusy(true); setError(null); setProposal(null); setRejected([]);
    try {
      const res = await ask({
        system: "You design operating system updates. You return one JSON object and nothing else.",
        messages: [{
          role: "user",
          content: updatePrompt(want, {
            existingThemes: allThemes(generatedThemes).map((t) => t.name),
            existingWidgets: customWidgets.map((w) => w.name),
            current: currentTuning(),
          }),
        }],
        persona: false, maxTokens: 6000, temperature: 0.8, ...overrideOpts(choice),
      });
      const r = parseUpdate(res.text);
      setRejected(r.rejected);
      if (!r.ok) { setError(r.error ?? "Nothing usable came back."); return; }
      setProposal(r.proposal);
      setInclude({
        themes: r.proposal.themes.map(() => true),
        widgets: r.proposal.widgets.map(() => true),
        tuning: r.proposal.tuning.map(() => true),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The model call failed.");
    } finally { setBusy(false); }
  };

  return (
    <div className="h-full overflow-y-auto p-3">
      <ErrorNote error={error} onDismiss={() => setError(null)} />

      <div className="os-card mb-3 !p-2.5">
        <div className="os-label mb-1.5">What should change?</div>
        <textarea
          className="os-input mb-1.5 w-full resize-none text-[12px]" rows={2} value={want}
          onChange={(e) => setWant(e.target.value)}
          placeholder="Leave empty and the model picks something. Or describe a theme, a widget, or how the OS should feel."
        />
        <div className="mb-2 flex flex-wrap gap-1">
          {IDEAS.map((i) => (
            <button key={i} className="os-chip !py-0 !text-[10px]" onClick={() => setWant(i)}>{i}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="os-btn" data-variant="primary" disabled={busy} onClick={() => void generate()}>
            <Icon name="sparkles" size={13} /> {busy ? "Designing…" : "Propose an update"}
          </button>
          <ModelOverride id="sysupdate" value={choice} onChange={setChoice} />
          {busy && <Spinner />}
        </div>
        <p className="mt-1.5 text-[10.5px] leading-snug text-[var(--muted)]">
          Nothing is applied until you say so. A theme that fails the contrast checks is thrown
          away rather than shown, and only the {TUNABLE.length} settings on the allowlist can be
          touched — never your keys, models or dock.
        </p>
      </div>

      {rejected.length > 0 && (
        <details className="os-card mb-3 !p-2.5 text-[10.5px] text-[var(--muted)]">
          <summary className="cursor-pointer">{rejected.length} item(s) discarded by validation</summary>
          {rejected.map((r, i) => <p key={i} className="mt-1">· <b>{r.what}</b>: {r.reason}</p>)}
        </details>
      )}

      {proposal
        ? <Preview proposal={proposal} setProposal={setProposal} include={include} setInclude={setInclude} />
        : !busy && (
          <Empty icon="sparkles" title="No proposal yet"
            body="Ask for a change and it arrives here as a preview you can edit before anything is applied." />
        )}
    </div>
  );
}

/* ── preview, and editing in place ───────────────────────────────────────── */

function Preview({ proposal, setProposal, include, setInclude }: {
  proposal: UpdateProposal;
  setProposal: (p: UpdateProposal) => void;
  include: { themes: boolean[]; widgets: boolean[]; tuning: boolean[] };
  setInclude: (i: { themes: boolean[]; widgets: boolean[]; tuning: boolean[] }) => void;
}) {
  const before = useMemo(() => currentTuning(), []);
  const apply = useUpdates((s) => s.apply);
  const [applied, setApplied] = useState<string | null>(null);

  const plan = useMemo(() => planApply(proposal, before, include), [proposal, before, include]);

  const toggle = (group: "themes" | "widgets" | "tuning", i: number) =>
    setInclude({ ...include, [group]: include[group].map((v, j) => (j === i ? !v : v)) });

  const editTheme = (i: number, patch: Partial<ProposedTheme>) =>
    setProposal({ ...proposal, themes: proposal.themes.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const doApply = () => {
    const v = apply(proposal, include);
    setApplied(v ? v.title : null);
  };

  /* Apply for real, then let the countdown decide: Keep, or it goes back.
     The proposal stays on screen so a reverted trial can be tried again. */
  const startTrial = useUpdateTrial((s) => s.start);
  const trial = useUpdateTrial((s) => s.trial);
  const lastTrial = useUpdateTrial((s) => s.last);
  const doTry = () => {
    const v = apply(proposal, include);
    if (v) startTrial(v.id, v.title);
  };

  if (applied !== null) {
    return (
      <div className="os-card !p-3">
        <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium">
          <Icon name="check" size={14} style={{ color: "var(--accent)" }} /> Applied
        </div>
        <p className="text-[11.5px] text-[var(--muted)]">
          &ldquo;{applied}&rdquo; is live. Every part of it is listed under History, where one click puts it back.
        </p>
      </div>
    );
  }

  return (
    <div className="os-card !p-2.5">
      <div className="mb-0.5 text-[13px] font-medium">{proposal.title}</div>
      {proposal.summary && <p className="mb-2 text-[11px] leading-snug text-[var(--muted)]">{proposal.summary}</p>}

      {proposal.themes.map((t, i) => (
        <ThemeCard key={t.id + i} theme={t} on={include.themes[i] !== false}
          onToggle={() => toggle("themes", i)} onEdit={(patch) => editTheme(i, patch)} />
      ))}

      {proposal.widgets.map((w, i) => (
        <div key={w.name + i} className="mb-2 rounded border border-[var(--border)] p-2">
          <label className="flex items-center gap-1.5 text-[12px]">
            <input type="checkbox" checked={include.widgets[i] !== false} onChange={() => toggle("widgets", i)} />
            <Icon name="widgets" size={12} style={{ color: "var(--accent)" }} />
            <b>{w.name}</b>
            <span className="text-[10.5px] text-[var(--muted)]">{w.w}x{w.h} · {w.html.length} chars</span>
          </label>
          <WidgetPreview html={w.html} w={w.w} h={w.h} />
          <details className="mt-1 text-[10.5px] text-[var(--muted)]">
            <summary className="cursor-pointer">Edit markup</summary>
            <textarea
              className="os-input mt-1 w-full resize-y font-mono text-[10.5px]" rows={6} value={w.html}
              onChange={(e) => setProposal({ ...proposal, widgets: proposal.widgets.map((x, j) => (j === i ? { ...x, html: e.target.value } : x)) })}
            />
          </details>
        </div>
      ))}

      {proposal.tuning.length > 0 && (
        <div className="mb-2 rounded border border-[var(--border)] p-2">
          <div className="os-label mb-1">Settings</div>
          {proposal.tuning.map((t, i) => {
            const def = TUNABLE_BY_KEY.get(t.key);
            const unchanged = before[t.key] === t.value;
            return (
              <label key={t.key} className="mb-1 flex items-center gap-1.5 text-[11.5px]">
                <input type="checkbox" checked={include.tuning[i] !== false} onChange={() => toggle("tuning", i)} />
                <span className="min-w-0 flex-1 truncate">{def?.label ?? t.key}</span>
                <span className="text-[var(--muted)]">{fmt(before[t.key])}</span>
                <Icon name="chevronRight" size={10} />
                <span style={{ color: "var(--accent)" }}>{fmt(t.value)}</span>
                {unchanged && <span className="text-[9.5px] text-[var(--muted)]">(already)</span>}
              </label>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="os-btn" data-variant="primary" disabled={!plan.changes.length} onClick={doApply}>
          <Icon name="check" size={13} /> Apply {plan.changes.length ? `(${plan.changes.length})` : ""}
        </button>
        <button
          className="os-btn"
          disabled={!plan.changes.length || !!trial}
          onClick={doTry}
          title="Apply it to the whole OS, then revert automatically unless you press Keep"
        >
          <Icon name="eye" size={13} /> {trial ? "Trying…" : `Try for ${TRIAL_MS / 1000}s`}
        </button>
        <span className="text-[10.5px] text-[var(--muted)]">
          {plan.changes.length ? `${describe(proposal)} proposed, ${plan.changes.length} change(s) selected` : "Nothing selected"}
        </span>
      </div>
      {lastTrial && !trial && (
        <p className="mt-1.5 text-[10.5px] text-[var(--muted)]" role="status">
          Trial of &ldquo;{lastTrial.title}&rdquo; {lastTrial.result === "kept" ? "kept. It is listed under History." : "reverted."}
          {lastTrial.skipped ? ` ${lastTrial.skipped} setting(s) you changed during the trial were left as you set them.` : ""}
        </p>
      )}
    </div>
  );
}

/** A theme rendered in its own tokens. The swatch row is the honest part: the
 *  card below it is built from the proposed vars, so what is on screen is what
 *  applying would give you. */
function ThemeCard({ theme, on, onToggle, onEdit }: {
  theme: ProposedTheme; on: boolean; onToggle: () => void; onEdit: (p: Partial<ProposedTheme>) => void;
}) {
  const gates = passesGates(theme.vars);
  const revalidated = validateTheme(theme);
  const editable = ["--bg", "--panel-solid", "--text", "--muted", "--accent", "--accent2"] as const;

  return (
    <div className="mb-2 rounded border border-[var(--border)] p-2">
      <label className="mb-1.5 flex items-center gap-1.5 text-[12px]">
        <input type="checkbox" checked={on} onChange={onToggle} />
        <Icon name="personalize" size={12} style={{ color: "var(--accent)" }} />
        <b>{theme.name}</b>
        <span className="text-[10.5px] text-[var(--muted)]">{theme.dark ? "dark" : "light"}</span>
      </label>

      <div
        className="rounded p-2"
        style={{ background: theme.vars["--panel-solid"], color: theme.vars["--text"], border: `1px solid ${theme.vars["--border"]}` }}
      >
        <div className="mb-1.5 flex h-6 overflow-hidden rounded">
          {(["--bg", "--bg2", "--panel-solid", "--accent", "--accent2"] as const).map((v) => (
            <div key={v} className="flex-1" style={{ background: theme.vars[v] }} title={`${v} ${theme.vars[v]}`} />
          ))}
        </div>
        <p className="text-[11px]">The quick brown fox jumps over the lazy dog.</p>
        <p className="mb-1.5 text-[11px]" style={{ color: theme.vars["--muted"] }}>Secondary text, at the size it really renders.</p>
        <span className="inline-block rounded px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: theme.vars["--accent"], color: theme.vars["--on-accent"] }}>Primary button</span>
      </div>

      <details className="mt-1 text-[10.5px] text-[var(--muted)]">
        <summary className="cursor-pointer">Adjust colours</summary>
        <div className="mt-1 grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))" }}>
          {editable.map((v) => (
            <label key={v} className="flex items-center gap-1">
              <input type="color" className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                value={/^#[0-9a-f]{6}$/i.test(theme.vars[v]) ? theme.vars[v] : "#000000"}
                onChange={(e) => onEdit({ vars: { ...theme.vars, [v]: e.target.value } })} />
              <span className="truncate">{v.replace("--", "")}</span>
            </label>
          ))}
          <label className="col-span-full flex items-center gap-1">
            <span>name</span>
            <input className="os-input !py-0.5 text-[10.5px]" value={theme.name} onChange={(e) => onEdit({ name: e.target.value })} />
          </label>
        </div>
      </details>

      {/* Re-checked on every edit, so hand-editing a colour into an unreadable
          one is caught here rather than after it is applied. */}
      {!gates.ok && <p className="mt-1 text-[10.5px] text-[var(--danger)]">Fails contrast: {gates.failures.join("; ")}</p>}
      {gates.ok && !revalidated.ok && <p className="mt-1 text-[10.5px] text-[var(--danger)]">{revalidated.reason}</p>}
    </div>
  );
}

/** Sandboxed, and deliberately without allow-same-origin: generated markup
 *  must not be able to reach this origin's storage or the OS behind it. */
function WidgetPreview({ html, w, h }: { html: string; w: number; h: number }) {
  const doc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:dark}
    html,body{margin:0;height:100%;font:12px/1.45 system-ui,sans-serif;color:#e8eefc;background:transparent}
  </style></head><body>${html}</body></html>`, [html]);
  return (
    <iframe
      title="Widget preview" sandbox="allow-scripts" srcDoc={doc}
      className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg2)]"
      style={{ height: Math.min(260, h), maxWidth: w }}
    />
  );
}

/* ── history ─────────────────────────────────────────────────────────────── */

function HistoryTab() {
  const versions = useUpdates((s) => s.versions);
  const revert = useUpdates((s) => s.revert);
  const forget = useUpdates((s) => s.forget);
  const [note, setNote] = useState<string | null>(null);

  if (!versions.length) {
    return (
      <div className="h-full overflow-y-auto p-3">
        <Empty icon="backup" title="No updates yet" body="Applied updates are listed here, newest first, each one revertible." />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      {note && <p className="os-card mb-2 !p-2 text-[11px] text-[var(--muted)]">{note}</p>}
      {versions.map((v) => (
        <div key={v.id} className="os-card mb-2 !p-2.5">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{v.title}</span>
            {v.revertedAt && <span className="os-chip !py-0 !text-[9.5px]">reverted</span>}
            <span className="text-[10px] text-[var(--muted)]">{new Date(v.at).toLocaleString()}</span>
          </div>
          {v.summary && <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">{v.summary}</p>}
          <ul className="mt-1.5">
            {v.changes.map((c, i) => (
              <li key={i} className="text-[10.5px] text-[var(--muted)]">· {c.label}</li>
            ))}
          </ul>
          <div className="mt-1.5 flex gap-1.5">
            <button
              className="os-btn !py-1 text-[11px]" disabled={!!v.revertedAt}
              onClick={() => {
                const r = revert(v.id);
                setNote(r.skipped.length
                  ? `Reverted. ${r.skipped.length} setting(s) were left alone because you changed them since: ${r.skipped.join(", ")}.`
                  : "Reverted everything this update changed.");
              }}
            >
              <Icon name="refresh" size={12} /> Revert
            </button>
            <button className="os-btn !py-1 text-[11px]" onClick={() => forget(v.id)}>Remove from history</button>
          </div>
        </div>
      ))}
    </div>
  );
}
