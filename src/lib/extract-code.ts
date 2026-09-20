/* ────────────────────────────────────────────────────────────────────────────
   Pull the code out of a model reply, however the model chose to format it.

   The widget creator, AI Studio and the IDE all asked for "one fenced block"
   and all failed with "No HTML block came back" whenever a model did any of
   the ordinary things models do:

   - wrote a sentence first ("Here's your widget:") and then raw HTML;
   - hit the token limit mid-widget, so the closing fence never arrived;
   - opened with a <think>…</think> reasoning block (common on OpenRouter);
   - fenced with ~~~ or four backticks.

   Every one of those replies CONTAINED the code. Refusing them made the
   feature fail on exactly the models people use, so the parser is lenient
   about form and strict only about whether there is code at all.
   ──────────────────────────────────────────────────────────────────────────── */

/** Reasoning traces some models emit before the answer. An UNCLOSED one means
 *  the model spent its whole budget thinking, so nothing after it is code. */
function stripReasoning(text: string): string {
  const closed = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  return /<(think|thinking|reasoning)>/i.test(closed) ? closed.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, "") : closed;
}

/** Tags that mean "this is where the markup starts". A bare "<" is not enough:
 *  prose like "use a value < 10" must not be mistaken for HTML. */
const MARKUP_START = /<(?:!doctype|html|head|body|div|main|section|article|header|nav|style|script|svg|canvas|template|span|p|h[1-6]|ul|ol|button|input|form|table|link|meta)\b/i;
const CODE_START = /^(?:import|export|function|const|let|var|class|async|interface|type|\/\/|\/\*)\b/m;

export function extractCode(text: string): string | null {
  const body = stripReasoning(text ?? "");

  // Closed fences of ``` or ~~~ (3+). The longest block wins: a reply that
  // shows a tiny usage example and then the widget wants the widget.
  const closed = [...body.matchAll(/(`{3,}|~{3,})[\w-]*[^\n]*\n([\s\S]*?)\1/g)]
    .map((m) => (m[2] ?? "").replace(/\n$/, ""))
    .filter((b) => b.trim().length > 0);
  if (closed.length) return closed.sort((a, b) => b.length - a.length)[0] ?? null;

  // An opening fence with no close: the model was cut off. Everything after
  // the fence is the code it managed to write.
  const open = body.match(/(`{3,}|~{3,})[\w-]*[^\n]*\n([\s\S]+)$/);
  if (open && (open[2] ?? "").trim()) return (open[2] as string).trimEnd();

  // No fence at all. Start at the first real tag and drop any prose before it
  // and after the last closing ">".
  const at = body.search(MARKUP_START);
  if (at >= 0) {
    const from = body.slice(at);
    const end = from.lastIndexOf(">");
    return (end >= 0 ? from.slice(0, end + 1) : from).trim() || null;
  }

  const code = body.match(CODE_START);
  if (code && code.index !== undefined) return body.slice(code.index).trim() || null;
  return null;
}

/** Why extraction failed, in words a person can act on. */
export function explainNoCode(text: string): string {
  const raw = (text ?? "").trim();
  if (!raw) return "The model returned an empty reply. Some reasoning-only models put everything in a hidden field — try a different model.";
  if (/<(think|thinking|reasoning)>/i.test(raw) && !stripReasoning(raw).trim()) {
    return "The model spent its whole budget reasoning and never wrote the code. Try again, or pick a faster model.";
  }
  const snippet = raw.replace(/\s+/g, " ").slice(0, 160);
  return `No code came back. The model replied: "${snippet}${raw.length > 160 ? "…" : ""}"`;
}
