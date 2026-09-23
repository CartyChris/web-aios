"use client";

import { useModelCatalog } from "@/kernel/modelcatalog";
import { getProvider } from "@/lib/providers";
import { describeRefresh } from "@/lib/model-lists";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

/** The refresh control for one provider's model list: a button that asks the
 *  provider again, a spinner while it does, and one plain line saying where the
 *  list came from and when — including, in words, when it fell back to the
 *  built-in catalogue and why (no key, provider error, nothing running). */
export function ModelRefreshButton({ providerId, compact = false, className }: { providerId: string; compact?: boolean; className?: string }) {
  const busy = useModelCatalog((s) => Boolean(s.busy[providerId]));
  const refresh = useModelCatalog((s) => s.refresh);
  const name = getProvider(providerId)?.name ?? providerId;
  return (
    <button
      type="button"
      onClick={() => { void refresh(providerId); }}
      disabled={busy}
      aria-label={`Refresh the ${name} model list`}
      title={`Refresh the ${name} model list`}
      aria-busy={busy}
      className={cn(compact ? "shrink-0 opacity-60 hover:opacity-100 disabled:opacity-40" : "os-btn inline-flex items-center gap-1 !py-1 text-[11px]", className)}
    >
      {busy ? (
        <span
          className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent"
          style={{ animation: "os-spin 700ms linear infinite" }}
        />
      ) : (
        <Icon name="refresh" size={compact ? 13 : 12} />
      )}
      {!compact && <span>{busy ? "Refreshing" : "Refresh"}</span>}
    </button>
  );
}

export function ModelRefreshStatus({ providerId, className }: { providerId: string; className?: string }) {
  const record = useModelCatalog((s) => s.lists[providerId]);
  const busy = useModelCatalog((s) => Boolean(s.busy[providerId]));
  const now = useNow(30_000);
  const fellBack = record?.source === "catalog";
  return (
    <span className={cn(fellBack && "text-[var(--warn)]", className)} role="status">
      {busy ? "asking the provider for its current list" : describeRefresh(record, now)}
    </span>
  );
}
