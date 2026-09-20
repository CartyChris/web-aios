/* Feed parsing decides what text reaches the desktop and which strings become hrefs,
 * so every safety check here is paired with a control proving it still lets good
 * input through. Fixtures are trimmed excerpts shaped like the live feeds. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFeed, relativeAge, FeedParseError, NEWS_SOURCES, MAX_ITEMS, safeUrl, decodeEntities,
} from "../.test-build/feeds.js";

const rss = (items, channelTitle = "Hacker News: Front Page") => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>${channelTitle}</title><link>https://news.ycombinator.com/</link>
<atom:link href="https://hnrss.org/frontpage" rel="self" type="application/rss+xml"/>
${items}
</channel></rss>`;

const rssItem = ({ title, link, date, guid, desc = "" }) => `<item>
<title><![CDATA[${title}]]></title>
<description><![CDATA[${desc}]]></description>
${date ? `<pubDate>${date}</pubDate>` : ""}
${link !== undefined ? `<link>${link}</link>` : ""}
${guid ? `<guid isPermaLink="false">${guid}</guid>` : ""}
</item>`;

test("RSS 2.0: title, link, date, summary and source come through", () => {
  const items = parseFeed(rss(rssItem({
    title: "Android 17 adds new APIs", link: "https://grapheneos.social/@x/1",
    date: "Fri, 18 Sep 2026 12:06:50 +0000", guid: "https://news.ycombinator.com/item?id=1",
    desc: '<p>Article URL: <a href="https://grapheneos.social/@x/1">link</a></p>',
  })));
  assert.equal(items.length, 1);
  const [it] = items;
  assert.equal(it.title, "Android 17 adds new APIs");
  assert.equal(it.url, "https://grapheneos.social/@x/1");
  assert.equal(it.publishedAt, Date.UTC(2026, 8, 18, 12, 6, 50));
  assert.equal(it.source, "Hacker News: Front Page", "falls back to the channel title");
  assert.ok(!it.summary.includes("<"), "tags stripped from the summary");
  assert.ok(it.summary.includes("Article URL"));
});

test("an explicit source name beats the channel title", () => {
  const [it] = parseFeed(rss(rssItem({ title: "t", link: "https://a.example/1" })), "HN");
  assert.equal(it.source, "HN");
});

test("RSS 1.0 (RDF), as Nature serves it, parses with dc:date", () => {
  const body = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://purl.org/rss/1.0/">
<channel rdf:about="https://www.nature.com/nature.rss"><title>Nature</title></channel>
<item rdf:about="https://www.nature.com/articles/d41586-026-02897-4">
  <title><![CDATA[Cognitive resilience helps to predict Alzheimer’s dementia]]></title>
  <link>https://www.nature.com/articles/d41586-026-02897-4</link>
  <dc:title><![CDATA[Cognitive resilience helps to predict Alzheimer’s dementia]]></dc:title>
  <dc:date>2026-09-18</dc:date>
</item></rdf:RDF>`;
  const [it] = parseFeed(body);
  assert.equal(it.url, "https://www.nature.com/articles/d41586-026-02897-4");
  assert.equal(it.publishedAt, Date.UTC(2026, 8, 18));
  assert.equal(it.source, "Nature");
});

test("Atom: prefers rel=alternate over an earlier rel=replies link", () => {
  const body = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<title type="html"><![CDATA[The Verge]]></title>
<entry>
  <author><name>Lauren Feiner</name></author>
  <title type="html"><![CDATA[Virginia creates an AI task force &amp; restrains data centers]]></title>
  <link rel="replies" type="text/html" href="https://www.theverge.com/x#comments" />
  <link rel="alternate" type="text/html" href="https://www.theverge.com/policy/997573/virginia" />
  <id>https://www.theverge.com/?p=997573</id>
  <updated>2026-09-18T15:09:19-04:00</updated>
  <published>2026-09-18T14:29:17-04:00</published>
  <summary type="html"><![CDATA[<p>Virginia Gov. ordered a review.</p>]]></summary>
</entry></feed>`;
  const [it] = parseFeed(body);
  assert.equal(it.url, "https://www.theverge.com/policy/997573/virginia");
  assert.equal(it.id, "https://www.theverge.com/?p=997573");
  // published wins over updated: it is when the story appeared.
  assert.equal(it.publishedAt, Date.parse("2026-09-18T14:29:17-04:00"));
  assert.equal(it.title, "Virginia creates an AI task force & restrains data centers");
  assert.equal(it.summary, "Virginia Gov. ordered a review.");
  assert.equal(it.source, "The Verge");
});

test("Atom: a link with no rel counts as alternate", () => {
  const body = `<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
<entry><title>a</title><link href="https://a.example/post"/><id>tag:1</id></entry></feed>`;
  assert.equal(parseFeed(body)[0].url, "https://a.example/post");
});

test("JSON Feed 1.1 items[]", () => {
  const body = JSON.stringify({
    version: "https://jsonfeed.org/version/1.1", title: "JSON Feed",
    items: [
      { id: "1", url: "https://www.jsonfeed.org/2020/08/07/json-feed-version.html", title: "JSON Feed version 1.1", date_published: "2020-08-07T11:44:36-05:00", content_html: "<p>We&rsquo;ve updated the spec.</p>" },
      { id: "2", external_url: "https://b.example/ext", title: "External only" },
    ],
  });
  const items = parseFeed(body);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "JSON Feed version 1.1");
  assert.ok(!items[0].summary.includes("<p>"));
  assert.equal(items[1].url, "https://b.example/ext", "external_url is used when url is absent");
  assert.equal(items[0].source, "JSON Feed");
});

test("HN Algolia hits[]: seconds become ms, Ask HN falls back to the discussion page", () => {
  const body = JSON.stringify({
    hits: [
      { objectID: "49753211", title: "I don't like passkeys", url: "https://hawksley.dev/blog/passkeys", created_at_i: 1789733210, created_at: "2026-09-18T12:06:50Z", author: "e" },
      { objectID: "49753999", title: "Ask HN: What are you working on?", url: null, created_at_i: 1789733000 },
    ],
    exhaustiveNbHits: true,
  });
  const items = parseFeed(body);
  assert.equal(items[0].publishedAt, 1789733210 * 1000);
  assert.equal(items[0].source, "Hacker News");
  const ask = items.find((i) => i.title.startsWith("Ask HN"));
  assert.equal(ask.url, "https://news.ycombinator.com/item?id=49753999");
});

test("CDATA is literal: markup-looking text inside is stripped, not executed", () => {
  const [it] = parseFeed(rss(rssItem({ title: "<b>Bold</b> move", link: "https://a.example/1" })));
  assert.equal(it.title, "Bold move");
});

test("entities: named, decimal and hex all decode; unknown ones are left alone", () => {
  const item = `<item><title>AT&amp;T &lt;3 &quot;q&quot; it&#39;s it&#x27;s &#8212; &#x2014; &bogus;</title><link>https://a.example/e</link></item>`;
  const [it] = parseFeed(rss(item));
  // "<3" is text, not a tag — there is no closing ">". Titles render as escaped
  // React text, so it is safe to show, and stripping it would corrupt what the
  // publisher actually wrote.
  assert.equal(it.title, `AT&T <3 "q" it's it's — — &bogus;`);
  // What MUST go is entity-escaped markup, which RSS descriptions carry all the
  // time; left in, the reader sees literal "<p>" in every headline.
  const [tagged] = parseFeed(rss(`<item><title>A &lt;b&gt;bold&lt;/b&gt; claim</title><link>https://a.example/t</link></item>`));
  assert.equal(tagged.title, "A bold claim");
  assert.equal(decodeEntities("&#x110000;"), "", "out-of-range code point is dropped, not thrown");
  assert.equal(decodeEntities("plain"), "plain");
});

test("summaries are capped at 200 characters", () => {
  const [it] = parseFeed(rss(rssItem({ title: "t", link: "https://a.example/1", desc: "word ".repeat(200) })));
  assert.ok(it.summary.length <= 200);
  const [short] = parseFeed(rss(rssItem({ title: "t", link: "https://a.example/1", desc: "short" })));
  assert.equal(short.summary, "short", "control: a short summary is not truncated");
});

test("security: javascript:, data:, vbscript: and relative links are dropped", () => {
  const bad = ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>x</script>", "vbscript:msgbox", "/relative/path", "//no-scheme.example/x"];
  for (const link of bad) {
    const items = parseFeed(rss(rssItem({ title: "bad", link: link.replace(/</g, "&lt;") })));
    assert.equal(items.length, 0, `${link} must not produce an item`);
    assert.equal(safeUrl(link), undefined);
  }
});

test("security control: a normal https (and http) link survives", () => {
  const items = parseFeed(rss(
    rssItem({ title: "good", link: "https://ok.example/a", date: "Fri, 18 Sep 2026 12:00:00 +0000" }) +
    rssItem({ title: "plain", link: "http://ok.example/b", date: "Fri, 18 Sep 2026 11:00:00 +0000" }),
  ));
  assert.deepEqual(items.map((i) => i.url), ["https://ok.example/a", "http://ok.example/b"]);
});

test("an HTML error page throws FeedParseError instead of returning []", () => {
  const html = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502</h1><p>see <item> and <rss> here</p></body></html>`;
  assert.throws(() => parseFeed(html), FeedParseError);
  assert.throws(() => parseFeed(""), FeedParseError);
  assert.throws(() => parseFeed("{not json"), FeedParseError);
  assert.throws(() => parseFeed(JSON.stringify({ error: "rate limited" })), FeedParseError);
});

test("an empty but valid feed returns [] (and does not throw)", () => {
  assert.deepEqual(parseFeed(rss("")), []);
  assert.deepEqual(parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>`), []);
  assert.deepEqual(parseFeed(JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [] })), []);
  assert.deepEqual(parseFeed(JSON.stringify({ hits: [] })), []);
});

test("dedupe by url, then by id", () => {
  const items = parseFeed(rss(
    rssItem({ title: "one", link: "https://d.example/1", guid: "a" }) +
    rssItem({ title: "one again", link: "https://d.example/1", guid: "b" }) +
    rssItem({ title: "same id", link: "https://d.example/2", guid: "a" }) +
    rssItem({ title: "distinct", link: "https://d.example/3", guid: "c" }),
  ));
  assert.deepEqual(items.map((i) => i.title), ["one", "distinct"]);
});

test("newest first, undated items last in their original order", () => {
  const items = parseFeed(rss(
    rssItem({ title: "undated-1", link: "https://o.example/u1" }) +
    rssItem({ title: "old", link: "https://o.example/old", date: "Mon, 01 Jan 2024 00:00:00 +0000" }) +
    rssItem({ title: "undated-2", link: "https://o.example/u2" }) +
    rssItem({ title: "new", link: "https://o.example/new", date: "Fri, 18 Sep 2026 00:00:00 +0000" }) +
    rssItem({ title: "bad-date", link: "https://o.example/bd", date: "not a date" }),
  ));
  assert.deepEqual(items.map((i) => i.title), ["new", "old", "undated-1", "undated-2", "bad-date"]);
});

test("output is capped", () => {
  let many = "";
  for (let i = 0; i < MAX_ITEMS + 25; i++) many += rssItem({ title: `n${i}`, link: `https://c.example/${i}` });
  assert.equal(parseFeed(rss(many)).length, MAX_ITEMS);
  assert.equal(MAX_ITEMS, 50);
});

test("relativeAge boundaries", () => {
  const now = Date.UTC(2026, 8, 18, 12);
  assert.equal(relativeAge(undefined, now), "");
  assert.equal(relativeAge(now, now), "now");
  assert.equal(relativeAge(now - 59_999, now), "now");
  assert.equal(relativeAge(now + 120_000, now), "now", "clock skew into the future reads as now");
  assert.equal(relativeAge(now - 60_000, now), "1m");
  assert.equal(relativeAge(now - 5 * 60_000, now), "5m");
  assert.equal(relativeAge(now - 3_599_999, now), "59m");
  assert.equal(relativeAge(now - 3_600_000, now), "1h");
  assert.equal(relativeAge(now - 3 * 3_600_000, now), "3h");
  assert.equal(relativeAge(now - 86_399_999, now), "23h");
  assert.equal(relativeAge(now - 86_400_000, now), "1d");
  assert.equal(relativeAge(now - 2 * 86_400_000, now), "2d");
});

test("every NEWS_SOURCES entry is https with a unique id, and there are enough to choose from", () => {
  assert.ok(NEWS_SOURCES.length >= 8);
  const ids = new Set();
  for (const s of NEWS_SOURCES) {
    assert.equal(new URL(s.url).protocol, "https:", s.url);
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(s.name && s.category);
  }
  assert.ok(new Set(NEWS_SOURCES.map((s) => s.category)).size >= 3, "spans several categories");
});
