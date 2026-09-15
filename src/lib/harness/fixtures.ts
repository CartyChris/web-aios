/* ────────────────────────────────────────────────────────────────────────────
   The fixed datasets behind the deterministic tools.

   Layer 3 only works if the numbers cannot drift. Everything a deterministic
   tool reads lives here as literal data, versioned by FIXTURE_VERSION, so that
   "same args + same fixture version => byte-identical observation" is a
   property of the data as well as of the code. Changing a number here is a
   deliberate act that invalidates every eval baseline, which is why the version
   string ships inside every observation.

   Imports nothing but types: this module also runs inside /api/harness/mcp,
   where there is no browser and no store.
   ──────────────────────────────────────────────────────────────────────────── */

/** Bump ONLY together with a new eval baseline. It is part of the eval
 *  fingerprint, so an un-bumped change silently turns a stale green into a
 *  green that vouches for code it never ran against. */
export const FIXTURE_VERSION = "v1";

export type Segment = "smb" | "mid" | "enterprise";
export type Severity = "sev1" | "sev2" | "sev3" | "sev4";
export type Region = "eu" | "us" | "apac";
export type PolicyDecision = "allow" | "deny" | "review";

export interface RevenueRow {
  /** YYYY-MM. */
  month: string;
  segment: Segment;
  mrr: number;
  customers: number;
  churned: number;
}

export interface TicketRow {
  id: string;
  /** YYYY-MM-DD. */
  opened: string;
  severity: Severity;
  region: Region;
  resolvedHours: number;
}

export interface HeadcountRow {
  /** YYYYQn. */
  quarter: string;
  dept: string;
  headcount: number;
  costUsd: number;
}

export interface PolicyRule {
  id: string;
  /** Whole-word keywords matched against the requested action. */
  keywords: string[];
  /** Absent means the rule applies in every region. */
  region?: Region;
  /** Inclusive bounds. A rule with a bound never matches a request that
   *  carries no amount — an unbounded amount silently landing in a bounded
   *  rule is how a 50,000 USD refund gets auto-approved. */
  minAmount?: number;
  maxAmount?: number;
  decision: PolicyDecision;
  rationale: string;
}

export interface DocFixture {
  id: string;
  title: string;
  /** Stored pre-split. A sentence splitter is one more thing that can differ
   *  between two runs; the window sizes read_doc reports must not. */
  sentences: string[];
}

export interface UnitEconomicsRow {
  segment: Segment;
  /** Fraction of MRR consumed delivering the service. */
  costOfDeliveryRatio: number;
  /** Fully loaded acquisition cost for one customer in this segment. */
  cacUsd: number;
}

export interface Fixtures {
  version: string;
  revenue: RevenueRow[];
  tickets: TicketRow[];
  headcount: HeadcountRow[];
  policy: PolicyRule[];
  docs: DocFixture[];
  /** Gross margin and CAC payback are not derivable from the revenue rows
   *  alone. They are board-deck numbers, so they come from a table a person
   *  can audit rather than from a ratio a model felt was about right. */
  unitEconomics: UnitEconomicsRow[];
}

/* ── revenue: 12 months x 3 segments ─────────────────────────────────────── */

type RevenueTuple = readonly [string, Segment, number, number, number];

const REVENUE_TUPLES: readonly RevenueTuple[] = [
  ["2026-01", "smb", 41000, 620, 22],
  ["2026-01", "mid", 84000, 140, 3],
  ["2026-01", "enterprise", 112000, 28, 0],
  ["2026-02", "smb", 42500, 634, 24],
  ["2026-02", "mid", 86500, 143, 2],
  ["2026-02", "enterprise", 116000, 29, 1],
  ["2026-03", "smb", 43000, 648, 21],
  ["2026-03", "mid", 88000, 146, 4],
  ["2026-03", "enterprise", 120500, 30, 0],
  ["2026-04", "smb", 44500, 662, 25],
  ["2026-04", "mid", 90500, 149, 3],
  ["2026-04", "enterprise", 124000, 31, 1],
  ["2026-05", "smb", 45000, 676, 23],
  ["2026-05", "mid", 92000, 152, 2],
  ["2026-05", "enterprise", 128500, 32, 0],
  ["2026-06", "smb", 46500, 690, 26],
  ["2026-06", "mid", 94500, 155, 4],
  ["2026-06", "enterprise", 133000, 33, 1],
  ["2026-07", "smb", 47000, 704, 22],
  ["2026-07", "mid", 96000, 158, 3],
  ["2026-07", "enterprise", 136500, 34, 1],
  ["2026-08", "smb", 48500, 718, 27],
  ["2026-08", "mid", 98500, 161, 2],
  ["2026-08", "enterprise", 141000, 35, 0],
  ["2026-09", "smb", 49000, 732, 24],
  ["2026-09", "mid", 100000, 164, 4],
  ["2026-09", "enterprise", 145500, 36, 1],
  ["2026-10", "smb", 50500, 746, 28],
  ["2026-10", "mid", 102500, 167, 3],
  ["2026-10", "enterprise", 149000, 37, 0],
  ["2026-11", "smb", 51000, 760, 25],
  ["2026-11", "mid", 104000, 170, 2],
  ["2026-11", "enterprise", 153500, 38, 1],
  ["2026-12", "smb", 52500, 774, 29],
  ["2026-12", "mid", 106500, 173, 4],
  ["2026-12", "enterprise", 158000, 39, 1],
];

const REVENUE: RevenueRow[] = REVENUE_TUPLES.map(
  ([month, segment, mrr, customers, churned]) => ({ month, segment, mrr, customers, churned }),
);

/* ── tickets: 60 rows ────────────────────────────────────────────────────── */

type TicketTuple = readonly [string, string, Severity, Region, number];

const TICKET_TUPLES: readonly TicketTuple[] = [
  ["TK-1001", "2026-01-03", "sev3", "us", 6.5],
  ["TK-1002", "2026-01-04", "sev2", "eu", 3.25],
  ["TK-1003", "2026-01-06", "sev4", "apac", 22],
  ["TK-1004", "2026-01-08", "sev3", "eu", 9],
  ["TK-1005", "2026-01-09", "sev1", "us", 1.5],
  ["TK-1006", "2026-01-12", "sev3", "apac", 14],
  ["TK-1007", "2026-01-14", "sev2", "us", 4],
  ["TK-1008", "2026-01-16", "sev4", "eu", 30],
  ["TK-1009", "2026-01-19", "sev3", "us", 7.5],
  ["TK-1010", "2026-01-21", "sev2", "apac", 5],
  ["TK-1011", "2026-01-23", "sev3", "eu", 11],
  ["TK-1012", "2026-01-26", "sev4", "us", 26],
  ["TK-1013", "2026-01-28", "sev1", "eu", 2],
  ["TK-1014", "2026-01-29", "sev3", "apac", 13.5],
  ["TK-1015", "2026-01-30", "sev2", "us", 3.75],
  ["TK-1016", "2026-02-02", "sev3", "eu", 8],
  ["TK-1017", "2026-02-04", "sev4", "apac", 19],
  ["TK-1018", "2026-02-05", "sev2", "us", 4.5],
  ["TK-1019", "2026-02-09", "sev3", "eu", 10.5],
  ["TK-1020", "2026-02-11", "sev1", "apac", 1.75],
  ["TK-1021", "2026-02-13", "sev3", "us", 6],
  ["TK-1022", "2026-02-16", "sev4", "eu", 28],
  ["TK-1023", "2026-02-18", "sev2", "apac", 5.5],
  ["TK-1024", "2026-02-20", "sev3", "us", 12],
  ["TK-1025", "2026-02-23", "sev2", "eu", 3.5],
  ["TK-1026", "2026-02-25", "sev4", "us", 24],
  ["TK-1027", "2026-02-26", "sev3", "apac", 15],
  ["TK-1028", "2026-02-27", "sev1", "us", 2.25],
  ["TK-1029", "2026-03-02", "sev3", "eu", 9.5],
  ["TK-1030", "2026-03-04", "sev2", "apac", 4.25],
  ["TK-1031", "2026-03-06", "sev3", "us", 7],
  ["TK-1032", "2026-03-09", "sev4", "eu", 31],
  ["TK-1033", "2026-03-11", "sev2", "us", 3],
  ["TK-1034", "2026-03-13", "sev3", "apac", 16],
  ["TK-1035", "2026-03-16", "sev1", "eu", 1.25],
  ["TK-1036", "2026-03-18", "sev3", "us", 8.5],
  ["TK-1037", "2026-03-20", "sev4", "apac", 21],
  ["TK-1038", "2026-03-23", "sev2", "eu", 6.25],
  ["TK-1039", "2026-03-25", "sev3", "us", 10],
  ["TK-1040", "2026-03-27", "sev2", "apac", 4.75],
  ["TK-1041", "2026-04-01", "sev3", "eu", 12.5],
  ["TK-1042", "2026-04-03", "sev4", "us", 27],
  ["TK-1043", "2026-04-07", "sev1", "apac", 2.5],
  ["TK-1044", "2026-04-09", "sev3", "eu", 7.25],
  ["TK-1045", "2026-04-13", "sev2", "us", 5.25],
  ["TK-1046", "2026-04-15", "sev3", "apac", 11.5],
  ["TK-1047", "2026-04-17", "sev4", "eu", 33],
  ["TK-1048", "2026-04-21", "sev2", "us", 3.25],
  ["TK-1049", "2026-04-23", "sev3", "eu", 9.75],
  ["TK-1050", "2026-04-28", "sev1", "us", 1.5],
  ["TK-1051", "2026-05-04", "sev3", "apac", 13],
  ["TK-1052", "2026-05-06", "sev2", "eu", 4.5],
  ["TK-1053", "2026-05-11", "sev4", "us", 25],
  ["TK-1054", "2026-05-14", "sev3", "eu", 8.75],
  ["TK-1055", "2026-05-19", "sev2", "apac", 6],
  ["TK-1056", "2026-05-22", "sev3", "us", 10.25],
  ["TK-1057", "2026-05-27", "sev1", "eu", 2.75],
  ["TK-1058", "2026-06-02", "sev3", "apac", 14.5],
  ["TK-1059", "2026-06-08", "sev2", "us", 5],
  ["TK-1060", "2026-06-15", "sev4", "eu", 29],
];

const TICKETS: TicketRow[] = TICKET_TUPLES.map(
  ([id, opened, severity, region, resolvedHours]) => ({ id, opened, severity, region, resolvedHours }),
);

/* ── headcount: 4 quarters x 6 departments ───────────────────────────────── */

type HeadcountTuple = readonly [string, string, number, number];

const HEADCOUNT_TUPLES: readonly HeadcountTuple[] = [
  ["2026Q1", "engineering", 42, 1260000],
  ["2026Q1", "sales", 18, 540000],
  ["2026Q1", "support", 12, 288000],
  ["2026Q1", "marketing", 7, 210000],
  ["2026Q1", "finance", 5, 160000],
  ["2026Q1", "operations", 6, 174000],
  ["2026Q2", "engineering", 45, 1350000],
  ["2026Q2", "sales", 20, 600000],
  ["2026Q2", "support", 13, 312000],
  ["2026Q2", "marketing", 8, 240000],
  ["2026Q2", "finance", 5, 160000],
  ["2026Q2", "operations", 6, 174000],
  ["2026Q3", "engineering", 48, 1440000],
  ["2026Q3", "sales", 22, 660000],
  ["2026Q3", "support", 14, 336000],
  ["2026Q3", "marketing", 8, 240000],
  ["2026Q3", "finance", 6, 192000],
  ["2026Q3", "operations", 7, 203000],
  ["2026Q4", "engineering", 51, 1530000],
  ["2026Q4", "sales", 24, 720000],
  ["2026Q4", "support", 15, 360000],
  ["2026Q4", "marketing", 9, 270000],
  ["2026Q4", "finance", 6, 192000],
  ["2026Q4", "operations", 7, 203000],
];

const HEADCOUNT: HeadcountRow[] = HEADCOUNT_TUPLES.map(
  ([quarter, dept, headcount, costUsd]) => ({ quarter, dept, headcount, costUsd }),
);

/* ── policy: 14 rules, evaluated in declaration order ────────────────────── */

/** Order is the policy. The EU rule sits above the general cross-border rule
 *  so that a European export is denied rather than sent for review; swapping
 *  the two turns a hard control into a soft one without changing any text. */
const POLICY: PolicyRule[] = [
  {
    id: "EU-PII-03",
    keywords: ["export", "transfer", "replicate"],
    region: "eu",
    decision: "deny",
    rationale: "personal data may not leave the EU region.",
  },
  {
    id: "EU-PII-04",
    keywords: ["export", "transfer", "replicate"],
    decision: "review",
    rationale: "cross-border data movement needs the named data owner's approval.",
  },
  {
    id: "FIN-REF-01",
    keywords: ["refund", "credit"],
    maxAmount: 500,
    decision: "allow",
    rationale: "refunds at or under 500 USD are pre-approved for support staff.",
  },
  {
    id: "FIN-REF-02",
    keywords: ["refund", "credit"],
    minAmount: 500.01,
    maxAmount: 5000,
    decision: "review",
    rationale: "refunds above 500 USD are approved by finance, not by support.",
  },
  {
    id: "FIN-REF-03",
    keywords: ["refund", "credit"],
    minAmount: 5000.01,
    decision: "deny",
    rationale: "refunds above 5000 USD sit outside every delegated authority.",
  },
  {
    id: "FIN-DISC-01",
    keywords: ["discount"],
    maxAmount: 20,
    decision: "allow",
    rationale: "discounts to 20 percent are inside the published list-price band.",
  },
  {
    id: "FIN-DISC-02",
    keywords: ["discount"],
    minAmount: 20.01,
    decision: "review",
    rationale: "discounts above 20 percent need a regional vice president's signature.",
  },
  {
    id: "SEC-CRED-01",
    keywords: ["credentials", "password", "secret"],
    decision: "deny",
    rationale: "credentials are never shared outside the secrets manager.",
  },
  {
    id: "SEC-ACCESS-02",
    keywords: ["admin", "privileged", "root"],
    decision: "review",
    rationale: "privileged access is granted for a fixed window by the on-call security lead.",
  },
  {
    id: "DAT-DEL-01",
    keywords: ["delete", "erase", "purge"],
    decision: "review",
    rationale: "deletion is irreversible and needs the account owner's written request.",
  },
  {
    id: "PROC-BUY-01",
    keywords: ["purchase", "procure", "buy"],
    maxAmount: 2000,
    decision: "allow",
    rationale: "purchases at or under 2000 USD sit inside a manager's own budget.",
  },
  {
    id: "PROC-BUY-02",
    keywords: ["purchase", "procure", "buy"],
    minAmount: 2000.01,
    decision: "review",
    rationale: "purchases above 2000 USD go through procurement.",
  },
  {
    id: "COMM-PUB-01",
    keywords: ["publish", "announce", "post"],
    decision: "review",
    rationale: "external communications are cleared by communications before release.",
  },
  {
    id: "HR-HIRE-01",
    keywords: ["hire", "offer", "recruit"],
    decision: "review",
    rationale: "hiring requires an approved requisition and a named hiring manager.",
  },
];

/* ── docs: 8 documents ───────────────────────────────────────────────────── */

/** Two title pairs are deliberately near-duplicates — the two pricing
 *  revisions and the two onboarding runbooks. search_docs is lexical and
 *  title-weighted, so a natural query ("onboarding runbook") ranks the wrong
 *  member of a pair first. That near-miss is the point: it is what forces a
 *  visible reformulation thought, which is the behaviour ReAct exploits. A
 *  corpus where every query lands first time measures nothing. */
const DOCS: DocFixture[] = [
  {
    id: "doc_pricing_v4",
    title: "Pricing policy",
    sentences: [
      "This revision of the pricing policy takes effect on the first day of the 2026 fiscal year and replaces revision three.",
      "List prices are published in United States dollars and are converted at the rate fixed on the first day of each quarter.",
      "The starter plan is billed at forty nine dollars per seat per month with a minimum of five seats.",
      "The growth plan is billed at ninety nine dollars per seat per month with a minimum of twenty seats.",
      "The enterprise plan is quoted annually and carries a floor of sixty thousand dollars per year.",
      "Any discount above twenty percent must be approved under the authority table in the refund and credit policy.",
      "Discounts at or below twenty percent may be applied by an account executive without further sign off.",
      "A multi year commitment earns an additional five percent for each year beyond the first, capped at fifteen percent.",
      "Usage above the contracted seat count is billed monthly in arrears at the list rate for the plan.",
      "Overage is never charged retroactively for a period that closed more than sixty days before the invoice date.",
      "A renewal is quoted no later than ninety days before the current term ends.",
      "A renewal uplift is capped at seven percent unless the customer has changed plan tier.",
      "If a renewal quote is not accepted before the term ends the contract lapses to a monthly rolling arrangement at list price.",
      "A renewal that lapses twice in succession is escalated to the regional vice president of sales.",
      "Public sector customers are quoted from the same list but are exempt from the multi year cap.",
      "Non profit customers receive a standing thirty percent reduction that is recorded against rule FIN-DISC-02.",
      "Price changes are announced to existing customers at least one full quarter before they apply.",
      "No customer is moved to a higher price inside an active term.",
      "Professional services are quoted separately and are not eligible for plan discounts.",
      "Training days are billed at two thousand four hundred dollars per day plus travel at cost.",
      "Payment terms are net thirty from the invoice date for every plan.",
      "An escrow arrangement is available only to enterprise customers who ask for it in writing during negotiation.",
      "Invoices unpaid after sixty days suspend the account until the balance clears.",
      "Currency changes mid term are treated as a new order form rather than an amendment.",
      "Questions about a specific quote go to the deal desk, not to the support queue.",
      "This document is owned by the head of revenue operations and is reviewed every six months.",
    ],
  },
  {
    id: "doc_pricing_v3",
    title: "Pricing policy, superseded revision",
    sentences: [
      "This revision of the pricing policy applied during the 2025 fiscal year and is retained for audit only.",
      "It is superseded by revision four and must not be quoted to a customer.",
      "The starter plan was billed at thirty nine dollars per seat per month with a minimum of three seats.",
      "The growth plan was billed at eighty nine dollars per seat per month with a minimum of fifteen seats.",
      "The enterprise plan carried a floor of forty eight thousand dollars per year.",
      "Discounts above fifteen percent required a director's approval under the old authority table.",
      "The multi year bonus was three percent per additional year with no cap.",
      "Overage was billed quarterly rather than monthly.",
      "A renewal was quoted sixty days before the term ended.",
      "The renewal uplift was capped at ten percent.",
      "Public sector customers received a flat twelve percent reduction.",
      "Non profit pricing was handled case by case with no standing rule.",
      "Price change notice was one month rather than one quarter.",
      "Professional services were bundled into the plan discount.",
      "Training was billed at eighteen hundred dollars per day.",
      "Payment terms were net forty five.",
      "Escrow was offered to any customer on request.",
      "Suspension for non payment happened after ninety days.",
      "Currency changes were handled as an amendment.",
      "This revision is retained because open contracts signed under it run until the end of 2026.",
      "Do not use the numbers in this document to answer a question about current pricing.",
      "This document is owned by the head of revenue operations and is frozen.",
    ],
  },
  {
    id: "doc_security",
    title: "Security controls",
    sentences: [
      "Every production system is reached through the identity provider and never through a shared account.",
      "Multi factor authentication is required for every employee without exception.",
      "Credentials are stored only in the secrets manager and are never pasted into a ticket, a chat or a document.",
      "Rule SEC-CRED-01 denies any request to share a credential outside the secrets manager.",
      "Privileged access is granted for a fixed window and expires automatically.",
      "A request for privileged access is reviewed by the on call security lead under rule SEC-ACCESS-02.",
      "Production data is encrypted at rest with keys held in the regional key service.",
      "Traffic between services is encrypted in transit with certificates rotated every ninety days.",
      "Laptops are encrypted and are enrolled in the device management service before first use.",
      "An employee who loses a device reports it within one hour to the security channel.",
      "Penetration testing is commissioned twice a year from an independent firm.",
      "Findings rated high are remediated within thirty days and findings rated critical within seven.",
      "Vulnerability scanning runs nightly against every container image in the registry.",
      "An image with a known critical vulnerability is blocked from deployment automatically.",
      "Audit logs are retained for eighteen months in a store that engineers cannot write to.",
      "Access to the audit log store is itself logged.",
      "A security incident is declared by anyone who suspects one, and declaring one is never penalised.",
      "The incident commander is the on call security lead until they hand over explicitly.",
      "Customer notification for a confirmed breach happens within seventy two hours.",
      "Backups are tested by restore, not by inspection, once per quarter.",
      "Third party software is reviewed before purchase and is recorded in the vendor register.",
      "A vendor with access to customer data signs the data processing addendum before access is granted.",
      "This document is owned by the head of security and is reviewed every quarter.",
      "Security questions that are not urgent go to the security channel rather than to an individual.",
    ],
  },
  {
    id: "doc_data_residency",
    title: "European data residency rule",
    sentences: [
      "Personal data belonging to a customer established in the European Union is stored inside the European Union.",
      "Rule EU-PII-03 denies any export, transfer or replication of that data out of the region.",
      "The denial applies to backups, to analytics extracts and to support copies alike.",
      "A support engineer outside the region may view a record through the regional console but may not download it.",
      "Rule EU-PII-04 sends a cross border movement outside the European Union to the named data owner for review.",
      "The named data owner for customer records is the head of revenue operations.",
      "The named data owner for employee records is the head of people.",
      "Aggregate figures that cannot identify a person are not personal data and may leave the region.",
      "A figure is treated as aggregate only when it covers at least twenty distinct customers.",
      "Pseudonymised data is still personal data for the purpose of this rule.",
      "The European region runs in two availability zones with no cross region replication enabled.",
      "Disaster recovery for the European region stays inside the European region.",
      "A request from a customer to delete their data is handled under rule DAT-DEL-01.",
      "Deletion requests are completed within thirty days and are confirmed in writing.",
      "A deletion request that would break a legal retention obligation is refused with the obligation named.",
      "Legal retention for billing records is seven years.",
      "Subject access requests are answered within one calendar month.",
      "The data protection officer is copied on every refusal.",
      "Transfers to the United States rely on the standard contractual clauses and on the transfer impact assessment.",
      "A new sub processor is announced thirty days before it begins processing.",
      "Customers may object to a new sub processor during that window.",
      "This document is owned by the data protection officer.",
      "It is reviewed whenever the rule table changes and at least once a year.",
      "Nothing in this document overrides an instruction from a supervisory authority.",
    ],
  },
  {
    id: "doc_onboarding_customer",
    title: "Customer onboarding runbook",
    sentences: [
      "This runbook covers the first thirty days after a customer signs an order form.",
      "The account executive hands over to the onboarding manager within one business day of signature.",
      "The handover note records the plan, the seat count, the region and any negotiated term.",
      "A provisioning ticket is raised against the platform team with the customer's region attached.",
      "A customer established in the European Union is provisioned in the European region without exception.",
      "The onboarding manager schedules the kickoff call inside the first week.",
      "The kickoff call agenda covers success criteria, named contacts and the support path.",
      "Named contacts are recorded in the account record, not in the onboarding manager's notes.",
      "Single sign on is configured before any bulk user import.",
      "A bulk user import that runs before single sign on creates duplicate identities that must be merged by hand.",
      "The first invoice is issued after provisioning completes, not at signature.",
      "Training days purchased at signature are scheduled during the first thirty days.",
      "A customer who has not logged in by day ten is contacted by the onboarding manager directly.",
      "A customer who has not logged in by day twenty is escalated to the account executive.",
      "Data migration from a previous vendor is scoped as professional services and quoted separately.",
      "A migration is never run against production without a rehearsal in the sandbox.",
      "The sandbox is deleted thirty days after the migration completes.",
      "The onboarding manager confirms in writing when the thirty day period closes.",
      "The account then transfers to the customer success manager named at kickoff.",
      "An account that misses two onboarding milestones is reviewed by the head of customer success.",
      "Escalations during onboarding follow the support service levels document.",
      "Nothing in this runbook changes the contractual terms in the order form.",
      "This document is owned by the head of customer success.",
      "It is reviewed every six months and after any change to provisioning.",
      "Questions about a specific account go to the onboarding channel.",
      "Questions about the runbook itself go to the head of customer success.",
    ],
  },
  {
    id: "doc_onboarding_employee",
    title: "Employee onboarding runbook",
    sentences: [
      "This runbook covers the first two weeks for a new employee.",
      "The hiring manager confirms the start date with people operations ten working days in advance.",
      "A laptop is ordered under rule PROC-BUY-01 when the total is at or under two thousand dollars.",
      "A laptop above that amount is routed to procurement under rule PROC-BUY-02.",
      "The device is enrolled in device management before it is handed over.",
      "Accounts are created in the identity provider on the morning of the first day.",
      "Multi factor authentication is enrolled during the first hour.",
      "A new employee never receives a shared credential.",
      "Access to production is not granted during the first two weeks.",
      "The buddy is named before the start date and meets the new employee on the first morning.",
      "The first week covers the product, the customers and the security controls.",
      "The security controls session is mandatory and is recorded as completed in the training record.",
      "The second week covers the team's own systems and the on call rotation.",
      "A new engineer does not join the on call rotation before the end of the first month.",
      "Payroll details are collected by people operations and never by the hiring manager.",
      "Right to work checks are completed before the first day.",
      "The probation review is scheduled at the start, not at the end, of the probation period.",
      "Feedback at thirty days is written down and shared with the employee.",
      "Equipment returned by a leaver is wiped before it is reissued.",
      "An offer is only made under rule HR-HIRE-01 with an approved requisition.",
      "This document is owned by the head of people.",
      "It is reviewed every six months.",
      "Questions about a specific hire go to the people operations channel.",
      "Questions about the runbook itself go to the head of people.",
    ],
  },
  {
    id: "doc_support_sla",
    title: "Support service levels",
    sentences: [
      "Support severity is set by the impact on the customer, not by the customer's tone.",
      "Severity one means production is down for all users of the account.",
      "Severity two means a major function is unusable and no workaround exists.",
      "Severity three means a function is degraded or a workaround exists.",
      "Severity four means a question, a request or a cosmetic defect.",
      "The first response target for severity one is fifteen minutes at any hour.",
      "The first response target for severity two is two hours during business hours.",
      "The first response target for severity three is one business day.",
      "The first response target for severity four is three business days.",
      "The resolution target for severity one is four hours.",
      "The resolution target for severity two is one business day.",
      "Severity three and four carry no resolution target, only a next update commitment.",
      "A severity one ticket pages the on call engineer immediately.",
      "A severity one ticket that is open for more than two hours is escalated to the head of support.",
      "Severity is reviewed at every update and may be lowered as well as raised.",
      "A customer may request a severity increase and the reason is recorded either way.",
      "Support hours follow the customer's own region as recorded on the account.",
      "Tickets are never closed without the customer confirming or after fourteen days of silence.",
      "A ticket closed for silence is reopened on request with its history intact.",
      "Support may issue a credit at or under five hundred dollars under rule FIN-REF-01.",
      "Anything larger goes to finance under rule FIN-REF-02.",
      "This document is owned by the head of support and is reviewed every quarter.",
    ],
  },
  {
    id: "doc_refunds",
    title: "Refund and credit policy",
    sentences: [
      "A refund returns money already paid, and a credit reduces a future invoice.",
      "A credit is the default remedy because it settles without a payments operation.",
      "A refund is issued only when the customer is leaving or when the charge was an error.",
      "Support may approve a refund or credit at or under five hundred dollars under rule FIN-REF-01.",
      "Finance reviews a refund between five hundred and five thousand dollars under rule FIN-REF-02.",
      "A refund above five thousand dollars is denied under rule FIN-REF-03 and needs a contract amendment instead.",
      "The approval authority for a discount above twenty percent is the regional vice president of sales.",
      "That authority is the same one named in the pricing policy for a lapsed renewal escalation.",
      "Every refund records the ticket, the invoice, the amount and the approver.",
      "A refund without a named approver is reversed by the monthly control check.",
      "Refunds are paid to the original payment method and never to a different account.",
      "A request to pay a refund to a different account is treated as a fraud signal and is escalated to finance.",
      "Duplicate charges are refunded in full without a severity assessment.",
      "A pro rata refund for an unused term is calculated on whole months only.",
      "Partial months are not refunded and this is stated in the order form.",
      "Professional services already delivered are never refunded.",
      "Training days cancelled more than ten working days ahead are refunded in full.",
      "Training days cancelled inside ten working days are credited at half value.",
      "A credit expires twelve months after it is issued.",
      "An expired credit is not reinstated without the head of finance's approval.",
      "Refund volume is reported monthly against the revenue figures for the same period.",
      "A month where refunds exceed two percent of billings triggers a root cause review.",
      "This document is owned by the head of finance.",
      "It is reviewed every six months and after any change to the rule table.",
    ],
  },
];

const UNIT_ECONOMICS: UnitEconomicsRow[] = [
  { segment: "smb", costOfDeliveryRatio: 0.18, cacUsd: 900 },
  { segment: "mid", costOfDeliveryRatio: 0.22, cacUsd: 4200 },
  { segment: "enterprise", costOfDeliveryRatio: 0.31, cacUsd: 18000 },
];

export const FIXTURES: Fixtures = {
  version: FIXTURE_VERSION,
  revenue: REVENUE,
  tickets: TICKETS,
  headcount: HEADCOUNT,
  policy: POLICY,
  docs: DOCS,
  unitEconomics: UNIT_ECONOMICS,
};

/** Names of the tables an EvalTask may override. Kept as data so an overlay
 *  naming a table that does not exist fails loudly at registration rather
 *  than silently running the task against the unmodified fixtures — a task
 *  that quietly tests the default corpus proves nothing about its own case. */
export const FIXTURE_TABLES = [
  "revenue",
  "tickets",
  "headcount",
  "policy",
  "docs",
  "unitEconomics",
] as const;

export type FixtureTable = (typeof FIXTURE_TABLES)[number];

/**
 * Apply an EvalTask's fixture overlay. Whole-table replacement, not a merge:
 * a per-row merge needs a key, and every plausible key here (month+segment,
 * ticket id, rule id) differs per table, so a "clever" merge would have four
 * special cases and one of them would be wrong.
 */
export function overlayFixtures(
  base: Fixtures,
  overlay: Record<string, unknown>,
): { ok: true; fixtures: Fixtures } | { ok: false; error: string } {
  const keys = Object.keys(overlay);
  const unknown = keys.filter((k) => !(FIXTURE_TABLES as readonly string[]).includes(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `Fixture overlay names unknown table(s): ${unknown.join(", ")}. ` +
        `Known tables are ${FIXTURE_TABLES.join(", ")}.`,
    };
  }
  const notArray = keys.filter((k) => !Array.isArray(overlay[k]));
  if (notArray.length > 0) {
    return {
      ok: false,
      error:
        `Fixture overlay for ${notArray.join(", ")} must be an array of rows. ` +
        `Pass the replacement rows, not a patch object.`,
    };
  }
  const next: Fixtures = {
    version: base.version,
    revenue: (overlay.revenue as RevenueRow[] | undefined) ?? base.revenue,
    tickets: (overlay.tickets as TicketRow[] | undefined) ?? base.tickets,
    headcount: (overlay.headcount as HeadcountRow[] | undefined) ?? base.headcount,
    policy: (overlay.policy as PolicyRule[] | undefined) ?? base.policy,
    docs: (overlay.docs as DocFixture[] | undefined) ?? base.docs,
    unitEconomics: (overlay.unitEconomics as UnitEconomicsRow[] | undefined) ?? base.unitEconomics,
  };
  return { ok: true, fixtures: next };
}
