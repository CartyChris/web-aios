import type { JsonSchema, JsonSchemaProp, ToolDef, ToolResult } from "./types";
import {
  SERVICES, type ServiceDef, ServiceParseError, withDefaults, missingParams,
} from "../services";

/* ────────────────────────────────────────────────────────────────────────────
   Live tools — the free-services catalogue, exposed to the agent.

   Every built-in tool so far answers out of a fixed fixture set, which is what
   makes a trace replayable. These do not: they reach the open web. That is a
   real change in kind, and the module makes the difference explicit rather
   than hiding it — each of these is `deterministic: false`, which
   `toolCatalogueText` renders into the system prompt as "do not quote this as
   a fixed figure". An agent that cannot tell an audited number from a live one
   will eventually put a live one in a report as though it were audited.

   The module stays PURE in the sense the harness requires: no window, no
   fetch, no clock. The transport arrives as `FetchText`, which is what lets
   the whole catalogue be driven in Node against recorded payloads and a
   scripted failure.
   ──────────────────────────────────────────────────────────────────────────── */

/** Injected transport. Resolves with the decoded body, or rejects — a network
 *  failure must not be indistinguishable from an empty answer. */
export type FetchText = (url: string, opts: { signal: AbortSignal; reach: ServiceDef["reach"] }) => Promise<string>;

export interface WebToolOptions {
  fetchText: FetchText;
  /** Restrict the catalogue. An OS that hands an agent 24 open-world tools it
   *  will never use spends the whole system prompt on the catalogue. */
  only?: string[];
  timeoutMs?: number;
}

const WEB_TIMEOUT_MS = 20_000;
const MAX_ROWS_IN_OBSERVATION = 12;

/** Tool names are `^[a-z][a-z0-9_]{1,39}$`, matched by the action parser, and a
 *  service id that breaks that would register a tool the model can see in the
 *  catalogue and can never successfully call. */
export function toolNameFor(serviceId: string): string {
  return `web_${serviceId}`.slice(0, 40);
}

function schemaFor(def: ServiceDef): JsonSchema {
  const properties: Record<string, JsonSchemaProp> = {};
  for (const p of def.params) {
    properties[p.name] = {
      type: p.kind === "number" ? "number" : "string",
      description: `${p.label}. e.g. ${p.placeholder}`,
      ...(p.default !== undefined ? { default: p.default } : {}),
    };
  }
  return {
    type: "object",
    properties,
    required: def.params.filter((p) => p.required).map((p) => p.name),
  };
}

function exampleFor(def: ServiceDef): string {
  const args: Record<string, string> = {};
  for (const p of def.params) {
    if (p.required || p.default === undefined) args[p.name] = p.placeholder.split(" (")[0] ?? p.placeholder;
  }
  return `${toolNameFor(def.id)}[${JSON.stringify(args)}]`;
}

/** Coerce the loosely-typed args a parsed action carries into the strings the
 *  catalogue's URL builders expect. A number that arrives as 64.146 must not
 *  reach the URL as "[object Object]" or as "64.146000000001". */
function stringifyArgs(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
    else if (typeof v === "boolean") out[k] = String(v);
    // An object or an array is not something any URL builder here accepts, and
    // silently coercing it produces a URL that 400s with no clue why.
  }
  return out;
}

function toolFor(def: ServiceDef, opts: WebToolOptions): ToolDef {
  const name = toolNameFor(def.id);
  return {
    name,
    title: def.name,
    description: `${def.description} Live data from ${def.provider} (${def.licence}); the answer may change between runs.`,
    inputSchema: schemaFor(def),
    // The honest flag. Nothing here is replayable and the catalogue says so.
    deterministic: false,
    // `annotationsFor` fails closed on a name whose segments it does not
    // recognise, and "web_wikipedia" is one: it comes back readOnly:false,
    // destructive:true, requiresApproval:true. That default is right for an
    // unknown tool and wrong for these, and leaving it produces a guard that
    // defeats the feature — with the shipped `approvals: "destructive"` policy
    // and the runtime's deny-by-default approver, EVERY live tool would be
    // refused before it ran, and the agent would reason from the refusal.
    //
    // openWorld stays true, because these genuinely reach the open web and the
    // catalogue says so. requiresApproval does not, because the set is closed
    // and reviewed: a keyless, credential-free GET against a public data API
    // named in `lib/services.ts` is not a decision a person needs to take once
    // per call. Approval still gates anything that writes.
    annotations: { readOnly: true, destructive: false, openWorld: true, requiresApproval: false },
    timeoutMs: opts.timeoutMs ?? WEB_TIMEOUT_MS,
    example: exampleFor(def),
    run: async (rawArgs, ctx): Promise<ToolResult> => {
      const args = withDefaults(def, stringifyArgs(rawArgs));

      const missing = missingParams(def, args);
      if (missing.length > 0) {
        return {
          status: "invalid_args",
          // Name the constraint AND the way forward: an observation that only
          // says "invalid" sends the model round the same loop.
          observation: `${name} needs ${missing.join(" and ")}. Call it again as ${def.params
            .filter((p) => p.required)
            .map((p) => `${p.name}=<${p.placeholder}>`)
            .join(", ")}.`,
          error: `missing required argument(s): ${missing.join(", ")}`,
          ms: 0,
        };
      }

      let url: string;
      try {
        url = def.url(args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "could not build the request";
        return { status: "invalid_args", observation: `${name} could not build a request: ${msg}.`, error: msg, ms: 0 };
      }

      let body: string;
      try {
        body = await opts.fetchText(url, { signal: ctx.signal, reach: def.reach });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "the request failed";
        return {
          status: "error",
          // An outage is not a miss. Saying so stops the model concluding the
          // subject does not exist.
          observation: `${name} could not reach ${def.provider}: ${msg}. This is a transport failure, not an empty result — the query was not answered. Try again, or reason without it and say the figure is unavailable.`,
          error: msg,
          ms: 0,
        };
      }

      let parsed;
      try {
        parsed = def.parse(body);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "the response could not be read";
        return {
          status: "error",
          observation: `${name} reached ${def.provider} but could not read the reply: ${msg}. Do not treat this as "no results".`,
          error: e instanceof ServiceParseError ? e.message : msg,
          ms: 0,
        };
      }

      const shown = parsed.rows.slice(0, MAX_ROWS_IN_OBSERVATION);
      const truncated = parsed.rows.length - shown.length;
      const lines = shown.map((r, i) => `${i + 1}. ${r.title}${r.meta ? ` [${r.meta}]` : ""} — ${r.detail}${r.url ? ` <${r.url}>` : ""}`);
      const header = parsed.empty
        ? `${name}: no results for those arguments. The service answered normally; the query simply matched nothing.`
        : `${name} via ${def.provider} (${def.licence}) — ${parsed.rows.length} result${parsed.rows.length === 1 ? "" : "s"}:`;
      const footer = truncated > 0 ? `\n(+${truncated} more not shown)` : "";

      return {
        status: "ok",
        observation: `${header}${lines.length > 0 ? `\n${lines.join("\n")}` : ""}${footer}`,
        value: { serviceId: def.id, provider: def.provider, licence: def.licence, rows: parsed.rows, empty: parsed.empty },
        ms: 0,
      };
    },
  };
}

/** Build a tool per service. `only` filters by SERVICE id, not tool name — the
 *  caller thinks in services. */
export function webTools(opts: WebToolOptions): ToolDef[] {
  const wanted = opts.only ? new Set(opts.only) : null;
  return SERVICES.filter((s) => !wanted || wanted.has(s.id)).map((s) => toolFor(s, opts));
}

/** The subset worth handing a general research agent by default. The full
 *  catalogue is available by id; this is what fits in a system prompt without
 *  crowding out the deterministic tools that carry the audited numbers. */
export const DEFAULT_WEB_TOOLS = [
  "wikipedia", "arxiv", "crossref", "hackernews", "github",
  "geocode", "weather", "fx", "countries", "dictionary",
];
