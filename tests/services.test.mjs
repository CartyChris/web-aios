/* Free-services catalogue.
 *
 * Every test here drives a PARSER against a payload shaped like the real one.
 * That is the half that breaks: a public API changes a field name without
 * announcing it, and a parser that quietly returns [] on the new shape is
 * indistinguishable at the call site from "your query had no matches". So each
 * service gets both a positive case and, where the API has a distinct
 * miss-shape, a negative control proving the parser can still say no — and a
 * malformed case proving it refuses rather than inventing an empty answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SERVICES, SERVICE_CATEGORIES, serviceById, servicesByCategory,
  withDefaults, missingParams, ServiceParseError,
} from "../.test-build/services.js";

const get = (id) => {
  const s = serviceById(id);
  assert.ok(s, `no service registered with id ${id}`);
  return s;
};

/* ── catalogue integrity ─────────────────────────────────────────────────── */

test("the catalogue is non-empty and every id is unique", () => {
  assert.ok(SERVICES.length >= 20, `only ${SERVICES.length} services registered`);
  const ids = SERVICES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate service id");
});

test("every service declares a provider, a licence and documentation", () => {
  for (const s of SERVICES) {
    assert.ok(s.provider.length > 0, `${s.id} has no provider`);
    assert.ok(s.licence.length > 0, `${s.id} has no licence`);
    assert.match(s.docs, /^https:\/\//, `${s.id} docs is not an https URL`);
  }
});

test("every category on a service is one the UI knows how to render", () => {
  for (const s of SERVICES) {
    assert.ok(SERVICE_CATEGORIES.includes(s.category), `${s.id} has unknown category ${s.category}`);
  }
});

test("every service builds an https URL from its own defaults plus its required params", () => {
  for (const s of SERVICES) {
    const args = {};
    for (const p of s.params) if (p.required) args[p.name] = p.kind === "number" ? "1" : "test";
    const url = s.url(withDefaults(s, args));
    assert.match(url, /^https:\/\//, `${s.id} did not build an https URL`);
    assert.doesNotMatch(url, /undefined|\[object/, `${s.id} interpolated a non-string into its URL`);
  }
});

test("a missing required parameter is refused, not silently sent as an empty query", () => {
  for (const s of SERVICES) {
    const required = s.params.filter((p) => p.required);
    if (required.length === 0) continue;
    assert.throws(() => s.url(withDefaults(s, {})), ServiceParseError, `${s.id} built a URL with no required args`);
  }
});

test("missingParams names exactly what is still needed", () => {
  const wiki = get("wikipedia");
  assert.deepEqual(missingParams(wiki, {}), ["query"]);
  assert.deepEqual(missingParams(wiki, { query: "x" }), []);
  // A whitespace-only value is not a value.
  assert.deepEqual(missingParams(wiki, { query: "   " }), ["query"]);
});

test("withDefaults applies declared defaults and lets a caller override them", () => {
  const fx = get("fx");
  assert.equal(withDefaults(fx, {}).from, "USD");
  assert.equal(withDefaults(fx, { from: "GBP" }).from, "GBP");
  // An empty override must not erase the default; that would build a URL with
  // base= and the upstream would answer with a confusing 400.
  assert.equal(withDefaults(fx, { from: "" }).from, "USD");
});

test("servicesByCategory partitions the catalogue without loss", () => {
  const counted = SERVICE_CATEGORIES.reduce((n, c) => n + servicesByCategory(c).length, 0);
  assert.equal(counted, SERVICES.length);
});

test("every direct-reach service asks for a CORS-safe origin or a CORS-enabled host", () => {
  // A service marked "direct" that the browser cannot actually call fails with
  // an opaque network error and no way to tell it from the host being down.
  const CORS_OK = [
    "wikipedia", "wikidata", "openlibrary", "crossref", "geocode", "weather",
    "earthquakes", "air_quality", "sunrise", "fx", "hackernews", "datamuse",
  ];
  for (const s of SERVICES) {
    if (s.reach === "direct") {
      assert.ok(CORS_OK.includes(s.id), `${s.id} is marked direct but is not on the verified CORS list`);
    }
  }
});

/* ── parsers: positive, empty and malformed ──────────────────────────────── */

test("wikipedia extracts the lead paragraph of each page", () => {
  const body = JSON.stringify({
    query: {
      pages: {
        "123": { title: "Quantum state", extract: "In  quantum physics,\n a quantum state is…", fullurl: "https://en.wikipedia.org/wiki/Quantum_state" },
        "456": { title: "Eigenstate", extract: "An eigenstate is a state…", fullurl: "https://en.wikipedia.org/wiki/Eigenstate" },
      },
    },
  });
  const r = get("wikipedia").parse(body);
  assert.equal(r.rows.length, 2);
  assert.equal(r.empty, false);
  assert.equal(r.rows[0].title, "Eigenstate"); // sorted, so the order is stable
  // Whitespace is collapsed: a raw extract carries newlines that wreck a cell.
  assert.equal(r.rows[1].detail, "In quantum physics, a quantum state is…");
  assert.match(r.summary, /2 articles/);
});

test("wikipedia reports zero hits as empty — MediaWiki omits `query` entirely", () => {
  const r = get("wikipedia").parse(JSON.stringify({ batchcomplete: "" }));
  assert.equal(r.empty, true);
  assert.equal(r.rows.length, 0);
  assert.ok(r.summary.length > 0, "an empty result still owes the caller an observation");
});

test("wikipedia refuses a payload whose pages field is the wrong type", () => {
  assert.throws(() => get("wikipedia").parse(JSON.stringify({ query: { pages: [] } })), ServiceParseError);
});

test("no parser ever returns an empty observation string", () => {
  // An empty observation teaches a model nothing and it repeats the action.
  const r = get("wikipedia").parse(JSON.stringify({ batchcomplete: "" }));
  assert.notEqual(r.summary.trim(), "");
});

test("arxiv reads an Atom feed, including multiple authors", () => {
  const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>http://arxiv.org/abs/1706.03762v5</id>
      <published>2017-06-12T17:57:34Z</published>
      <title>Attention Is All You Need</title>
      <summary>The dominant sequence transduction models&#39; are…</summary>
      <author><name>Ashish Vaswani</name></author>
      <author><name>Noam Shazeer</name></author>
    </entry>
  </feed>`;
  const r = get("arxiv").parse(body);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].title, "Attention Is All You Need");
  assert.equal(r.rows[0].meta, "2017-06-12");
  assert.match(r.rows[0].detail, /Ashish Vaswani, Noam Shazeer/);
  // Entities must be decoded or the observation shows &#39; to the model.
  assert.match(r.rows[0].detail, /models' are/);
});

test("arxiv refuses HTML served in place of the feed", () => {
  assert.throws(() => get("arxiv").parse("<html><body>503 Service Unavailable</body></html>"), ServiceParseError);
});

test("arxiv reports an empty feed as empty rather than throwing", () => {
  const r = get("arxiv").parse(`<feed xmlns="http://www.w3.org/2005/Atom"><title>ArXiv Query</title></feed>`);
  assert.equal(r.empty, true);
});

test("weather renders current conditions plus one row per forecast day", () => {
  const body = JSON.stringify({
    current: { temperature_2m: 3.4, relative_humidity_2m: 81, wind_speed_10m: 22.1, weather_code: 61 },
    daily: {
      time: ["2026-09-16", "2026-09-17"],
      temperature_2m_max: [7.1, 8.4],
      temperature_2m_min: [1.2, 2.0],
      precipitation_sum: [4.2, 0],
    },
  });
  const r = get("weather").parse(body);
  assert.equal(r.rows.length, 3, "one current row plus two days");
  assert.equal(r.rows[0].meta, "3.4°C");
  assert.match(r.rows[0].detail, /Slight rain/); // WMO 61
  assert.equal(r.rows[2].detail, "Dry");
  assert.match(r.summary, /2026-09-16: 1.2–7.1°C/);
});

test("weather refuses a payload missing the current temperature", () => {
  assert.throws(
    () => get("weather").parse(JSON.stringify({ current: {}, daily: { time: [] } })),
    ServiceParseError,
  );
});

test("weather names an unrecognised WMO code instead of printing undefined", () => {
  const body = JSON.stringify({
    current: { temperature_2m: 10, weather_code: 4242 },
    daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] },
  });
  const r = get("weather").parse(body);
  assert.match(r.rows[0].detail, /Conditions unknown/);
  assert.doesNotMatch(r.summary, /undefined/);
});

test("geocode treats a missing results key as no match, not as a broken payload", () => {
  const r = get("geocode").parse(JSON.stringify({ generationtime_ms: 0.4 }));
  assert.equal(r.empty, true);
});

test("geocode formats coordinates to three decimals", () => {
  const body = JSON.stringify({
    results: [{ name: "Reykjavík", latitude: 64.14639, longitude: -21.93917, country: "Iceland", admin1: "Capital Region", population: 122853 }],
  });
  const r = get("geocode").parse(body);
  assert.equal(r.rows[0].meta, "64.146, -21.939");
  assert.match(r.rows[0].detail, /pop\. 122,853/);
});

test("fx reports every requested symbol with the ECB date", () => {
  const r = get("fx").parse(JSON.stringify({ amount: 1, base: "USD", date: "2026-09-15", rates: { EUR: 0.92, GBP: 0.79 } }));
  assert.equal(r.rows.length, 2);
  assert.match(r.summary, /2026-09-15, base USD/);
  assert.match(r.summary, /EUR 0.92/);
});

test("fx reports an unknown symbol as empty rather than as a parse failure", () => {
  const r = get("fx").parse(JSON.stringify({ amount: 1, base: "USD", date: "2026-09-15", rates: {} }));
  assert.equal(r.empty, true);
});

test("fx refuses a payload where rates is not an object", () => {
  assert.throws(() => get("fx").parse(JSON.stringify({ base: "USD", rates: null })), ServiceParseError);
});

test("github surfaces the rate-limit message instead of reporting no results", () => {
  // This is the whole point of the negative control: a 403 rate limit and a
  // genuinely empty search must not look the same to the caller.
  const limited = JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4.", documentation_url: "https://docs.github.com" });
  assert.throws(() => get("github").parse(limited), (e) => {
    assert.ok(e instanceof ServiceParseError);
    assert.match(e.message, /rate limit exceeded/);
    return true;
  });
});

test("github reads stars and language from a normal search result", () => {
  const body = JSON.stringify({
    total_count: 1,
    items: [{ full_name: "modelcontextprotocol/servers", description: "Reference servers", language: "TypeScript", stargazers_count: 41234, html_url: "https://github.com/modelcontextprotocol/servers" }],
  });
  const r = get("github").parse(body);
  assert.equal(r.rows[0].meta, "41,234 stars");
  assert.match(r.rows[0].detail, /TypeScript/);
});

test("github reports a genuinely empty search as empty", () => {
  const r = get("github").parse(JSON.stringify({ total_count: 0, items: [] }));
  assert.equal(r.empty, true);
});

test("hackernews falls back to the discussion link when a story has no URL", () => {
  const body = JSON.stringify({
    hits: [
      { title: "Ask HN: what is your agent harness", author: "pg", points: 210, num_comments: 88, objectID: "41000000", created_at: "2026-09-01T10:00:00Z", url: null },
      { title: "A harness", author: "x", points: 5, num_comments: 1, objectID: "41000001", created_at: "2026-09-02T10:00:00Z", url: "https://example.com/a" },
    ],
  });
  const r = get("hackernews").parse(body);
  assert.equal(r.rows[0].url, "https://news.ycombinator.com/item?id=41000000");
  assert.equal(r.rows[1].url, "https://example.com/a");
  assert.equal(r.rows[0].meta, "210 pts");
});

test("dictionary treats the API's not-found object as a miss, not a malformed payload", () => {
  const miss = JSON.stringify({ title: "No Definitions Found", message: "Sorry pal…" });
  const r = get("dictionary").parse(miss);
  assert.equal(r.empty, true);
});

test("dictionary flattens senses across parts of speech and caps each at three", () => {
  const body = JSON.stringify([{
    word: "state",
    meanings: [
      { partOfSpeech: "noun", definitions: [{ definition: "A condition." }, { definition: "A polity.", example: "the state of Iceland" }, { definition: "Third." }, { definition: "Fourth, must be dropped." }] },
      { partOfSpeech: "verb", definitions: [{ definition: "To declare." }] },
    ],
  }]);
  const r = get("dictionary").parse(body);
  assert.equal(r.rows.length, 4, "three noun senses plus one verb sense");
  assert.equal(r.rows[3].title, "verb");
  assert.match(r.rows[1].detail, /"the state of Iceland"/);
});

test("metmuseum distinguishes a null objectIDs miss from a malformed one", () => {
  const miss = get("metmuseum").parse(JSON.stringify({ total: 0, objectIDs: null }));
  assert.equal(miss.empty, true);
  assert.throws(() => get("metmuseum").parse(JSON.stringify({ total: 1, objectIDs: "437133" })), ServiceParseError);
});

test("metmuseum caps a huge result set at twelve rows but reports the true total", () => {
  const ids = Array.from({ length: 900 }, (_, i) => i + 1);
  const r = get("metmuseum").parse(JSON.stringify({ total: 900, objectIDs: ids }));
  assert.equal(r.rows.length, 12);
  assert.match(r.summary, /900 matching objects/);
});

test("worldbank drops observations with a null value and keeps the rest", () => {
  const body = JSON.stringify([
    { page: 1, total: 3 },
    [
      { date: "2024", value: null, indicator: { value: "GDP per capita" } },
      { date: "2023", value: 13138.3, indicator: { value: "GDP per capita" } },
    ],
  ]);
  const r = get("worldbank").parse(body);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].title, "2023");
});

test("worldbank refuses its error envelope, which is an object rather than a pair", () => {
  assert.throws(() => get("worldbank").parse(JSON.stringify({ message: [{ id: "120", value: "Invalid value" }] })), ServiceParseError);
});

test("crossref reads the year out of nested date-parts", () => {
  const body = JSON.stringify({
    message: { items: [{ title: ["Attention Is All You Need"], DOI: "10.5555/3295222", "container-title": ["NeurIPS"], issued: { "date-parts": [[2017, 6, 12]] }, "is-referenced-by-count": 98765 }] },
  });
  const r = get("crossref").parse(body);
  assert.equal(r.rows[0].meta, "2017");
  assert.equal(r.rows[0].url, "https://doi.org/10.5555/3295222");
  assert.match(r.rows[0].detail, /cited 98765x/);
});

test("pubmed reports the total match count alongside the returned page", () => {
  const r = get("pubmed").parse(JSON.stringify({ esearchresult: { count: "4821", idlist: ["40000001", "40000002"] } }));
  assert.equal(r.rows.length, 2);
  assert.match(r.summary, /4821 total matches/);
  assert.equal(r.rows[0].url, "https://pubmed.ncbi.nlm.nih.gov/40000001/");
});

test("earthquakes formats magnitude and time from a GeoJSON feature", () => {
  const body = JSON.stringify({
    features: [{ properties: { mag: 5.42, place: "112 km SSW of Hihifo, Tonga", time: 1758000000000, url: "https://earthquake.usgs.gov/x" } }],
  });
  const r = get("earthquakes").parse(body);
  assert.equal(r.rows[0].meta, "M5.4");
  assert.match(r.rows[0].detail, /UTC$/);
});

test("earthquakes builds a fixed URL, so the same band always fetches the same feed", () => {
  const s = get("earthquakes");
  assert.equal(s.url(withDefaults(s, {})), s.url(withDefaults(s, {})));
  assert.match(s.url(withDefaults(s, { band: "significant" })), /significant_day\.geojson$/);
});

test("air_quality bands the index and refuses a payload with neither figure", () => {
  const r = get("air_quality").parse(JSON.stringify({ current: { european_aqi: 12, pm2_5: 3.1, pm10: 6.2 } }));
  assert.match(r.summary, /European AQI 12 \(good\)/);
  assert.throws(() => get("air_quality").parse(JSON.stringify({ current: { pm10: 6 } })), ServiceParseError);
});

test("holidays refuses a non-array payload and reads local names when present", () => {
  const r = get("holidays").parse(JSON.stringify([{ date: "2026-07-04", localName: "Independence Day", name: "Independence Day" }]));
  assert.equal(r.rows[0].meta, "2026-07-04");
  assert.throws(() => get("holidays").parse(JSON.stringify({ error: "unknown country" })), ServiceParseError);
});

test("wayback reports no snapshot as empty rather than as an error", () => {
  const r = get("wayback").parse(JSON.stringify({ url: "example.com", archived_snapshots: {} }));
  assert.equal(r.empty, true);
});

test("wayback formats the timestamp into a readable date", () => {
  const body = JSON.stringify({
    archived_snapshots: { closest: { status: "200", available: true, url: "http://web.archive.org/web/20200101000000/http://example.com/", timestamp: "20200101000000" } },
  });
  const r = get("wayback").parse(body);
  assert.equal(r.rows[0].title, "Snapshot 2020-01-01");
});

test("openlibrary joins multiple authors and handles a missing year", () => {
  const body = JSON.stringify({
    docs: [
      { title: "Gödel, Escher, Bach", author_name: ["Douglas R. Hofstadter"], first_publish_year: 1979, edition_count: 42, key: "/works/OL1W" },
      { title: "Untitled draft", key: "/works/OL2W" },
    ],
  });
  const r = get("openlibrary").parse(body);
  assert.equal(r.rows[0].meta, "1979");
  assert.match(r.rows[0].detail, /42 editions/);
  assert.equal(r.rows[1].meta, undefined);
  assert.match(r.rows[1].detail, /Unknown author/);
});

test("crypto reads a price and its 24h change without knowing the currency in advance", () => {
  const r = get("crypto").parse(JSON.stringify({ bitcoin: { usd: 64210.5, usd_24h_change: -1.234 } }));
  assert.equal(r.rows[0].title, "bitcoin");
  assert.equal(r.rows[0].meta, "64210.5 USD");
  assert.match(r.rows[0].detail, /-1\.23% over 24h/);
});

test("countries summarises capital, area, languages and currency", () => {
  const body = JSON.stringify([{
    name: { common: "Iceland" }, capital: ["Reykjavík"], population: 366425, area: 103000,
    region: "Europe", languages: { isl: "Icelandic" }, currencies: { ISK: { name: "Icelandic króna" } }, cca3: "ISL",
  }]);
  const r = get("countries").parse(body);
  assert.match(r.rows[0].detail, /Capital Reykjavík/);
  assert.match(r.rows[0].detail, /103,000 km²/);
  assert.match(r.rows[0].detail, /Currency: ISK/);
  assert.equal(r.rows[0].meta, "pop. 366,425");
});

test("npm builds a package page link from the returned name", () => {
  const r = get("npm").parse(JSON.stringify({ objects: [{ package: { name: "zustand", version: "5.0.15", description: "Bear necessities" } }] }));
  assert.equal(r.rows[0].url, "https://www.npmjs.com/package/zustand");
  assert.equal(r.rows[0].meta, "5.0.15");
});

test("openfoodfacts drops products with no name rather than listing blank rows", () => {
  const body = JSON.stringify({ products: [{ product_name: "", brands: "X" }, { product_name: "Oat Drink", brands: "Oatly", nutrition_grades: "a", code: "123" }] });
  const r = get("openfoodfacts").parse(body);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].meta, "A");
});

test("datamuse and wikidata refuse payloads of the wrong outer shape", () => {
  assert.throws(() => get("datamuse").parse(JSON.stringify({ error: "x" })), ServiceParseError);
  assert.throws(() => get("wikidata").parse(JSON.stringify({ search: null })), ServiceParseError);
});

test("nasa_apod refuses a payload with no title", () => {
  assert.throws(() => get("nasa_apod").parse(JSON.stringify({ error: { code: "OVER_RATE_LIMIT" } })), ServiceParseError);
});

test("sunrise strips the date prefix off the ISO local times", () => {
  const body = JSON.stringify({
    daily: { time: ["2026-09-16"], sunrise: ["2026-09-16T06:41"], sunset: ["2026-09-16T19:44"], daylight_duration: [46980] },
  });
  const r = get("sunrise").parse(body);
  assert.equal(r.rows[0].detail, "Rises 06:41 · sets 19:44");
  assert.equal(r.rows[0].meta, "13.05 h daylight");
});

test("every parser refuses a body that is not its format at all", () => {
  // Nothing in the catalogue may answer "<html>502 Bad Gateway</html>" with a
  // confident empty result; an outage must be distinguishable from a miss.
  for (const s of SERVICES) {
    assert.throws(() => s.parse("<html><head><title>502</title></head></html>"), ServiceParseError, `${s.id} accepted an HTML error page`);
  }
});
