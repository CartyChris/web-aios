/* Headlines from free, no-key feeds: RSS 2.0 / RSS 1.0 (RDF), Atom 1.0, JSON Feed and
   Hacker News Algolia JSON, normalised into one small shape. Pure so the parts that
   decide what becomes an href can be tested without a browser. Items with no safe
   http(s) link are DROPPED rather than kept link-less: a headline the widget cannot
   open is noise, and it keeps "every rendered url is safe" a one-line invariant. */

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  publishedAt?: number;
  source?: string;
  summary?: string;
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

export const MAX_ITEMS = 50;
const SUMMARY_MAX = 200;

/* Every entry here was fetched live and run through parseFeed on 2026-09-18. */
export const NEWS_SOURCES: Array<{ id: string; name: string; url: string; category: string }> = [
  { id: "hn-front", name: "Hacker News", url: "https://hnrss.org/frontpage", category: "tech" },
  { id: "bbc-world", name: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml", category: "world" },
  { id: "npr-news", name: "NPR News", url: "https://feeds.npr.org/1001/rss.xml", category: "world" },
  { id: "ars", name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", category: "tech" },
  { id: "verge", name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "tech" },
  { id: "github-blog", name: "GitHub Blog", url: "https://github.blog/feed/", category: "tech" },
  { id: "bbc-science", name: "BBC Science", url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", category: "science" },
  { id: "nasa", name: "NASA", url: "https://www.nasa.gov/feed/", category: "science" },
  { id: "nature", name: "Nature", url: "https://www.nature.com/nature.rss", category: "science" },
  { id: "sciencedaily", name: "ScienceDaily", url: "https://www.sciencedaily.com/rss/all.xml", category: "science" },
  { id: "arxiv-ai", name: "arXiv cs.AI", url: "https://rss.arxiv.org/rss/cs.AI", category: "ai" },
  { id: "hn-algolia", name: "HN Front Page (Algolia)", url: "https://hn.algolia.com/api/v1/search?tags=front_page", category: "tech" },
];

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // fromCodePoint throws outside the Unicode range; a hostile feed must not crash the parse.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return "";
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Only absolute http(s) survives: the result is used as an href. */
export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined; // relative, or garbage
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
}

/* XML text -> plain text. CDATA is literal; everything else is entity-decoded before
   tags are stripped, because RSS descriptions are routinely entity-escaped HTML.
   A final decode handles type="html" titles whose CDATA still carries &amp;. */
function textOf(raw: string | undefined): string {
  if (raw == null) return "";
  let out = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  out += decodeEntities(raw.slice(last));
  return clean(out);
}

function clean(html: string): string {
  const noTags = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

function clip(s: string): string | undefined {
  if (!s) return undefined;
  return s.length <= SUMMARY_MAX ? s : s.slice(0, SUMMARY_MAX - 1).trimEnd() + "…";
}

function esc(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Inner text of the first <name ...>...</name> in xml. `<title` never matches `<media:title`. */
function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, "i").exec(xml);
  return m ? m[1] : undefined;
}

function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<${esc(name)}(?:\\s[^>]*)?>[\\s\\S]*?</${esc(name)}>`, "gi");
  return xml.match(re) ?? [];
}

function attr(tagText: string, name: string): string | undefined {
  const m = new RegExp(`\\s${esc(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tagText);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined;
}

function date(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const t = Date.parse(textOf(raw));
  return Number.isFinite(t) ? t : undefined;
}

type Draft = { id?: string; title: string; url?: string; publishedAt?: number; source?: string; summary?: string };

function finish(drafts: Draft[]): FeedItem[] {
  const seenUrl = new Set<string>();
  const seenId = new Set<string>();
  const out: FeedItem[] = [];
  for (const d of drafts) {
    const url = safeUrl(d.url);
    if (!url || !d.title) continue;
    const id = d.id || url;
    if (seenUrl.has(url) || seenId.has(id)) continue;
    seenUrl.add(url);
    seenId.add(id);
    const item: FeedItem = { id, title: d.title, url };
    if (d.publishedAt !== undefined) item.publishedAt = d.publishedAt;
    if (d.source) item.source = d.source;
    if (d.summary) item.summary = d.summary;
    out.push(item);
  }
  // Array.prototype.sort is stable, so undated items keep feed order at the bottom.
  out.sort((a, b) => {
    if (a.publishedAt === undefined) return b.publishedAt === undefined ? 0 : 1;
    if (b.publishedAt === undefined) return -1;
    return b.publishedAt - a.publishedAt;
  });
  return out.slice(0, MAX_ITEMS);
}

/* The root element decides the format. Searching for "<item" anywhere would let an
   HTML error page that happens to mention one sneak through as a feed. */
function rootName(xml: string): string | undefined {
  const s = xml
    .replace(/^﻿/, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const m = /^\s*<([A-Za-z_][\w:.-]*)/.exec(s);
  return m ? m[1].toLowerCase() : undefined;
}

function parseRss(xml: string, sourceName?: string): FeedItem[] {
  const firstItem = xml.search(/<item[\s>]/i);
  const head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
  const source = sourceName || textOf(tag(head, "title")) || undefined;
  return finish(
    blocks(xml, "item").map((b) => {
      const guid = tag(b, "guid");
      const guidText = guid !== undefined ? textOf(guid) : undefined;
      const guidTag = /<guid(\s[^>]*)?>/i.exec(b)?.[0] ?? "";
      const guidIsLink = attr(guidTag, "isPermaLink") !== "false";
      const about = attr(/<item(\s[^>]*)?>/i.exec(b)?.[0] ?? "", "rdf:about");
      const link = textOf(tag(b, "link")) || (guidIsLink ? guidText : undefined) || about;
      return {
        id: guidText || about || undefined,
        title: textOf(tag(b, "title")),
        url: link,
        publishedAt: date(tag(b, "pubDate") ?? tag(b, "dc:date") ?? tag(b, "published") ?? tag(b, "updated")),
        source,
        summary: clip(textOf(tag(b, "description") ?? tag(b, "content:encoded"))),
      };
    }),
  );
}

function atomLink(entry: string): string | undefined {
  const links = entry.match(/<link\b[^>]*>/gi) ?? [];
  let fallback: string | undefined;
  for (const l of links) {
    const rel = (attr(l, "rel") ?? "alternate").toLowerCase();
    const href = attr(l, "href");
    if (!href) continue;
    if (rel === "alternate") return href;
    fallback ??= href;
  }
  return fallback;
}

function parseAtom(xml: string, sourceName?: string): FeedItem[] {
  const firstEntry = xml.search(/<entry[\s>]/i);
  const head = firstEntry >= 0 ? xml.slice(0, firstEntry) : xml;
  const source = sourceName || textOf(tag(head, "title")) || undefined;
  return finish(
    blocks(xml, "entry").map((b) => ({
      id: textOf(tag(b, "id")) || undefined,
      title: textOf(tag(b, "title")),
      url: atomLink(b),
      publishedAt: date(tag(b, "published") ?? tag(b, "updated")),
      source,
      summary: clip(textOf(tag(b, "summary") ?? tag(b, "content"))),
    })),
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(data: unknown, sourceName?: string): FeedItem[] {
  if (!isRecord(data)) throw new FeedParseError("JSON is not a feed object");
  if (Array.isArray(data.items)) {
    const source = sourceName || str(data.title);
    return finish(
      data.items.filter(isRecord).map((it) => ({
        id: str(it.id),
        title: clean(str(it.title) ?? ""),
        url: str(it.url) ?? str(it.external_url),
        publishedAt: date(str(it.date_published) ?? str(it.date_modified)),
        source,
        summary: clip(clean(str(it.summary) ?? str(it.content_text) ?? str(it.content_html) ?? "")),
      })),
    );
  }
  if (Array.isArray(data.hits)) {
    return finish(
      data.hits.filter(isRecord).map((h) => {
        const objectID = str(h.objectID);
        // Ask HN / Show HN posts have no external url; the discussion page is the link.
        const discussion = objectID ? `https://news.ycombinator.com/item?id=${encodeURIComponent(objectID)}` : undefined;
        const secs = typeof h.created_at_i === "number" ? h.created_at_i : undefined;
        return {
          id: objectID,
          title: clean(str(h.title) ?? str(h.story_title) ?? ""),
          url: str(h.url) || discussion,
          publishedAt: secs !== undefined ? secs * 1000 : date(str(h.created_at)),
          source: sourceName || "Hacker News",
          summary: clip(clean(str(h.story_text) ?? "")),
        };
      }),
    );
  }
  throw new FeedParseError("JSON has neither items[] (JSON Feed) nor hits[] (HN Algolia)");
}

export function parseFeed(body: string, sourceName?: string): FeedItem[] {
  const trimmed = body.replace(/^﻿/, "").trim();
  if (!trimmed) throw new FeedParseError("Empty response");
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new FeedParseError("Response looks like JSON but does not parse");
    }
    return parseJson(data, sourceName);
  }
  const root = rootName(trimmed);
  if (root === "rss" || root === "rdf:rdf") return parseRss(trimmed, sourceName);
  if (root === "feed") return parseAtom(trimmed, sourceName);
  throw new FeedParseError(root ? `Not a feed: the document is <${root}>` : "Not a feed: no XML or JSON found");
}

export function relativeAge(publishedAt: number | undefined, now: number): string {
  if (publishedAt === undefined || !Number.isFinite(publishedAt)) return "";
  const s = Math.floor((now - publishedAt) / 1000);
  // Clock skew makes "published in 2 minutes" common; that is still "now" to a reader.
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
