/* Observatory queries over the span ring — pure.

   Filtering and search are string work; cost-per-completed-task is the metric
   that decides whether a change to an agent was a win (a cheaper run that
   fails more often is not cheaper). Both are here so the numbers are tested. */

export interface SpanLike {
  id: string;
  parentId: string | null;
  name: string;
  kind: string;
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  text?: string;
  input?: string;
  error?: string;
  runId?: string;
  role?: string;
}

export interface SpanFilter {
  query: string;
  kind: string; // "all" or a span kind
  status: "all" | "error" | "open" | "ok";
}

export function spanStatus(s: SpanLike): "error" | "open" | "ok" {
  if (s.error) return "error";
  if (s.endedAt === undefined) return "open";
  return "ok";
}

/** Every whitespace-separated term must appear in name, text, input, error, role or runId. */
export function filterSpans<T extends SpanLike>(spans: T[], f: SpanFilter): T[] {
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return spans.filter((s) => {
    if (f.kind !== "all" && s.kind !== f.kind) return false;
    if (f.status !== "all" && spanStatus(s) !== f.status) return false;
    if (!terms.length) return true;
    const hay = [s.name, s.text, s.input, s.error, s.role, s.runId].filter(Boolean).join("\n").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** The root of a span, following parent links (cycle-safe). */
export function rootOf(byId: Map<string, SpanLike>, s: SpanLike): SpanLike {
  let cur = s;
  const seen = new Set<string>();
  while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.parentId)!;
  }
  return cur;
}

export interface TaskRow {
  key: string;
  label: string;
  spans: number;
  costUsd: number;
  status: "completed" | "failed" | "running";
}

export interface TaskCost {
  tasks: TaskRow[];
  completed: number;
  failed: number;
  running: number;
  /** Everything spent, on finished tasks of either outcome. */
  spentUsd: number;
  /** spentUsd / completed. Null when nothing completed — never a fake zero. */
  costPerCompletedUsd: number | null;
  /** Share of finished tasks that completed, 0..1, or null with none finished. */
  successRate: number | null;
}

/**
 * Group spans into tasks: by runId when a span has one, else by its root span.
 * A task is running while any span is open, failed if any span errored or no
 * model span produced text, and completed otherwise. Cost per completed task
 * charges failed tasks' spend to the successes, which is the honest version.
 */
export function costPerTask(spans: SpanLike[]): TaskCost {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const groups = new Map<string, { label: string; list: SpanLike[] }>();
  for (const s of spans) {
    const root = rootOf(byId, s);
    const key = s.runId ?? root.runId ?? `root:${root.id}`;
    const g = groups.get(key) ?? { label: s.runId ? `run ${s.runId}` : root.name, list: [] };
    g.list.push(s);
    groups.set(key, g);
  }
  const tasks: TaskRow[] = [];
  for (const [key, g] of groups) {
    const cost = g.list.reduce((a, s) => a + (s.costUsd ?? 0), 0);
    let status: TaskRow["status"];
    if (g.list.some((s) => s.endedAt === undefined && !s.error)) status = "running";
    else if (g.list.some((s) => s.error)) status = "failed";
    else {
      const models = g.list.filter((s) => s.kind === "model");
      status = models.length && models.every((s) => !(s.text ?? "").trim()) ? "failed" : "completed";
    }
    tasks.push({ key, label: g.label, spans: g.list.length, costUsd: cost, status });
  }
  const completed = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const running = tasks.filter((t) => t.status === "running").length;
  const spentUsd = tasks.filter((t) => t.status !== "running").reduce((a, t) => a + t.costUsd, 0);
  return {
    tasks,
    completed,
    failed,
    running,
    spentUsd,
    costPerCompletedUsd: completed ? spentUsd / completed : null,
    successRate: completed + failed ? completed / (completed + failed) : null,
  };
}
