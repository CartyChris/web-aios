/* Action-space validation. Port of SystemOneHarness's load-time check (design
   only, Apache-2.0 upstream): every parameter must be enumerable, so an action
   that asks for free text is refused before a run can start. */

import type { ActionSpec, ParamSpec, Risk } from "./types";

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const RISKS: readonly Risk[] = ["read", "write", "destructive", "finish"];
const KINDS = ["choices", "candidates", "flag", "levels"] as const;

export type ValidateResult = { ok: true; actions: ActionSpec[] } | { ok: false; errors: string[] };

export function validateActionSpace(input: unknown): ValidateResult {
  const errors: string[] = [];
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: ["the action space must be a non-empty array"] };
  const seen = new Set<string>();
  input.forEach((raw, i) => {
    const a = raw as Partial<ActionSpec> | null;
    const where = `action ${i}${a && typeof a.name === "string" ? ` "${a.name}"` : ""}`;
    if (!a || typeof a !== "object") { errors.push(`${where}: not an object`); return; }
    if (typeof a.name !== "string" || !NAME.test(a.name)) errors.push(`${where}: name must match ${NAME}`);
    else if (seen.has(a.name)) errors.push(`${where}: duplicate name`);
    else seen.add(a.name);
    if (typeof a.description !== "string" || !a.description.trim()) errors.push(`${where}: needs a description`);
    if (!RISKS.includes(a.risk as Risk)) errors.push(`${where}: risk must be one of ${RISKS.join(", ")}`);
    const pnames = new Set<string>();
    for (const p of (a.params ?? []) as Array<Partial<ParamSpec> & { kind?: string }>) {
      const pw = `${where} param "${String(p?.name)}"`;
      if (!p || typeof p.name !== "string" || !NAME.test(p.name)) { errors.push(`${pw}: name must match ${NAME}`); continue; }
      if (pnames.has(p.name)) errors.push(`${pw}: duplicate parameter`);
      pnames.add(p.name);
      if (!KINDS.includes(p.kind as (typeof KINDS)[number])) {
        // The rule that matters most: a decider that only picks among offered
        // options cannot fill in a string, so do not pretend it can.
        errors.push(`${pw}: kind "${String(p.kind)}" is not enumerable; use choices, candidates, flag or levels (free text is refused)`);
        continue;
      }
      if (p.kind === "choices") {
        const keys = Object.keys((p as { choices?: Record<string, string> }).choices ?? {});
        if (keys.length < 2) errors.push(`${pw}: choices needs at least two options`);
        if (keys.length > 255) errors.push(`${pw}: at most 255 choices`);
      }
      if (p.kind === "levels") {
        const n = ((p as { levels?: string[] }).levels ?? []).length;
        if (n < 2 || n > 10) errors.push(`${pw}: levels needs 2 to 10 ordered entries`);
      }
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, actions: input as ActionSpec[] };
}
