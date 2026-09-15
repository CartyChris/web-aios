import type { Criterion, CriterionCheck, EvalCategory, EvalTask } from "./types";

/* ────────────────────────────────────────────────────────────────────────────
   The golden set: a person writing down what good looks like.

   Two properties make this file worth more than the code it tests.

   First, every task carries an ANTI-CASE — an objective the same definition of
   done must REFUSE. A positive-only suite proves a check still fires, and a
   check that fires on everything satisfies every positive test ever written.
   The anti is what separates a test from decoration, so `validateTask` refuses
   a task without one and the suite is not green unless every anti failed.

   Second, every task pins its clock. A date-dependent task whose expected
   answer moves with the calendar stops being a regression test the day after
   it is written; `clockAt` is injected into ToolContext.now so the same task
   gives the same answer in 2030.

   Where the spec states a figure, it is marked `source: "spec"`. Where the
   figure comes from the fixture tables, it is marked
   `source: "fixtures_unreconciled"` — fixtures.ts is the source of truth and
   these must be reconciled against it before a green here means anything. An
   unreconciled figure makes the suite RED, never falsely green, which is the
   safe direction to be wrong in.
   ──────────────────────────────────────────────────────────────────────────── */

/** The person who decided what good looks like. A DoD nobody owns is nobody's
 *  job, and `dodValidate` rejects an empty owner for exactly that reason. */
export const SEED_OWNER = "Chris Carty";

/** 2026-04-15T12:00:00Z. Mid-quarter, inside the fixture window, and the date
 *  the spec's own `date_math` worked example counts from. */
export const SEED_CLOCK_AT = 1_776_254_400_000;

export interface Pin<V extends string | number> {
  value: V;
  /** "spec": stated in the specification, so a change here is a real change.
   *  "fixtures_unreconciled": read off fixtures.ts, not yet verified against
   *  it by anyone. */
  source: "spec" | "fixtures_unreconciled";
  note: string;
}

const spec = <V extends string | number>(value: V, note: string): Pin<V> =>
  ({ value, source: "spec", note });

const unreconciled = <V extends string | number>(value: V, note: string): Pin<V> =>
  ({ value, source: "fixtures_unreconciled", note });

export const PINNED = {
  arrEnterprise2026Q1: spec(
    4_182_000,
    "The spec's worked kpi observation: arr 2026Q1 enterprise = 4,182,000 USD.",
  ),
  euPersonalDataRuleId: spec(
    "EU-PII-03",
    "The spec's worked policy_check observation names this rule id.",
  ),
  pricingDocId: spec(
    "doc_pricing_v4",
    "The spec's worked search_docs observation names this document id.",
  ),
  datePlus45Days: spec(
    "2026-05-30",
    "SEED_CLOCK_AT plus 45 days, matching the spec's worked date_math observation.",
  ),
  enterpriseRevenueRowCount: spec(
    12,
    "Derived from the stated fixture shape: revenue is 36 rows, 12 months across 3 segments.",
  ),

  smbMrrGrowthPct: unreconciled(
    7.4,
    "Percentage MRR growth for smb between 2026Q1 and 2026Q2. Recompute from fixtures.ts.",
  ),
  enterpriseMrrSum: unreconciled(
    4_182_000,
    "Sum of mrr over the 12 enterprise revenue rows. Recompute from fixtures.ts.",
  ),
  avgMrrPerEnterpriseCustomer: unreconciled(
    1_416.5,
    "Mean mrr per enterprise customer across 2026Q1. Recompute from fixtures.ts.",
  ),
  lookupSecondApprovalSentence: unreconciled(
    "a second approver",
    "A phrase unique to the second 'approval' sentence in the onboarding runbook.",
  ),
  refundWindowPhrase: unreconciled(
    "no refund after the renewal date",
    "The refund clause the second search_docs query must surface.",
  ),
  enterpriseListPrice: unreconciled(
    "2,400",
    "List price of the enterprise plan as the pricing document states it.",
  ),
  allowRuleId: unreconciled(
    "EU-AGG-01",
    "The rule id under which anonymised aggregates may move between EU regions.",
  ),
} as const;

/** Every figure still owed a reconciliation against fixtures.ts.
 *
 *  Exported rather than left as a comment so the gap is greppable and a test
 *  can assert it shrinks to zero rather than being quietly forgotten. */
export const UNRECONCILED_FIGURES: string[] = Object.entries(PINNED)
  .filter(([, pin]) => pin.source === "fixtures_unreconciled")
  .map(([key]) => key)
  .sort();

interface CritOpts {
  by?: Criterion["by"];
  weight?: number;
  required?: boolean;
}

const crit = (
  id: string,
  label: string,
  expectation: string,
  check: CriterionCheck,
  opts: CritOpts = {},
): Criterion => ({
  id,
  label,
  expectation,
  check,
  by: opts.by ?? "fixed",
  weight: opts.weight ?? 1,
  required: opts.required ?? true,
});

interface TaskInit {
  id: string;
  title: string;
  category: EvalCategory;
  objective: string;
  criteria: Criterion[];
  anti: { objective: string; reason: string };
  tags: string[];
  passThreshold?: number;
  repeat?: number;
  fixtures?: Record<string, unknown>;
}

const task = (t: TaskInit): EvalTask => ({
  id: t.id,
  title: t.title,
  category: t.category,
  objective: t.objective,
  fixtures: t.fixtures ?? {},
  dod: {
    id: `dod-${t.id}`,
    label: t.title,
    criteria: t.criteria,
    passThreshold: t.passThreshold ?? 1,
    owner: SEED_OWNER,
  },
  anti: t.anti,
  ...(t.repeat === undefined ? {} : { repeat: t.repeat }),
  origin: "seed",
  createdAt: SEED_CLOCK_AT,
  tags: t.tags,
  clockAt: SEED_CLOCK_AT,
});

/* A regex criterion is met when the pattern MATCHES, so forbidding something
   means writing a pattern that matches only in its absence. `[\s\S]` rather
   than `.` because the answer is multi-line and `.` stops at a newline — a
   forbidding pattern that gives up at the first line break would accept the
   very figure it exists to reject. */
const NO_DOLLAR_FIGURE = "^(?![\\s\\S]*\\$\\s?[0-9])";

export const SEED_TASKS: EvalTask[] = [
  task({
    id: "g-kpi-single",
    title: "A KPI is looked up, never assembled",
    category: "fixed_logic",
    objective: "What was ARR for the enterprise segment in 2026Q1?",
    criteria: [
      crit(
        "c-kpi-once",
        "kpi called exactly once",
        "The kpi tool answers it in one call; the figure is not rebuilt out of the revenue table.",
        { kind: "tool_called", tool: "kpi", times: 1 },
        { weight: 2 },
      ),
      crit(
        "c-figure",
        "The figure is the computed one",
        `The answer states ${PINNED.arrEnterprise2026Q1.value.toLocaleString("en-US")} to within a dollar.`,
        { kind: "number_within", expected: PINNED.arrEnterprise2026Q1.value, tolerance: 1 },
        { weight: 3 },
      ),
      crit(
        "c-steps",
        "Four steps is enough",
        "A thought, the kpi call, a thought, the answer. More than four means it went looking elsewhere.",
        { kind: "max_steps", value: 4 },
      ),
    ],
    anti: {
      objective: "What was ARR for the enterprise segment in 2019Q1?",
      reason:
        "2019Q1 is outside the fixture window, so the only honest answer contains no figure. "
        + "If the 4,182,000 check still passes here it is matching something other than the number.",
    },
    tags: ["kpi", "no-improvised-numbers"],
  }),

  task({
    id: "g-kpi-growth",
    title: "Growth is two lookups and one calculation",
    category: "arithmetic",
    objective:
      "By what percentage did MRR grow for the smb segment between 2026Q1 and 2026Q2? "
      + "Use the kpi tool for each quarter and calc for the arithmetic.",
    criteria: [
      crit(
        "c-kpi-twice",
        "Both quarters are looked up",
        "Two kpi calls, one per quarter. A single call plus a remembered figure is the failure this pins.",
        { kind: "tool_called", tool: "kpi", times: 2 },
        { weight: 2 },
      ),
      crit(
        "c-calc",
        "The division is done by calc",
        "The percentage comes out of the calc tool, not out of prose arithmetic.",
        { kind: "tool_called", tool: "calc" },
        { weight: 2 },
      ),
      crit(
        "c-growth",
        "The growth figure is right",
        `The answer states ${PINNED.smbMrrGrowthPct.value} percent to within a thousandth.`,
        { kind: "number_within", expected: PINNED.smbMrrGrowthPct.value, tolerance: 0.001 },
        { weight: 3 },
      ),
    ],
    anti: {
      objective:
        "By what percentage did MRR grow for the partner segment between 2026Q1 and 2026Q2? "
        + "Use the kpi tool for each quarter and calc for the arithmetic.",
      reason:
        "There is no partner segment in the fixtures, so both kpi calls fail and no growth figure exists. "
        + "A DoD that still passes is reading the shape of the answer rather than its content.",
    },
    tags: ["kpi", "arithmetic"],
  }),

  task({
    id: "g-table-agg",
    title: "An aggregate is queried, not summed in prose",
    category: "fixed_logic",
    objective:
      "Using table_query, what is the total MRR across every revenue row for the enterprise segment, "
      + "and how many rows did that cover?",
    criteria: [
      crit(
        "c-table-query",
        "table_query does the aggregation",
        "The sum comes back from the query engine. A model adding twelve rows in its head is wrong confidently.",
        { kind: "tool_called", tool: "table_query" },
        { weight: 2 },
      ),
      crit(
        "c-agg-sum",
        "The aggregate asked for is a sum",
        "The call carries agg: \"sum\" — selecting the rows and adding them afterwards is the same prose arithmetic.",
        { kind: "tool_value_equals", tool: "table_query", path: "agg", equals: "sum" },
        { weight: 2 },
      ),
      crit(
        "c-total",
        "The total is the computed one",
        `The answer states ${PINNED.enterpriseMrrSum.value.toLocaleString("en-US")} to within a dollar.`,
        { kind: "number_within", expected: PINNED.enterpriseMrrSum.value, tolerance: 1 },
        { weight: 3 },
      ),
      crit(
        "c-row-count",
        "The row count is stated",
        `The answer says how many rows the aggregate covered: ${PINNED.enterpriseRevenueRowCount.value} of them.`,
        {
          kind: "regex",
          pattern: `\\b${PINNED.enterpriseRevenueRowCount.value}\\b[\\s\\S]{0,24}rows`,
          flags: "i",
        },
      ),
    ],
    anti: {
      objective:
        "Using table_query, what is the total MRR across every revenue row for the partner segment, "
        + "and how many rows did that cover?",
      reason:
        "The partner segment matches zero rows, so both the sum and the count must differ. "
        + "A where clause matching nothing is where an aggregate quietly returns 0 and a "
        + "happy-path check accepts it.",
    },
    tags: ["table", "aggregation"],
  }),

  task({
    id: "g-doc-multihop",
    title: "Two documents, one answer",
    category: "multi_hop",
    objective:
      "Which rule governs where customer personal data may be stored, and which document states it? "
      + "Read the documents rather than answering from memory.",
    criteria: [
      crit(
        "c-read-two",
        "Two documents are opened",
        "read_doc is called twice: the rule lives in one document and the confirmation in another.",
        { kind: "tool_called", tool: "read_doc", times: 2 },
        { weight: 3 },
      ),
      crit(
        "c-rule-id",
        "The rule id is quoted",
        `The answer names ${PINNED.euPersonalDataRuleId.value}, which is what an auditor checks.`,
        { kind: "contains", value: PINNED.euPersonalDataRuleId.value },
        { weight: 3 },
      ),
    ],
    anti: {
      objective:
        "Which rule governs the company's use of cryptocurrency for payroll, and which document states it?",
      reason:
        "Nothing in the eight-document corpus covers payroll in cryptocurrency, so the honest answer "
        + "names no rule id. A DoD that still finds EU-PII-03 here is matching a rule nobody asked about.",
    },
    tags: ["documents", "multi-hop"],
  }),

  task({
    id: "g-lookup-cursor",
    title: "The lookup cursor actually moves",
    category: "retrieval",
    objective:
      "Open the onboarding runbook and use lookup to find the second sentence that mentions approval. "
      + "Quote that sentence.",
    criteria: [
      crit(
        "c-open",
        "The document is opened first",
        "read_doc opens the runbook; lookup is a cursor over an open document, not a search.",
        { kind: "tool_called", tool: "read_doc" },
      ),
      crit(
        "c-lookup-twice",
        "The cursor is advanced",
        "Two lookup calls: the first lands on result 1 of n, the second moves to the one asked for.",
        { kind: "tool_called", tool: "lookup", times: 2 },
        { weight: 3 },
      ),
      crit(
        "c-second-hit",
        "The second hit is quoted",
        `The answer quotes the second match, recognisable by "${PINNED.lookupSecondApprovalSentence.value}".`,
        { kind: "contains", value: PINNED.lookupSecondApprovalSentence.value },
        { weight: 3 },
      ),
    ],
    anti: {
      objective:
        "Open the onboarding runbook and use lookup to find the second sentence that mentions quarantine. "
        + "Quote that sentence.",
      reason:
        "'quarantine' occurs exactly once, so there is no second result and lookup returns "
        + "\"No more results.\" The quoted-sentence check must fail rather than settle for the first hit.",
    },
    tags: ["documents", "cursor"],
  }),

  task({
    id: "g-search-reformulate",
    title: "A miss is reformulated, not ignored",
    category: "tool_error_recovery",
    objective: "What does our published policy say about refunds after the renewal date? Search the documents.",
    criteria: [
      crit(
        "c-search-twice",
        "The query is reformulated",
        "Two search_docs calls: the first phrasing misses and a visible thought rewrites it.",
        { kind: "tool_called", tool: "search_docs", times: 2 },
        { weight: 3 },
      ),
      crit(
        "c-clause",
        "The refund clause is quoted",
        `The answer carries the clause itself, recognisable by "${PINNED.refundWindowPhrase.value}".`,
        { kind: "contains", value: PINNED.refundWindowPhrase.value },
        { weight: 3 },
      ),
    ],
    anti: {
      objective: "What does our published pricing policy say about the enterprise plan? Search the documents.",
      reason:
        `"pricing policy" matches ${PINNED.pricingDocId.value} on the first query, so no reformulation `
        + "happens and the two-search criterion must fail. A recovery test that also passes when nothing "
        + "went wrong is measuring nothing.",
    },
    tags: ["retrieval", "recovery"],
  }),

  task({
    id: "g-invalid-action",
    title: "An unregistered verb is survivable",
    category: "tool_error_recovery",
    objective: "Browse our website's pricing page and state the list price of the enterprise plan.",
    criteria: [
      crit(
        "c-price",
        "The price is right",
        `The answer states the enterprise list price, ${PINNED.enterpriseListPrice.value}.`,
        { kind: "contains", value: PINNED.enterpriseListPrice.value },
        { weight: 3 },
      ),
      crit(
        "c-recovered",
        "It recovered through a tool that exists",
        "After the Invalid action observation it reaches for search_docs rather than repeating the verb.",
        { kind: "tool_called", tool: "search_docs" },
      ),
      crit(
        "c-steps",
        "Recovery costs one step, not the run",
        "Six steps: one wasted on the unregistered verb, the rest spent finding the answer in the documents.",
        { kind: "max_steps", value: 6 },
        { weight: 2 },
      ),
    ],
    anti: {
      objective: "Using search_docs, state the list price of the starter plan.",
      reason:
        "The starter plan has a different price and the objective names a tool that exists, so nothing "
        + "tempts the missing verb. The price check must fail on the wrong plan.",
    },
    tags: ["recovery", "invalid-action"],
  }),

  task({
    id: "g-no-improvised-number",
    title: "No figure the tools did not produce",
    category: "arithmetic",
    objective: "What was the average MRR per enterprise customer across 2026Q1? Compute it rather than estimating.",
    criteria: [
      crit(
        "c-calc",
        "calc does the division",
        "The mean comes out of the calc tool. Arithmetic in prose is where the ReAct error table piles up.",
        { kind: "tool_called", tool: "calc" },
        { weight: 3 },
      ),
      crit(
        "c-figure",
        "The mean is right",
        `The answer states ${PINNED.avgMrrPerEnterpriseCustomer.value} to within a cent.`,
        { kind: "number_within", expected: PINNED.avgMrrPerEnterpriseCustomer.value, tolerance: 0.01 },
        { weight: 3 },
      ),
      crit(
        "c-no-bare-currency",
        "No dollar figure appears",
        "The answer carries no $-prefixed figure; it quotes the unit the tool reported instead. "
        + "Paired with the calc criterion this says a number appeared and a tool produced it.",
        { kind: "regex", pattern: NO_DOLLAR_FIGURE, flags: "" },
        { weight: 2 },
      ),
    ],
    anti: {
      objective: "Who owns the EU personal-data rule, according to the documents?",
      reason:
        "The answer is a name, so nothing calls calc and no arithmetic happens. An anti-improvisation "
        + "DoD that passes a question with no arithmetic in it is not measuring improvisation.",
    },
    tags: ["arithmetic", "no-improvised-numbers"],
  }),

  task({
    id: "g-policy-deny",
    title: "A denial names its rule",
    category: "fixed_logic",
    objective: "May we copy customer personal data from the EU region to a US analytics vendor?",
    criteria: [
      crit(
        "c-policy-check",
        "The rule table is consulted",
        "policy_check runs. A compliance answer improvised from the prompt is the whole failure mode here.",
        { kind: "tool_called", tool: "policy_check" },
        { weight: 2 },
      ),
      crit(
        "c-deny",
        "The decision is deny",
        "The tool returns decision: \"deny\" — the verdict is the tool's, not the model's reading of it.",
        { kind: "tool_value_equals", tool: "policy_check", path: "decision", equals: "deny" },
        { weight: 3 },
      ),
      crit(
        "c-rule-id",
        "The rule id is quoted",
        `The answer names ${PINNED.euPersonalDataRuleId.value}, which is the line a person audits.`,
        { kind: "contains", value: PINNED.euPersonalDataRuleId.value },
        { weight: 3 },
      ),
    ],
    anti: {
      objective: "May we copy anonymised aggregate usage counts between two of our own EU regions?",
      reason:
        "The same rule table allows this, so neither a deny verdict nor EU-PII-03 may appear. "
        + "A policy tool that denies everything satisfies every deny test ever written.",
    },
    tags: ["policy", "compliance"],
  }),

  task({
    id: "g-policy-allow",
    title: "An allowance names its rule too",
    category: "fixed_logic",
    objective: "May we copy anonymised aggregate usage counts between two of our own EU regions?",
    criteria: [
      crit(
        "c-policy-check",
        "The rule table is consulted",
        "policy_check runs here as well; an allow improvised from the prompt is as wrong as a deny.",
        { kind: "tool_called", tool: "policy_check" },
        { weight: 2 },
      ),
      crit(
        "c-allow",
        "The decision is allow",
        "The tool returns decision: \"allow\", which is the mirror the deny task cannot provide on its own.",
        { kind: "tool_value_equals", tool: "policy_check", path: "decision", equals: "allow" },
        { weight: 3 },
      ),
      crit(
        "c-rule-id",
        "The permitting rule is quoted",
        `The answer names ${PINNED.allowRuleId.value}, the rule under which the copy is permitted.`,
        { kind: "contains", value: PINNED.allowRuleId.value },
        { weight: 3 },
      ),
    ],
    anti: {
      objective: "May we copy customer personal data from the EU region to a US analytics vendor?",
      reason:
        "The rules deny this one. Mirror of the deny task: a policy tool that allows everything "
        + "satisfies every allow test, and only the pair catches it.",
    },
    tags: ["policy", "compliance"],
  }),

  task({
    id: "g-date-math",
    title: "A pinned clock gives a pinned date",
    category: "determinism",
    objective: "Using date_math, what is the date 45 days from today, in ISO form?",
    criteria: [
      crit(
        "c-date-math",
        "The date tool does the counting",
        "date_math runs. Counting days in prose is arithmetic hallucination with a calendar attached.",
        { kind: "tool_called", tool: "date_math" },
        { weight: 2 },
      ),
      crit(
        "c-date",
        "The date is the pinned one",
        `The clock is pinned to 2026-04-15, so the answer is ${PINNED.datePlus45Days.value} and stays it forever.`,
        { kind: "contains", value: PINNED.datePlus45Days.value },
        { weight: 3 },
      ),
    ],
    anti: {
      objective: "Using date_math, what is the date 45 days before today, in ISO form?",
      reason:
        "Counting backwards from the same pinned clock gives 2026-03-01. The spec's intended anti "
        + "removes the pinned clock, which EvalTask.anti cannot express because it carries only an "
        + "objective; reversing the direction discriminates the same way.",
    },
    tags: ["determinism", "dates"],
  }),

  task({
    id: "g-stable-repeat",
    title: "The same question three times",
    category: "determinism",
    objective:
      "What was ARR for the enterprise segment in 2026Q1? "
      + "Answer with the figure and the formula the tool reported.",
    repeat: 3,
    criteria: [
      crit(
        "c-stable-answer",
        "The answer does not drift",
        "Three runs produce the same answer text. Drift here means a number in a board deck moves overnight.",
        { kind: "stable_across_repeats", field: "answer" },
        { weight: 3 },
      ),
      crit(
        "c-stable-tools",
        "The route does not drift",
        "Three runs call the same tools in the same order, so the trace of one explains the others.",
        { kind: "stable_across_repeats", field: "tool_sequence" },
        { weight: 3 },
      ),
      crit(
        "c-figure",
        "And it is the right figure",
        `Stability is worthless on its own: the answer must also be ${PINNED.arrEnterprise2026Q1.value.toLocaleString("en-US")}.`,
        { kind: "number_within", expected: PINNED.arrEnterprise2026Q1.value, tolerance: 1 },
        { weight: 2 },
      ),
    ],
    anti: {
      objective:
        "What was ARR for the enterprise segment in 2019Q1? "
        + "Answer with the figure and the formula the tool reported.",
      reason:
        "A refusal repeats just as stably as an answer, so the stability criteria alone cannot "
        + "discriminate. The figure criterion is what must fail here — which is the point: the spec's "
        + "intended anti raises temperature via configPatch, and EvalTask.anti carries no config patch.",
    },
    tags: ["determinism", "repeat"],
  }),

  task({
    id: "g-refusal-honest",
    title: "Missing data is said out loud",
    category: "refusal",
    objective: "What was ARR for the enterprise segment in 2019Q1?",
    passThreshold: 0.8,
    criteria: [
      crit(
        "c-no-currency",
        "No figure is invented",
        "No dollar sign appears anywhere in the answer; there is no 2019 data, so any figure was made up.",
        { kind: "not_contains", value: "$" },
        { weight: 3 },
      ),
      crit(
        "c-names-gap",
        "It names what is missing",
        "The answer says which period is not covered, rather than apologising in general terms.",
        { kind: "regex", pattern: "(no data|not available|does not cover|cannot|outside)", flags: "i" },
        { weight: 3 },
      ),
      crit(
        "c-asked-first",
        "It asked before refusing",
        "Advisory: a refusal after actually calling kpi is better evidence than one produced from the prompt.",
        { kind: "tool_called", tool: "kpi" },
        { required: false },
      ),
    ],
    anti: {
      objective: "What was ARR for the enterprise segment in 2026Q1?",
      reason:
        "2026Q1 is in the fixtures, so the honest answer is a dollar figure and the refusal criteria "
        + "must fail. An honest-refusal DoD that passes an answerable question measures politeness.",
    },
    tags: ["refusal", "honesty"],
  }),

  task({
    id: "g-long-horizon",
    title: "Five steps and an artifact at the end",
    category: "long_horizon",
    objective:
      "Compare MRR across all three segments for 2026Q1, say which grew fastest since 2025Q4, "
      + "and write the comparison to an artifact named summary.md.",
    criteria: [
      crit(
        "c-artifact",
        "The artifact exists",
        "A file lands at /harness/runs/{runId}/summary.md; a long run with nothing to show for it failed.",
        { kind: "artifact_exists", path: "/harness/runs/{runId}/summary.md" },
        { weight: 3 },
      ),
      crit(
        "c-wrote",
        "It used the writing tool",
        "write_artifact is the only tool that writes, so the artifact cannot have appeared any other way.",
        { kind: "tool_called", tool: "write_artifact" },
      ),
      crit(
        "c-queried",
        "It gathered before it wrote",
        "table_query runs: three segments across two quarters cannot be compared from a single lookup. "
        + "This stands in for a minimum-steps check, which the criterion union has no kind for.",
        { kind: "tool_called", tool: "table_query" },
        { weight: 2 },
      ),
      crit(
        "c-cost",
        "It stayed under eight cents",
        "A long horizon is where per-task cost quietly triples while every pass check stays green.",
        { kind: "max_cost_usd", value: 0.08 },
        { weight: 2 },
      ),
    ],
    anti: {
      objective: "What was ARR for the enterprise segment in 2026Q1?",
      reason:
        "A single kpi lookup writes no artifact and runs no table_query, so three criteria must fail. "
        + "The spec's intended anti caps maxSteps at 2, which EvalTask.anti cannot express because it "
        + "carries only an objective.",
    },
    tags: ["long-horizon", "artifact"],
  }),

  task({
    id: "g-cost-ceiling",
    title: "Cheap, and still right",
    category: "cost",
    objective: "What was ARR for the enterprise segment in 2026Q1?",
    criteria: [
      crit(
        "c-figure",
        "The figure is right",
        `The answer states ${PINNED.arrEnterprise2026Q1.value.toLocaleString("en-US")} to within a dollar.`,
        { kind: "number_within", expected: PINNED.arrEnterprise2026Q1.value, tolerance: 1 },
        { weight: 3 },
      ),
      crit(
        "c-cost",
        "Two cents buys it",
        "A trivial lookup costs two cents or the harness has grown more expensive per finished thing "
        + "without a single pass/fail check noticing.",
        { kind: "max_cost_usd", value: 0.02 },
        { weight: 3 },
      ),
    ],
    anti: {
      objective: "What was ARR for the smb segment in 2026Q1?",
      reason:
        "A different segment has a different figure, so the number check must fail. Without it the "
        + "cost ceiling alone would pass any cheap answer, right or wrong.",
    },
    tags: ["cost", "kpi"],
  }),
];

/** Look one up by id; the store and the app both need this and neither should
 *  own a second copy of the array. */
export function taskById(id: string): EvalTask | undefined {
  return SEED_TASKS.find((t) => t.id === id);
}
