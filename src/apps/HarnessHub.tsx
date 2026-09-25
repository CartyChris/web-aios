"use client";

import { useState } from "react";
import type { AppProps } from "@/kernel/types";
import { bus } from "@/kernel/bus";
import { cn } from "@/lib/cn";
import { Icon } from "@/shell/icons";
import DeepSeekHarness from "./DeepSeekHarness";
import SystemOne from "./SystemOne";
import Harness from "./Harness";

/* Harness Hub: the three agent harnesses side by side as tabs, each the
   standalone app's own component (imported, not copied), with a Pop out that
   opens the standalone window. A separate app rather than tabs inside
   DeepSeek Harness, so each harness keeps its own window and nothing about
   the standalone apps changes. Only the active tab is mounted. */

const HARNESSES = [
  { id: "deepseek-harness", label: "DeepSeek Harness", icon: "agents" },
  { id: "systemone", label: "System One", icon: "gate" },
  { id: "harness", label: "ReAct Harness", icon: "harness" },
] as const;

export default function HarnessHub({ win, args }: AppProps) {
  const [tab, setTab] = useState<string>(HARNESSES[0].id);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] px-2 py-1.5" role="tablist" aria-label="Harnesses">
        {HARNESSES.map((h) => (
          <button key={h.id} role="tab" aria-selected={tab === h.id} onClick={() => setTab(h.id)}
            className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]", tab === h.id ? "bg-[var(--accent)]/20 font-semibold" : "hover:bg-white/5")}>
            <Icon name={h.icon} size={12} />{h.label}
          </button>
        ))}
        <span className="flex-1" />
        <button className="os-btn text-[11px]" onClick={() => bus.emit("app:open", { appId: tab })} aria-label={`Pop out ${HARNESSES.find((h) => h.id === tab)?.label} into its own window`}>
          <Icon name="external" size={12} className="mr-1 inline-block" />Pop out
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "deepseek-harness" && <DeepSeekHarness win={win} args={args} />}
        {tab === "systemone" && <SystemOne win={win} args={args} />}
        {tab === "harness" && <Harness win={win} args={args} />}
      </div>
    </div>
  );
}
