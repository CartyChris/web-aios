"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { download } from "@/lib/format";
import { Markdown, CopyButton, ErrorNote, Empty, Spinner } from "./_ui";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import { relTime } from "@/lib/format";

/* ────────────────────────────────────────────────────────────────────────────
   Builder Labs — ported from Arcwright Beta 0.4.

   Arcwright's Builder Labs were VS Code commands that wrote structured document
   sets into a repo. The valuable part was never the file-writing — it was the
   prompt shape: each lab asks for a specific, auditable artifact rather than an
   essay. Those shapes are preserved verbatim in intent; the output lands in the
   OS filesystem instead of a workspace folder.
   ──────────────────────────────────────────────────────────────────────────── */

interface Lab {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  placeholder: string;
  prompt: string;
}

const LABS: Lab[] = [
  {
    id: "blueprint", name: "System Blueprint", icon: "claim",
    blurb: "Architecture overview, layer graph, contract seeds, one ADR and implementation tickets.",
    placeholder: "Describe the system you are building…",
    prompt: `Produce a system blueprint as markdown with these sections, in order:

## Architecture overview
Two paragraphs. Name the boundaries and what crosses them.

## Layer graph
A mermaid \`graph TD\` diagram of the layers and their dependencies.

## Contracts
The key interfaces as typed signatures. Real types, not prose.

## ADR-001
Title, Context, Decision, Consequences. Pick the single most consequential decision — the one hardest to reverse — and record it honestly, including what it costs.

## Implementation tickets
A numbered list. Each ticket: what to build, and the observable condition that means it is done.`,
  },
  {
    id: "testmatrix", name: "Test Matrix", icon: "layout",
    blurb: "Validation lanes, a CSV matrix, fixtures and a smoke script.",
    placeholder: "Describe what needs testing…",
    prompt: `Produce a test matrix as markdown:

## Validation lanes
Each lane: what it protects against, and what it costs to run.

## Matrix
A markdown table: Case | Input | Expected | Lane | Priority. Cover the error paths, not just the happy path — a matrix that only tests success is decoration.

## Fixtures
Concrete fixture data as JSON.

## Smoke script
A runnable shell script that exercises the critical path and exits non-zero on failure.`,
  },
  {
    id: "release", name: "Release Pilot", icon: "report",
    blurb: "Release plan, changelog draft, risk register and a rollback plan.",
    placeholder: "Describe the release…",
    prompt: `Produce a release plan as markdown:

## Release plan
Ordered steps with the owner and the gate for each.

## Changelog
Grouped under Added / Changed / Fixed / Removed. Write for users, not committers.

## Risk register
A table: Risk | Likelihood | Impact | Mitigation | Trigger to abort.

## Rollback plan
The exact steps to undo this release, and how long each takes. If something cannot be rolled back, say so plainly — that is the most important line in the document.`,
  },
  {
    id: "deps", name: "Dependency Sentinel", icon: "shield",
    blurb: "Bill of materials, licence review, risk ranking and an update strategy.",
    placeholder: "Paste a package.json, Cargo.toml, pyproject.toml, go.mod or requirements.txt…",
    prompt: `Analyse this dependency manifest:

## Bill of materials
A table: Package | Version | Purpose | Licence (state when you are unsure rather than guessing).

## Risk ranking
The dependencies that carry the most risk, and why — abandonment, breadth of transitive tree, privileged access, single maintainer.

## Licence review
Anything copyleft, ambiguous, or incompatible with commercial distribution. Say when you cannot determine a licence.

## Update strategy
Which to pin, which to float, and the order to upgrade in.

## Audit commands
The exact commands to run for this ecosystem.`,
  },
  {
    id: "designsystem", name: "Design System Kit", icon: "personalize",
    blurb: "Tokens, component inventory and an accessibility matrix.",
    placeholder: "Describe the product and its visual direction…",
    prompt: `Produce a design system starter:

## Tokens
CSS custom properties for colour, type scale, spacing, radius and elevation. Real values.

## Component inventory
A table: Component | States | Variants | Notes.

## Accessibility matrix
A table: Component | Keyboard | Screen reader | Contrast | Focus. Name the specific WCAG criterion where one applies.

## State gallery
A single self-contained HTML snippet rendering every component in every state.`,
  },
  {
    id: "gamefeel", name: "Game Feel Lab", icon: "forge3d",
    blurb: "Tuning table, input and camera checklist, playtest scorecard.",
    placeholder: "Describe the game and how it currently feels…",
    prompt: `Produce a game feel analysis:

## Tuning table
A table: Parameter | Current | Suggested | What the player will notice. Give numbers, not adjectives.

## Input and camera checklist
Buffer windows, coyote time, dead zones, camera lead and lag, screen shake budget — with millisecond values.

## Playtest scorecard
The questions to ask a playtester that produce actionable answers rather than politeness.

## Debug overlay spec
What to draw on screen while tuning, and why each readout earns its place.`,
  },
];

export default function Labs({}: AppProps) {
  const vfs = useVFS();
  const [lab, setLab] = useState<Lab | null>(null);
  // Each lab keeps its own brief, so hopping between labs loses nothing.
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const input = lab ? inputs[lab.id] ?? "" : "";
  const setInput = (v: string) => { if (lab) setInputs((m) => ({ ...m, [lab.id]: v })); };
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** Earlier runs of this lab, straight from the filesystem: Save writes them
   *  to /labs, so the list is whatever is really there. */
  const past = useMemo(
    () => (lab ? Object.values(vfs.nodes).filter((n) => n.kind === "file" && n.path.startsWith(`/labs/${lab.id}-`)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12) : []),
    [vfs.nodes, lab],
  );

  const run = useCallback(async () => {
    if (!lab || !input.trim() || busy) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true); setError(null); setOutput(""); setSavedPath(null);
    try {
      const res = await ask({
        messages: [{ role: "user", content: input }],
        system: `${lab.prompt}\n\nWrite the document and nothing else. Be concrete and specific — a blueprint full of placeholders is worse than no blueprint. Where you genuinely do not know something, write what you would need to find out.`,
        maxTokens: 5000,
        signal: ctrl.signal,
        onDelta: (_d, full) => setOutput(full),
      });
      setOutput(res.text);
    } catch (e) {
      // A stop keeps whatever had streamed in; it is marked, not discarded.
      if ((e as Error).name === "AbortError") setError("Stopped. The partial document is kept below.");
      else setError(e instanceof Error ? e.message : "Lab failed.");
    } finally { setBusy(false); abortRef.current = null; }
  }, [lab, input, busy]);

  return (
    <div className="app-split flex h-full">
      <div className="app-sidebar w-52 shrink-0 overflow-y-auto border-r border-[var(--border)] p-2">
        {LABS.map((l) => (
          <button
            key={l.id}
            onClick={() => { setLab(l); setOutput(""); setSavedPath(null); }}
            className={cn("mb-1 block w-full rounded-[calc(var(--radius)*0.6)] px-2 py-2 text-left", lab?.id === l.id ? "bg-[var(--accent)]/16 ring-1 ring-[var(--accent)]/40" : "hover:bg-white/6")}
          >
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
              <Icon name={l.icon} size={13} style={{ color: "var(--accent)" }} />{l.name}
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-[var(--muted)]">{l.blurb}</div>
          </button>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!lab ? (
          <Empty icon="labs" title="Pick a lab" body="Each lab asks the model for a specific, auditable artifact — a blueprint, a test matrix, a rollback plan — rather than an essay about one." />
        ) : (
          <>
            <div className="shrink-0 border-b border-[var(--border)] p-2.5">
              <ErrorNote error={error} onDismiss={() => setError(null)} />
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={3}
                placeholder={lab.placeholder}
                className="os-input mb-2 resize-none text-[12px]"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <button className="os-btn !py-1 text-[11px]" data-variant="primary" onClick={run} disabled={busy || !input.trim()}>
                  {busy ? "Running…" : `Run ${lab.name}`}
                </button>
                {busy && <Spinner label={`${output.length.toLocaleString()} chars`} />}
                {busy && <button className="os-btn !py-1 text-[11px]" onClick={() => abortRef.current?.abort()}><Icon name="stop" size={11} className="mr-1" />Stop</button>}
                {!busy && output && <span className="text-[10.5px] tabular-nums text-[var(--muted)]">{output.split(/\s+/).filter(Boolean).length.toLocaleString()} words</span>}
                <div className="flex-1" />
                {output && (
                  <>
                    <CopyButton text={output} />
                    <button
                      className="os-btn !py-1 text-[11px]"
                      onClick={() => { const p = `/labs/${lab.id}-${Date.now()}.md`; vfs.write(p, output, { appId: "labs" }); setSavedPath(p); bus.emit("notify", { title: "Saved to Files", body: p, kind: "success" }); }}
                      disabled={busy}
                    >
                      {savedPath ? "Saved" : "Save"}
                    </button>
                    <button className="os-btn !py-1 text-[11px]" onClick={() => download(`${lab.id}.md`, output, "text/markdown")}>Export</button>
                  </>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {output ? <Markdown text={output} /> : <div className="py-10 text-center text-[12px] text-[var(--muted)]">{lab.blurb}</div>}
              {!busy && past.length > 0 && (
                <div className="mt-6 border-t border-[var(--border)] pt-3">
                  <div className="os-label mb-1.5">Saved runs of this lab ({past.length})</div>
                  <div className="grid gap-1">
                    {past.map((f) => (
                      <button
                        key={f.path}
                        className={cn("flex items-center gap-2 rounded px-2 py-1 text-left text-[11.5px] hover:bg-white/6", savedPath === f.path && "bg-[var(--accent)]/12")}
                        onClick={() => { setOutput(vfs.read(f.path)?.content ?? ""); setSavedPath(f.path); }}
                      >
                        <Icon name="file" size={12} />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 text-[10px] text-[var(--muted)]">{relTime(f.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
