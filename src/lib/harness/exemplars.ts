import type { LoopConfig } from "./types";

/* ────────────────────────────────────────────────────────────────────────────
   The few-shot trajectories.

   ReAct's gains come from the exemplars far more than from the instructions.
   The instruction "call the tool instead of stating the number" is a rule the
   model may or may not obey; a trajectory that visibly asks `kpi` twice and
   then `calc` is a shape it imitates. So each trajectory below is here to
   teach exactly one recoverable failure, and nothing is included that teaches
   nothing:

   - RESIDENCY teaches reformulation. The first search misses on purpose,
     because a retrieval that always hits removes the reason thoughts exist.
     It also teaches moving the read_doc window with lookup instead of asking
     for the whole document.
   - GROWTH teaches "never state a number a tool can compute": two kpi calls
     and one calc, no arithmetic in prose.
   - MISSING teaches the ending most harnesses never demonstrate — refusing,
     and naming what was missing. Without an exemplar for it a model fabricates
     a plausible figure at exactly the moment the data is absent, which is the
     single most expensive thing it can do.

   Data only. This file computes nothing.
   ──────────────────────────────────────────────────────────────────────────── */

/** Retrieval that misses, then recovers through a rule id. */
const RESIDENCY_DENSE = `Task: Which document states the rule about personal data leaving the EU, and what does it require?
Thought 1: I do not know the document title, so search by the subject instead.
Action 1: search_docs[{"query":"personal data leaving the EU region"}]
Observation 1: 1. doc_security_v2 — Security overview (0.22)
   "Production access is granted through the on-call rota…"
2. doc_pricing_v4 — Pricing policy (0.11)
   "List prices are published per seat per month…"
Thought 2: Neither hit is the rule; the query matched general security prose. The rule is a policy, and policy_check returns the rule id, so ask that first.
Action 2: policy_check[{"action":"export customer records","region":"US"}]
Observation 2: deny (rule EU-PII-03): personal data may not leave the EU region.
Thought 3: EU-PII-03 is the identifier. Search for it directly.
Action 3: search_docs[{"query":"EU-PII-03 data residency"}]
Observation 3: 1. doc_data_residency — Data residency (0.58)
   "Personal data collected in the EU is stored in the EU…"
Thought 4: Open it.
Action 4: read_doc[{"id":"doc_data_residency"}]
Observation 4: Data residency — Personal data collected in the EU is stored in the EU. Rule EU-PII-03 governs every export. … (5 of 22 sentences — use lookup[keyword] to move)
Thought 5: The window ends before the exception. Move the cursor to "transfer".
Action 5: lookup[transfer]
Observation 5: (Result 1 / 3) A transfer outside the EU requires a documented adequacy decision and an approved sub-processor.
Thought 6: I have the document, the rule id and the requirement.
Action 6: finish[doc_data_residency states rule EU-PII-03: personal data collected in the EU stays in the EU, and any transfer out requires a documented adequacy decision and an approved sub-processor.]`;

/** Two fixed figures and one arithmetic step, none of it done in prose. */
const GROWTH_DENSE = `Task: Did enterprise ARR grow more than 10% from 2025Q4 to 2026Q1?
Thought 1: Two figures, both computable. Ask for the earlier one rather than estimating it.
Action 1: kpi[{"metric":"arr","period":"2025Q4","segment":"enterprise"}]
Observation 1: arr 2025Q4 enterprise = 3,780,000 USD (sum(mrr)*12 over 3 months, 36 rows, fixtures v1)
Thought 2: Now the later one, same segment.
Action 2: kpi[{"metric":"arr","period":"2026Q1","segment":"enterprise"}]
Observation 2: arr 2026Q1 enterprise = 4,182,000 USD (sum(mrr)*12 over 3 months, 36 rows, fixtures v1)
Thought 3: The growth rate is arithmetic, so calc it instead of writing it.
Action 3: calc[{"expression":"(4182000 - 3780000) / 3780000 * 100"}]
Observation 3: = 10.6349
Thought 4: 10.63% clears 10%.
Action 4: finish[Yes. Enterprise ARR rose from 3,780,000 to 4,182,000 USD, a 10.63% increase.]`;

/** The ending that has to be demonstrated or it never happens. */
const MISSING_DENSE = `Task: What was the churn rate in 2019Q1?
Thought 1: Ask for the figure.
Action 1: kpi[{"metric":"churn_rate","period":"2019Q1"}]
Observation 1: No rows for period 2019Q1. Available periods: 2025Q2 through 2026Q1.
Thought 2: The fixtures do not reach back that far, so there is no figure to give. Say which data is missing rather than estimating one.
Action 2: finish[I cannot answer this. The revenue fixtures cover 2025Q2 through 2026Q1 only, so no churn rate exists for 2019Q1.]`;

/* The sparse variants keep the same actions and spend a thought only where the
   next action is not already determined by the last observation. A long action
   horizon pays a thought per step for reasoning nobody reads; a decision point
   still gets one, because that is where a wrong turn is recoverable. */

const RESIDENCY_SPARSE = `Task: Which document states the rule about personal data leaving the EU, and what does it require?
Thought 1: Search by subject; the title is unknown.
Action 1: search_docs[{"query":"personal data leaving the EU region"}]
Observation 1: 1. doc_security_v2 — Security overview (0.22)
2. doc_pricing_v4 — Pricing policy (0.11)
Thought 2: Both hits are general prose, not the rule. policy_check returns rule ids, so go there and search on the id instead of on the subject.
Action 2: policy_check[{"action":"export customer records","region":"US"}]
Observation 2: deny (rule EU-PII-03): personal data may not leave the EU region.
Thought 3: -
Action 3: search_docs[{"query":"EU-PII-03 data residency"}]
Observation 3: 1. doc_data_residency — Data residency (0.58)
Thought 4: -
Action 4: read_doc[{"id":"doc_data_residency"}]
Observation 4: Data residency — Personal data collected in the EU is stored in the EU. … (5 of 22 sentences — use lookup[keyword] to move)
Thought 5: The exception is past the window.
Action 5: lookup[transfer]
Observation 5: (Result 1 / 3) A transfer outside the EU requires a documented adequacy decision and an approved sub-processor.
Thought 6: -
Action 6: finish[doc_data_residency states rule EU-PII-03: personal data collected in the EU stays in the EU, and any transfer out requires a documented adequacy decision and an approved sub-processor.]`;

const GROWTH_SPARSE = `Task: Did enterprise ARR grow more than 10% from 2025Q4 to 2026Q1?
Thought 1: Both figures are computable; do not estimate either.
Action 1: kpi[{"metric":"arr","period":"2025Q4","segment":"enterprise"}]
Observation 1: arr 2025Q4 enterprise = 3,780,000 USD (sum(mrr)*12 over 3 months, 36 rows, fixtures v1)
Thought 2: -
Action 2: kpi[{"metric":"arr","period":"2026Q1","segment":"enterprise"}]
Observation 2: arr 2026Q1 enterprise = 4,182,000 USD (sum(mrr)*12 over 3 months, 36 rows, fixtures v1)
Thought 3: -
Action 3: calc[{"expression":"(4182000 - 3780000) / 3780000 * 100"}]
Observation 3: = 10.6349
Thought 4: -
Action 4: finish[Yes. Enterprise ARR rose from 3,780,000 to 4,182,000 USD, a 10.63% increase.]`;

const MISSING_SPARSE = `Task: What was the churn rate in 2019Q1?
Thought 1: -
Action 1: kpi[{"metric":"churn_rate","period":"2019Q1"}]
Observation 1: No rows for period 2019Q1. Available periods: 2025Q2 through 2026Q1.
Thought 2: The data does not exist, so name what is missing instead of estimating.
Action 2: finish[I cannot answer this. The revenue fixtures cover 2025Q2 through 2026Q1 only, so no churn rate exists for 2019Q1.]`;

export const EXEMPLARS_DENSE: readonly string[] = [RESIDENCY_DENSE, GROWTH_DENSE, MISSING_DENSE];
export const EXEMPLARS_SPARSE: readonly string[] = [RESIDENCY_SPARSE, GROWTH_SPARSE, MISSING_SPARSE];

/** Prefixes the block. Kept here rather than in the preamble so that the whole
 *  few-shot section is one contiguous, swappable string in the cache prefix. */
export const EXEMPLAR_HEADER = "Examples:";

/** The block exactly as it is concatenated into the system message. Two blank
 *  lines between trajectories: one blank line is ambiguous with the blank line
 *  a model may leave inside a long observation. */
export function exemplarsFor(density: LoopConfig["thoughtDensity"]): string {
  const set = density === "sparse" ? EXEMPLARS_SPARSE : EXEMPLARS_DENSE;
  return EXEMPLAR_HEADER + "\n\n" + set.join("\n\n\n");
}
