"use client";

/* One way to fetch a catalogue service from the browser, so the Open Data app,
   the harness and desktop widgets cannot drift apart on how a failure reads. */

import type { ServiceDef } from "./services";

/** A host that sends CORS headers is called directly; everything else goes
 *  through the SSRF-guarded relay. A non-ok status throws so an error page is
 *  never handed to a parser, which would report it as an API shape change. */
export async function fetchServiceText(
  def: ServiceDef,
  args: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ body: string; url: string }> {
  const url = def.url(args);
  if (def.reach === "direct") {
    const res = await fetch(url, { signal, headers: { accept: "application/json, text/plain, */*" } });
    if (!res.ok) throw new Error(`${def.provider} answered HTTP ${res.status}.`);
    return { body: await res.text(), url };
  }
  const res = await fetch(`/api/proxy?mode=raw&url=${encodeURIComponent(url)}`, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch { /* a non-JSON error body is still an error */ }
    throw new Error(detail);
  }
  return { body: await res.text(), url };
}
