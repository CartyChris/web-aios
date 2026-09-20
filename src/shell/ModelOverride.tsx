"use client";

import { useSettings } from "@/kernel/settings";
import { PROVIDERS, getProvider } from "@/lib/providers";

/** A per-task model choice. Empty means "the model in the top bar", which is
 *  the default everywhere — this only exists for the one generation where you
 *  want something else (a stronger coder, a cheaper drafter). */
export interface ModelChoice { provider?: string; model?: string }

export function ModelOverride({ value, onChange, id }: { value: ModelChoice; onChange: (v: ModelChoice) => void; id: string }) {
  const ai = useSettings((s) => s.ai);
  const provider = value.provider ?? "";
  const models = getProvider(provider || ai.provider)?.models ?? [];
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[11px]">
      <select
        className="os-input !w-auto !py-1 text-[11px]"
        value={provider}
        onChange={(e) => onChange(e.target.value ? { provider: e.target.value, model: "" } : {})}
        title="Which model runs this one generation"
      >
        <option value="">Top bar: {ai.model}</option>
        {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {provider && (
        <>
          <input
            className="os-input !w-40 !py-1 text-[11px]"
            placeholder="model id"
            value={value.model ?? ""}
            list={`models-${id}`}
            onChange={(e) => onChange({ provider, model: e.target.value })}
          />
          <datalist id={`models-${id}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
        </>
      )}
    </span>
  );
}

/** ask() options for a choice: nothing when it is the top-bar default, and
 *  nothing half-specified — a provider with no model would fail at request time. */
export function overrideOpts(v: ModelChoice): { provider?: string; model?: string } {
  return v.provider && v.model?.trim() ? { provider: v.provider, model: v.model.trim() } : {};
}
