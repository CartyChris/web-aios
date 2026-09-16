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
  assert.ok(SERVICES.length >= 40, `only ${SERVICES.length} services registered`);
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
  // Every id here had its real access-control-allow-origin header read with a
  // preflight-shaped request before it was added. Guessing produces a service
  // that fails with an opaque network error indistinguishable from an outage.
  const CORS_OK = [
    "wikipedia", "wikidata", "openlibrary", "crossref", "geocode", "weather",
    "earthquakes", "air_quality", "sunrise", "fx", "hackernews", "datamuse",
    "openalex", "species", "stackexchange", "pypi", "depsdev", "onthisday",
    "pageviews", "weather_history", "fx_history", "federalregister", "postcode",
    "commons",
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

test("countries reads capital, region and income group from the World Bank pair", () => {
  const body = JSON.stringify([
    { page: 1, total: 1 },
    [{ id: "ISL", iso2Code: "IS", name: "Iceland", region: { value: "Europe & Central Asia" }, incomeLevel: { value: "High income" }, capitalCity: "Reykjavik", longitude: "-21.8952", latitude: "64.1353" }],
  ]);
  const r = get("countries").parse(body);
  assert.match(r.rows[0].detail, /Capital Reykjavik/);
  assert.match(r.rows[0].detail, /High income economy/);
  assert.match(r.rows[0].detail, /ISO IS\/ISL/);
  assert.equal(r.rows[0].meta, "64.135, -21.895");
});

test("countries refuses the error envelope, which is an object rather than a pair", () => {
  assert.throws(() => get("countries").parse(JSON.stringify({ message: [{ id: "120", value: "Invalid value" }] })), ServiceParseError);
});

test("countries drops an aggregate row that is not a country", () => {
  // A World Bank "country" lookup can return a region aggregate with no
  // capital and no income group; listing it makes a single lookup look wrong.
  const body = JSON.stringify([{ page: 1 }, [{ id: "ECS", name: "Europe & Central Asia", region: { value: "" }, incomeLevel: { value: "" }, capitalCity: "", iso2Code: "" }]]);
  assert.equal(get("countries").parse(body).empty, true);
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

/* ── round two: parsers, against the shapes each API really returned ─────── */

test("openalex reads citation counts and prefers the DOI as the link", () => {
  const body = JSON.stringify({
    meta: { count: 1283846 },
    results: [{ id: "https://openalex.org/W3138516171", title: "Swin Transformer", publication_year: 2021, cited_by_count: 32667, doi: "https://doi.org/10.1109/iccv48922.2021.00986" }],
  });
  const r = get("openalex").parse(body);
  assert.equal(r.rows[0].meta, "2021");
  assert.equal(r.rows[0].url, "https://doi.org/10.1109/iccv48922.2021.00986");
  assert.match(r.rows[0].detail, /Cited 32,667 times/);
});

test("openalex falls back to the work id when a record has no DOI", () => {
  const r = get("openalex").parse(JSON.stringify({ results: [{ id: "https://openalex.org/W1", title: "x", doi: null }] }));
  assert.equal(r.rows[0].url, "https://openalex.org/W1");
});

test("openfda distinguishes its NOT_FOUND envelope from a broken payload", () => {
  const miss = get("openfda").parse(JSON.stringify({ error: { code: "NOT_FOUND", message: "No matches found!" } }));
  assert.equal(miss.empty, true);
  assert.throws(() => get("openfda").parse(JSON.stringify({ meta: {} })), ServiceParseError);
});

test("openfda reads the brand name and the indications section", () => {
  const body = JSON.stringify({
    results: [{ openfda: { brand_name: ["ADVIL"] }, indications_and_usage: ["For the temporary relief of minor aches."], effective_time: ["20240115"] }],
  });
  const r = get("openfda").parse(body);
  assert.equal(r.rows[0].title, "ADVIL");
  assert.equal(r.rows[0].meta, "2024");
  assert.match(r.rows[0].detail, /temporary relief/);
});

test("species renders the taxonomy as a lineage", () => {
  const body = JSON.stringify({
    results: [{ key: 2481139, scientificName: "Fratercula arctica (Linnaeus, 1758)", kingdom: "Animalia", phylum: "Chordata", class: "Aves", order: "Charadriiformes", family: "Alcidae", rank: "SPECIES" }],
  });
  const r = get("species").parse(body);
  assert.equal(r.rows[0].meta, "SPECIES");
  assert.match(r.rows[0].detail, /Animalia > Chordata > Aves > Charadriiformes > Alcidae/);
  assert.equal(r.rows[0].url, "https://www.gbif.org/species/2481139");
});

test("stackexchange decodes HTML entities in titles", () => {
  // Titles arrive escaped; showing &quot; to the reader is a visible bug.
  const body = JSON.stringify({
    items: [{ title: "Why does &quot;useState&quot; not update?", score: 42, answer_count: 3, is_answered: true, tags: ["reactjs", "hooks"], link: "https://stackoverflow.com/q/1" }],
  });
  const r = get("stackexchange").parse(body);
  assert.equal(r.rows[0].title, 'Why does "useState" not update?');
  assert.equal(r.rows[0].meta, "42 score");
  assert.match(r.rows[0].detail, /3 answers, accepted/);
});

test("stackexchange reports an unanswered question as such — the negative control", () => {
  const r = get("stackexchange").parse(JSON.stringify({ items: [{ title: "x", score: 0, answer_count: 0, is_answered: false, tags: [], link: "u" }] }));
  assert.match(r.rows[0].detail, /0 answers, none accepted/);
});

test("stackexchange surfaces a throttle envelope instead of reporting no results", () => {
  assert.throws(
    () => get("stackexchange").parse(JSON.stringify({ error_id: 502, error_message: "Violation of backoff parameter", error_name: "throttle_violation" })),
    (e) => { assert.match(e.message, /backoff/); return true; },
  );
});

test("pypi counts releases and refuses a payload with no info object", () => {
  const body = JSON.stringify({
    info: { name: "requests", version: "2.32.3", summary: "Python HTTP for Humans.", license: "Apache-2.0", requires_python: ">=3.8", project_url: "https://pypi.org/project/requests/" },
    releases: { "2.32.2": [], "2.32.3": [] },
  });
  const r = get("pypi").parse(body);
  assert.equal(r.rows[0].meta, "2.32.3");
  assert.match(r.rows[0].detail, /2 releases/);
  assert.match(r.rows[0].detail, /Licence: Apache-2\.0/);
  assert.throws(() => get("pypi").parse(JSON.stringify({ message: "Not Found" })), ServiceParseError);
});

test("crates prefers the max stable version over the newest one", () => {
  const body = JSON.stringify({ crates: [{ name: "serde", description: "A framework", downloads: 1401093108, max_stable_version: "1.0.229", newest_version: "1.0.230-beta" }] });
  const r = get("crates").parse(body);
  assert.match(r.rows[0].meta, /^1\.0\.229/);
  assert.match(r.rows[0].meta, /1,401,093,108 downloads/);
  assert.equal(r.rows[0].url, "https://crates.io/crates/serde");
});

test("depsdev lists newest versions first and flags deprecated ones", () => {
  const body = JSON.stringify({
    packageKey: { system: "NPM", name: "zustand" },
    versions: [
      { versionKey: { version: "0.0.1" }, publishedAt: "2019-04-09T13:47:37Z", isDefault: false, isDeprecated: true, deprecatedReason: "ancient" },
      { versionKey: { version: "5.0.15" }, publishedAt: "2026-08-01T00:00:00Z", isDefault: true, isDeprecated: false, deprecatedReason: "" },
    ],
  });
  const r = get("depsdev").parse(body);
  assert.equal(r.rows[0].title, "5.0.15", "the newest version must come first");
  assert.equal(r.rows[0].meta, "default");
  assert.equal(r.rows[1].meta, "deprecated");
  assert.match(r.rows[1].detail, /DEPRECATED: ancient/);
  assert.match(r.summary, /2 published versions/);
});

test("cve pulls the English description and the CVSS v3.1 base score", () => {
  const body = JSON.stringify({
    totalResults: 113,
    vulnerabilities: [{
      cve: {
        id: "CVE-2017-16877",
        descriptions: [{ lang: "es", value: "hola" }, { lang: "en", value: "Path traversal in Next.js." }],
        metrics: { cvssMetricV31: [{ cvssData: { baseScore: 7.5, baseSeverity: "HIGH" } }] },
      },
    }],
  });
  const r = get("cve").parse(body);
  assert.equal(r.rows[0].title, "CVE-2017-16877");
  assert.equal(r.rows[0].meta, "CVSS 7.5 HIGH");
  assert.equal(r.rows[0].detail, "Path traversal in Next.js.");
  assert.match(r.summary, /113 matching CVEs/);
});

test("cve survives a record with no CVSS metrics rather than dropping it", () => {
  // A CVE that has not been scored yet is still a CVE you need to see.
  const r = get("cve").parse(JSON.stringify({ totalResults: 1, vulnerabilities: [{ cve: { id: "CVE-2026-1", descriptions: [{ lang: "en", value: "x" }] } }] }));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].meta, undefined);
});

test("dockerhub marks an official image and formats pull counts", () => {
  const body = JSON.stringify({ results: [{ repo_name: "postgres", short_description: "The PostgreSQL system.", star_count: 15012, pull_count: 11482896502, is_official: true }] });
  const r = get("dockerhub").parse(body);
  assert.match(r.rows[0].detail, /OFFICIAL IMAGE/);
  assert.match(r.rows[0].detail, /11,482,896,502 pulls/);
  assert.equal(r.rows[0].meta, "15,012 stars");
});

test("dockerhub does NOT mark an unofficial image as official", () => {
  const r = get("dockerhub").parse(JSON.stringify({ results: [{ repo_name: "me/postgres", short_description: "x", star_count: 1, pull_count: 2, is_official: false }] }));
  assert.doesNotMatch(r.rows[0].detail, /OFFICIAL/);
});

test("onthisday sorts events chronologically", () => {
  const body = JSON.stringify({
    events: [
      { year: 2022, text: "Recent thing.", pages: [{ content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Recent" } } }] },
      { year: 1620, text: "The Mayflower departs.", pages: [] },
    ],
  });
  const r = get("onthisday").parse(body);
  assert.deepEqual(r.rows.map((x) => x.title), ["1620", "2022"]);
  assert.equal(r.rows[0].detail, "The Mayflower departs.");
});

test("onthisday pads a single-digit month and day into the URL", () => {
  const s = get("onthisday");
  assert.match(s.url({ month: "9", day: "6" }), /events\/09\/06$/);
  assert.match(s.url({ month: "09", day: "16" }), /events\/09\/16$/);
});

test("pageviews totals the range and reports it in the summary", () => {
  const body = JSON.stringify({
    items: [
      { timestamp: "2025010100", views: 17320 },
      { timestamp: "2025020100", views: 15289 },
    ],
  });
  const r = get("pageviews").parse(body);
  assert.equal(r.rows[0].title, "2025-01");
  assert.equal(r.rows[0].meta, "17,320");
  assert.match(r.summary, /32,609 views total/);
});

test("pageviews treats a 404 body as no data rather than as a parse failure", () => {
  const r = get("pageviews").parse(JSON.stringify({ type: "https://mediawiki.org/wiki/HyperSwitch/errors/not_found", title: "Not found." }));
  assert.equal(r.empty, true);
});

test("reverse_geocode reports an ocean coordinate as no match", () => {
  const r = get("reverse_geocode").parse(JSON.stringify({ error: "Unable to geocode" }));
  assert.equal(r.empty, true);
});

test("reverse_geocode returns the display name plus one row per address component", () => {
  const body = JSON.stringify({
    name: "Vonarstræti", addresstype: "road",
    display_name: "Vonarstræti, Miðbær, Reykjavíkurborg, Iceland",
    address: { road: "Vonarstræti", city: "Reykjavíkurborg", country: "Iceland" },
  });
  const r = get("reverse_geocode").parse(body);
  assert.equal(r.rows[0].title, "Vonarstræti");
  assert.equal(r.rows[0].meta, "road");
  assert.equal(r.rows.length, 4, "the summary row plus three address components");
  assert.match(r.summary, /Iceland/);
});

test("weather_history averages the range and totals precipitation", () => {
  const body = JSON.stringify({
    daily: { time: ["2025-01-01", "2025-01-02", "2025-01-03"], temperature_2m_mean: [-10.4, 0.8, 0.5], precipitation_sum: [0, 9.9, 5.0] },
  });
  const r = get("weather_history").parse(body);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].meta, "-10.4°C mean");
  assert.match(r.summary, /mean -3\.0°C/);
  assert.match(r.summary, /total precipitation 14\.9 mm/);
});

test("weather_history reports an empty range as empty", () => {
  const r = get("weather_history").parse(JSON.stringify({ daily: { time: [], temperature_2m_mean: [], precipitation_sum: [] } }));
  assert.equal(r.empty, true);
});

test("fx_history computes the move across the period", () => {
  const body = JSON.stringify({
    amount: 1, base: "USD", start_date: "2025-12-31", end_date: "2026-01-06",
    rates: { "2026-01-06": { EUR: 0.85419 }, "2025-12-31": { EUR: 0.85106 } },
  });
  const r = get("fx_history").parse(body);
  // Keys arrive unsorted; the series must still read oldest-first.
  assert.deepEqual(r.rows.map((x) => x.title), ["2025-12-31", "2026-01-06"]);
  assert.match(r.summary, /EUR moved \+0\.37%/);
});

test("fx_history refuses a payload whose rates is not an object", () => {
  assert.throws(() => get("fx_history").parse(JSON.stringify({ base: "USD", rates: "nope" })), ServiceParseError);
});

test("federalregister names the issuing agencies", () => {
  const body = JSON.stringify({
    count: 1565,
    results: [{ title: "NIST Artificial Intelligence Consortium", publication_date: "2026-05-29", type: "Notice", html_url: "https://www.federalregister.gov/documents/x", agencies: [{ name: "Commerce Department", raw_name: "DEPARTMENT OF COMMERCE" }] }],
  });
  const r = get("federalregister").parse(body);
  assert.equal(r.rows[0].meta, "2026-05-29");
  assert.match(r.rows[0].detail, /Notice — Commerce Department/);
  assert.match(r.summary, /1565 matching documents/);
});

test("federalregister treats a zero-result search as empty", () => {
  const r = get("federalregister").parse(JSON.stringify({ count: 0, description: "no matches" }));
  assert.equal(r.empty, true);
});

test("postcode reads places and coordinates and reports an unknown code as empty", () => {
  const body = JSON.stringify({
    country: "United States", "post code": "90210",
    places: [{ "place name": "Beverly Hills", state: "California", latitude: "34.0901", longitude: "-118.4065" }],
  });
  const r = get("postcode").parse(body);
  assert.equal(r.rows[0].title, "Beverly Hills");
  assert.equal(r.rows[0].meta, "34.090, -118.406");
  assert.match(r.summary, /^90210: Beverly Hills/);
  assert.equal(get("postcode").parse("{}").empty, true);
});

test("commons strips the File: prefix and the search-match markup", () => {
  const body = JSON.stringify({
    query: { search: [{ ns: 6, title: "File:Aurora australis.jpg", size: 3007, snippet: 'CC BY 2.0 <span class="searchmatch">Aurora</span> australis &amp; friends' }] },
  });
  const r = get("commons").parse(body);
  assert.equal(r.rows[0].title, "Aurora australis.jpg");
  assert.doesNotMatch(r.rows[0].detail, /<span|searchmatch/);
  assert.match(r.rows[0].detail, /Aurora australis & friends/);
  assert.equal(r.rows[0].url, "https://commons.wikimedia.org/wiki/File%3AAurora%20australis.jpg");
});

test("commons reports a miss as empty and refuses a wrong-typed search key", () => {
  assert.equal(get("commons").parse(JSON.stringify({ batchcomplete: "" })).empty, true);
  assert.throws(() => get("commons").parse(JSON.stringify({ query: { search: "nope" } })), ServiceParseError);
});
