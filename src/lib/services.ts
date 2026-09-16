/* ────────────────────────────────────────────────────────────────────────────
   Free services — public APIs that need no key, no account and no billing.

   Every other network feature in this OS is gated behind a key the user has to
   go and get. That is the right default for a model provider and the wrong one
   for a fact: an OS that can do nothing at all until you paste a secret is an
   OS most people never see working. Everything in this file answers a real
   question on a cold install.

   The module is PURE, and deliberately so. A service is a URL builder plus a
   parser over whatever comes back, and neither half touches the network. That
   is what makes the catalogue testable against recorded payloads in Node — the
   parsers are where these break, because a public API changes its shape
   without telling anyone, and a parser that silently yields `[]` on a shape
   change is indistinguishable from "no results" at the call site. Every parser
   below therefore reports the difference.

   Terms: each entry names its provider and licence so attribution is a
   property of the catalogue rather than something a UI has to remember.
   ──────────────────────────────────────────────────────────────────────────── */

export type ServiceCategory =
  | "knowledge"
  | "science"
  | "earth"
  | "finance"
  | "dev"
  | "language"
  | "civic"
  | "media";

/** How the browser must reach it. Most public APIs send no CORS header, so the
 *  request never leaves the page — those go through /api/proxy. A handful do
 *  send `access-control-allow-origin: *` and can be called directly, which is
 *  one fewer hop and one fewer thing to be down. */
export type ServiceReach = "direct" | "proxy";

export interface ServiceParam {
  name: string;
  label: string;
  /** Shown in the field before anything is typed. */
  placeholder: string;
  required: boolean;
  kind: "text" | "number";
  default?: string;
}

export interface ServiceRow {
  /** Short enough for a table cell. */
  title: string;
  /** One or two lines. */
  detail: string;
  /** Opened when the row is clicked, when the service has a canonical page. */
  url?: string;
  /** Rendered to the right of the title: a date, a score, a price. */
  meta?: string;
}

export interface ServiceResult {
  rows: ServiceRow[];
  /** Free-text summary for an agent's observation. Never empty. */
  summary: string;
  /** Set when the payload parsed but said nothing — distinct from a parse
   *  failure, which throws. */
  empty: boolean;
}

export interface ServiceDef {
  id: string;
  name: string;
  category: ServiceCategory;
  /** One sentence. Goes into the harness tool description verbatim. */
  description: string;
  provider: string;
  /** Attribution the UI must show. */
  licence: string;
  docs: string;
  reach: ServiceReach;
  params: ServiceParam[];
  /** Pure. Throws on a missing required parameter. */
  url: (args: Record<string, string>) => string;
  /** Pure. Receives the decoded body. Throws on a shape it does not recognise
   *  — see the header: a parser that returns nothing on a changed shape is a
   *  silent outage. */
  parse: (body: string) => ServiceResult;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

export class ServiceParseError extends Error {
  constructor(serviceId: string, detail: string) {
    super(`${serviceId}: ${detail}`);
    this.name = "ServiceParseError";
  }
}

function need(args: Record<string, string>, key: string, id: string): string {
  const v = (args[key] ?? "").trim();
  if (!v) throw new ServiceParseError(id, `${key} is required`);
  return v;
}

function opt(args: Record<string, string>, key: string, fallback: string): string {
  const v = (args[key] ?? "").trim();
  return v || fallback;
}

function q(s: string): string {
  return encodeURIComponent(s);
}

/** Parse JSON with the service id in the failure, because "Unexpected token <"
 *  with no attribution is the least actionable error in this codebase. */
function asJson(id: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ServiceParseError(id, `response was not JSON (${body.slice(0, 80)}…)`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read `path.to.value` without asserting the whole payload's type. */
function dig(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function arrayAt(id: string, v: unknown, ...path: string[]): unknown[] {
  const found = dig(v, ...path);
  if (!Array.isArray(found)) {
    throw new ServiceParseError(id, `expected an array at ${path.join(".") || "(root)"}, got ${typeof found}`);
  }
  return found;
}

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Collapse whitespace and cut to a length a table cell can hold. */
function clean(s: string, max = 400): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function result(rows: ServiceRow[], summarise: (rows: ServiceRow[]) => string): ServiceResult {
  if (rows.length === 0) {
    return { rows, summary: "No results. Try a broader or differently spelled query.", empty: true };
  }
  return { rows, summary: summarise(rows), empty: false };
}

/** The default observation: a numbered list an agent can quote from. */
function listSummary(label: string) {
  return (rows: ServiceRow[]): string =>
    [`${rows.length} ${label}${rows.length === 1 ? "" : "s"}:`]
      .concat(rows.map((r, i) => `${i + 1}. ${r.title}${r.meta ? ` (${r.meta})` : ""} — ${r.detail}`))
      .join("\n");
}

/* ── XML, for the two services that still speak it ───────────────────────── */

/** Pull repeated `<tag>…</tag>` blocks out of a document.
 *
 *  Not a general XML parser and not pretending to be one: arXiv and the USGS
 *  both emit a flat, machine-generated feed with no mixed content and no
 *  namespaced collisions inside an entry, which this handles exactly. Anything
 *  richer should not be parsed with a regex and is not in this catalogue. */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

function tagText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(clean(stripTags(m[1] ?? ""))) : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ── the catalogue ───────────────────────────────────────────────────────── */

export const SERVICES: ServiceDef[] = [
  /* -- knowledge --------------------------------------------------------- */
  {
    id: "wikipedia",
    name: "Wikipedia",
    category: "knowledge",
    description: "Search Wikipedia and return the lead extract of each matching article.",
    provider: "Wikimedia Foundation",
    licence: "CC BY-SA 4.0",
    docs: "https://www.mediawiki.org/wiki/API:Search",
    reach: "direct",
    params: [
      { name: "query", label: "Query", placeholder: "eigenstate", required: true, kind: "text" },
      { name: "limit", label: "Results", placeholder: "5", required: false, kind: "number", default: "5" },
    ],
    url: (a) =>
      `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=${q(opt(a, "limit", "5"))}` +
      `&gsrsearch=${q(need(a, "query", "wikipedia"))}&prop=extracts|info&exintro=1&explaintext=1&inprop=url`,
    parse: (body) => {
      const json = asJson("wikipedia", body);
      const pages = dig(json, "query", "pages");
      // No `query` key at all is how the MediaWiki API reports zero hits —
      // that is empty, not malformed.
      if (pages === undefined) return result([], listSummary("article"));
      if (!isRecord(pages)) throw new ServiceParseError("wikipedia", "query.pages was not an object");
      const rows = Object.values(pages)
        .map((p): ServiceRow => ({
          title: str(dig(p, "title"), "(untitled)"),
          detail: clean(str(dig(p, "extract"), "No extract available.")),
          url: str(dig(p, "fullurl")) || undefined,
          meta: undefined,
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
      return result(rows, listSummary("article"));
    },
  },
  {
    id: "wikidata",
    name: "Wikidata",
    category: "knowledge",
    description: "Look up structured entities on Wikidata by name and return their identifiers.",
    provider: "Wikimedia Foundation",
    licence: "CC0 1.0",
    docs: "https://www.wikidata.org/w/api.php",
    reach: "direct",
    params: [{ name: "query", label: "Entity", placeholder: "Ada Lovelace", required: true, kind: "text" }],
    url: (a) =>
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&origin=*&language=en&limit=10&search=${q(need(a, "query", "wikidata"))}`,
    parse: (body) => {
      const json = asJson("wikidata", body);
      const rows = arrayAt("wikidata", json, "search").map((e): ServiceRow => ({
        title: str(dig(e, "label"), "(no label)"),
        detail: clean(str(dig(e, "description"), "No description.")),
        url: str(dig(e, "concepturi")) || undefined,
        meta: str(dig(e, "id")) || undefined,
      }));
      return result(rows, listSummary("entity"));
    },
  },
  {
    id: "openlibrary",
    name: "Open Library",
    category: "knowledge",
    description: "Search books by title or author and return edition counts and first publication years.",
    provider: "Internet Archive",
    licence: "Open Data (ODbL)",
    docs: "https://openlibrary.org/dev/docs/api/search",
    reach: "direct",
    params: [
      { name: "query", label: "Title or author", placeholder: "gödel escher bach", required: true, kind: "text" },
      { name: "limit", label: "Results", placeholder: "8", required: false, kind: "number", default: "8" },
    ],
    url: (a) =>
      `https://openlibrary.org/search.json?q=${q(need(a, "query", "openlibrary"))}&limit=${q(opt(a, "limit", "8"))}` +
      `&fields=title,author_name,first_publish_year,edition_count,key`,
    parse: (body) => {
      const json = asJson("openlibrary", body);
      const rows = arrayAt("openlibrary", json, "docs").map((d): ServiceRow => {
        const authors = dig(d, "author_name");
        const by = Array.isArray(authors) && authors.length > 0 ? authors.map((x) => str(x)).join(", ") : "Unknown author";
        const year = num(dig(d, "first_publish_year"));
        const editions = num(dig(d, "edition_count"));
        const key = str(dig(d, "key"));
        return {
          title: str(dig(d, "title"), "(untitled)"),
          detail: `${by}${editions !== undefined ? ` · ${editions} edition${editions === 1 ? "" : "s"}` : ""}`,
          url: key ? `https://openlibrary.org${key}` : undefined,
          meta: year !== undefined ? String(year) : undefined,
        };
      });
      return result(rows, listSummary("book"));
    },
  },

  /* -- science ----------------------------------------------------------- */
  {
    id: "arxiv",
    name: "arXiv",
    category: "science",
    description: "Search arXiv preprints and return title, authors, date and abstract.",
    provider: "Cornell University",
    licence: "arXiv Terms of Use",
    docs: "https://info.arxiv.org/help/api/user-manual.html",
    reach: "proxy",
    params: [
      { name: "query", label: "Query", placeholder: "sparse autoencoder interpretability", required: true, kind: "text" },
      { name: "limit", label: "Results", placeholder: "8", required: false, kind: "number", default: "8" },
    ],
    url: (a) =>
      `https://export.arxiv.org/api/query?search_query=all:${q(need(a, "query", "arxiv"))}` +
      `&start=0&max_results=${q(opt(a, "limit", "8"))}&sortBy=relevance&sortOrder=descending`,
    parse: (body) => {
      if (!body.includes("<feed")) throw new ServiceParseError("arxiv", "response was not an Atom feed");
      const rows = blocks(body, "entry").map((e): ServiceRow => {
        const authors = blocks(e, "author").map((au) => tagText(au, "name")).filter(Boolean);
        const id = tagText(e, "id");
        return {
          title: clean(tagText(e, "title"), 200),
          detail: clean(`${authors.slice(0, 4).join(", ")}${authors.length > 4 ? " et al." : ""} — ${tagText(e, "summary")}`),
          url: id || undefined,
          meta: tagText(e, "published").slice(0, 10) || undefined,
        };
      });
      return result(rows, listSummary("preprint"));
    },
  },
  {
    id: "crossref",
    name: "Crossref",
    category: "science",
    description: "Search the Crossref index of published works and return DOIs, journals and citation counts.",
    provider: "Crossref",
    licence: "CC0 1.0 (metadata)",
    docs: "https://api.crossref.org",
    reach: "direct",
    params: [
      { name: "query", label: "Query", placeholder: "attention is all you need", required: true, kind: "text" },
      { name: "limit", label: "Results", placeholder: "8", required: false, kind: "number", default: "8" },
    ],
    url: (a) => `https://api.crossref.org/works?query=${q(need(a, "query", "crossref"))}&rows=${q(opt(a, "limit", "8"))}&select=title,author,DOI,issued,container-title,is-referenced-by-count`,
    parse: (body) => {
      const json = asJson("crossref", body);
      const rows = arrayAt("crossref", json, "message", "items").map((w): ServiceRow => {
        const titles = dig(w, "title");
        const title = Array.isArray(titles) && titles.length > 0 ? str(titles[0]) : "(untitled)";
        const container = dig(w, "container-title");
        const journal = Array.isArray(container) && container.length > 0 ? str(container[0]) : "";
        const parts = dig(w, "issued", "date-parts");
        const year = Array.isArray(parts) && Array.isArray(parts[0]) ? num(parts[0][0]) : undefined;
        const cites = num(dig(w, "is-referenced-by-count"));
        const doi = str(dig(w, "DOI"));
        return {
          title: clean(title, 200),
          detail: clean([journal, cites !== undefined ? `cited ${cites}x` : "", doi].filter(Boolean).join(" · ")),
          url: doi ? `https://doi.org/${doi}` : undefined,
          meta: year !== undefined ? String(year) : undefined,
        };
      });
      return result(rows, listSummary("work"));
    },
  },
  {
    id: "pubmed",
    name: "PubMed",
    category: "science",
    description: "Search the PubMed biomedical literature index and return matching article identifiers.",
    provider: "US National Library of Medicine",
    licence: "Public domain (metadata)",
    docs: "https://www.ncbi.nlm.nih.gov/books/NBK25501/",
    reach: "proxy",
    params: [
      { name: "query", label: "Query", placeholder: "crispr off-target", required: true, kind: "text" },
      { name: "limit", label: "Results", placeholder: "10", required: false, kind: "number", default: "10" },
    ],
    url: (a) =>
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${q(opt(a, "limit", "10"))}&term=${q(need(a, "query", "pubmed"))}`,
    parse: (body) => {
      const json = asJson("pubmed", body);
      const ids = arrayAt("pubmed", json, "esearchresult", "idlist").map((x) => str(x)).filter(Boolean);
      const total = num(dig(json, "esearchresult", "count"));
      const rows = ids.map((id): ServiceRow => ({
        title: `PMID ${id}`,
        detail: "Open on PubMed for the abstract and full record.",
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      }));
      if (rows.length === 0) return result([], listSummary("article"));
      return {
        rows,
        summary: `${total ?? rows.length} total match${total === 1 ? "" : "es"}; ${rows.length} returned: ${ids.join(", ")}`,
        empty: false,
      };
    },
  },
  {
    id: "nasa_apod",
    name: "NASA Picture of the Day",
    category: "science",
    description: "Return NASA's astronomy picture of the day with its explanation.",
    provider: "NASA",
    licence: "Public domain (most images)",
    docs: "https://api.nasa.gov",
    reach: "proxy",
    params: [{ name: "date", label: "Date", placeholder: "YYYY-MM-DD (blank = today)", required: false, kind: "text" }],
    url: (a) => {
      const d = opt(a, "date", "");
      // DEMO_KEY is NASA's documented no-signup key. Rate-limited, not secret.
      return `https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY${d ? `&date=${q(d)}` : ""}`;
    },
    parse: (body) => {
      const json = asJson("nasa_apod", body);
      const title = str(dig(json, "title"));
      if (!title) throw new ServiceParseError("nasa_apod", "payload carried no title");
      return {
        rows: [{
          title,
          detail: clean(str(dig(json, "explanation")), 900),
          url: str(dig(json, "hdurl")) || str(dig(json, "url")) || undefined,
          meta: str(dig(json, "date")) || undefined,
        }],
        summary: `${title} (${str(dig(json, "date"))}) — ${clean(str(dig(json, "explanation")), 600)}`,
        empty: false,
      };
    },
  },

  /* -- earth ------------------------------------------------------------- */
  {
    id: "geocode",
    name: "Geocoding",
    category: "earth",
    description: "Turn a place name into coordinates, country and population.",
    provider: "Open-Meteo",
    licence: "CC BY 4.0",
    docs: "https://open-meteo.com/en/docs/geocoding-api",
    reach: "direct",
    params: [{ name: "place", label: "Place", placeholder: "Reykjavík", required: true, kind: "text" }],
    url: (a) => `https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${q(need(a, "place", "geocode"))}`,
    parse: (body) => {
      const json = asJson("geocode", body);
      // Open-Meteo omits `results` entirely rather than sending []. That is a
      // miss, not a broken payload.
      if (dig(json, "results") === undefined) return result([], listSummary("place"));
      const rows = arrayAt("geocode", json, "results").map((r): ServiceRow => {
        const lat = num(dig(r, "latitude"));
        const lon = num(dig(r, "longitude"));
        const pop = num(dig(r, "population"));
        return {
          title: str(dig(r, "name"), "(unnamed)"),
          detail: clean([str(dig(r, "admin1")), str(dig(r, "country")), pop !== undefined ? `pop. ${pop.toLocaleString("en-US")}` : ""].filter(Boolean).join(", ")),
          meta: lat !== undefined && lon !== undefined ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : undefined,
        };
      });
      return result(rows, listSummary("place"));
    },
  },
  {
    id: "weather",
    name: "Weather",
    category: "earth",
    description: "Return the current weather and a seven-day forecast for a latitude and longitude.",
    provider: "Open-Meteo",
    licence: "CC BY 4.0",
    docs: "https://open-meteo.com/en/docs",
    reach: "direct",
    params: [
      { name: "latitude", label: "Latitude", placeholder: "64.146", required: true, kind: "number" },
      { name: "longitude", label: "Longitude", placeholder: "-21.94", required: true, kind: "number" },
    ],
    url: (a) =>
      `https://api.open-meteo.com/v1/forecast?latitude=${q(need(a, "latitude", "weather"))}&longitude=${q(need(a, "longitude", "weather"))}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=7`,
    parse: (body) => {
      const json = asJson("weather", body);
      const nowT = num(dig(json, "current", "temperature_2m"));
      if (nowT === undefined) throw new ServiceParseError("weather", "current.temperature_2m missing");
      const wind = num(dig(json, "current", "wind_speed_10m"));
      const rh = num(dig(json, "current", "relative_humidity_2m"));
      const code = num(dig(json, "current", "weather_code"));
      const days = arrayAt("weather", json, "daily", "time").map((x) => str(x));
      const hi = arrayAt("weather", json, "daily", "temperature_2m_max");
      const lo = arrayAt("weather", json, "daily", "temperature_2m_min");
      const rain = arrayAt("weather", json, "daily", "precipitation_sum");

      const rows: ServiceRow[] = [{
        title: "Now",
        detail: `${WMO[code ?? -1] ?? "Conditions unknown"}${rh !== undefined ? ` · ${rh}% humidity` : ""}${wind !== undefined ? ` · wind ${wind} km/h` : ""}`,
        meta: `${nowT}°C`,
      }];
      for (let i = 0; i < days.length; i++) {
        const h = num(hi[i]);
        const l = num(lo[i]);
        const p = num(rain[i]);
        rows.push({
          title: days[i] ?? `Day ${i + 1}`,
          detail: p !== undefined && p > 0 ? `${p} mm precipitation` : "Dry",
          meta: h !== undefined && l !== undefined ? `${l}° to ${h}°C` : undefined,
        });
      }
      return {
        rows,
        summary: `Currently ${nowT}°C, ${WMO[code ?? -1] ?? "conditions unknown"}. ` +
          days.map((d, i) => `${d}: ${num(lo[i])}–${num(hi[i])}°C`).join("; "),
        empty: false,
      };
    },
  },
  {
    id: "earthquakes",
    name: "Earthquakes",
    category: "earth",
    description: "List earthquakes above a given magnitude recorded worldwide in the last day.",
    provider: "US Geological Survey",
    licence: "Public domain",
    docs: "https://earthquake.usgs.gov/fdsnws/event/1/",
    reach: "direct",
    params: [{ name: "band", label: "Magnitude band", placeholder: "significant, 4.5, 2.5, 1.0 or all", required: false, kind: "text", default: "4.5" }],
    // The pre-built summary feed, not the fdsnws query endpoint: the query
    // form needs a start date, which would mean calling Date.now() inside a
    // URL builder and giving up a deterministic test for no gain.
    url: (a) => `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${q(opt(a, "band", "4.5"))}_day.geojson`,
    parse: (body) => {
      const json = asJson("earthquakes", body);
      const rows = arrayAt("earthquakes", json, "features").map((f): ServiceRow => {
        const mag = num(dig(f, "properties", "mag"));
        const time = num(dig(f, "properties", "time"));
        return {
          title: str(dig(f, "properties", "place"), "(location unknown)"),
          detail: time !== undefined ? new Date(time).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "Time unknown",
          url: str(dig(f, "properties", "url")) || undefined,
          meta: mag !== undefined ? `M${mag.toFixed(1)}` : undefined,
        };
      });
      return result(rows, listSummary("earthquake"));
    },
  },
  {
    id: "air_quality",
    name: "Air Quality",
    category: "earth",
    description: "Return current particulate levels and the European air quality index at a coordinate.",
    provider: "Open-Meteo",
    licence: "CC BY 4.0",
    docs: "https://open-meteo.com/en/docs/air-quality-api",
    reach: "direct",
    params: [
      { name: "latitude", label: "Latitude", placeholder: "51.51", required: true, kind: "number" },
      { name: "longitude", label: "Longitude", placeholder: "-0.13", required: true, kind: "number" },
    ],
    url: (a) =>
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${q(need(a, "latitude", "air_quality"))}` +
      `&longitude=${q(need(a, "longitude", "air_quality"))}&current=pm10,pm2_5,european_aqi&timezone=auto`,
    parse: (body) => {
      const json = asJson("air_quality", body);
      const aqi = num(dig(json, "current", "european_aqi"));
      const pm25 = num(dig(json, "current", "pm2_5"));
      const pm10 = num(dig(json, "current", "pm10"));
      if (aqi === undefined && pm25 === undefined) {
        throw new ServiceParseError("air_quality", "no european_aqi and no pm2_5 in current");
      }
      const band = aqi === undefined ? "unknown" : aqi <= 20 ? "good" : aqi <= 40 ? "fair" : aqi <= 60 ? "moderate" : aqi <= 80 ? "poor" : "very poor";
      const rows: ServiceRow[] = [
        { title: "European AQI", detail: `Band: ${band}`, meta: aqi !== undefined ? String(aqi) : "n/a" },
        { title: "PM2.5", detail: "Fine particulate matter", meta: pm25 !== undefined ? `${pm25} µg/m³` : "n/a" },
        { title: "PM10", detail: "Coarse particulate matter", meta: pm10 !== undefined ? `${pm10} µg/m³` : "n/a" },
      ];
      return { rows, summary: `European AQI ${aqi ?? "n/a"} (${band}); PM2.5 ${pm25 ?? "n/a"} µg/m³; PM10 ${pm10 ?? "n/a"} µg/m³.`, empty: false };
    },
  },
  {
    id: "sunrise",
    name: "Sun Times",
    category: "earth",
    description: "Return sunrise, sunset and daylight duration for a coordinate and date.",
    provider: "Open-Meteo",
    licence: "CC BY 4.0",
    docs: "https://open-meteo.com/en/docs",
    reach: "direct",
    params: [
      { name: "latitude", label: "Latitude", placeholder: "64.146", required: true, kind: "number" },
      { name: "longitude", label: "Longitude", placeholder: "-21.94", required: true, kind: "number" },
    ],
    url: (a) =>
      `https://api.open-meteo.com/v1/forecast?latitude=${q(need(a, "latitude", "sunrise"))}&longitude=${q(need(a, "longitude", "sunrise"))}` +
      `&daily=sunrise,sunset,daylight_duration&timezone=auto&forecast_days=3`,
    parse: (body) => {
      const json = asJson("sunrise", body);
      const days = arrayAt("sunrise", json, "daily", "time").map((x) => str(x));
      const up = arrayAt("sunrise", json, "daily", "sunrise").map((x) => str(x));
      const down = arrayAt("sunrise", json, "daily", "sunset").map((x) => str(x));
      const dur = arrayAt("sunrise", json, "daily", "daylight_duration");
      const rows = days.map((d, i): ServiceRow => {
        const seconds = num(dur[i]);
        const hours = seconds !== undefined ? (seconds / 3600).toFixed(2) : undefined;
        return {
          title: d,
          detail: `Rises ${(up[i] ?? "").slice(11)} · sets ${(down[i] ?? "").slice(11)}`,
          meta: hours ? `${hours} h daylight` : undefined,
        };
      });
      return result(rows, listSummary("day"));
    },
  },

  /* -- finance ----------------------------------------------------------- */
  {
    id: "fx",
    name: "Exchange Rates",
    category: "finance",
    description: "Convert between currencies at the European Central Bank reference rate.",
    provider: "Frankfurter (ECB data)",
    licence: "Public data, free API",
    docs: "https://frankfurter.dev",
    reach: "direct",
    params: [
      { name: "from", label: "From", placeholder: "USD", required: false, kind: "text", default: "USD" },
      { name: "to", label: "To", placeholder: "EUR,GBP,JPY", required: false, kind: "text", default: "EUR,GBP,JPY" },
      { name: "amount", label: "Amount", placeholder: "1", required: false, kind: "number", default: "1" },
    ],
    url: (a) =>
      `https://api.frankfurter.dev/v1/latest?base=${q(opt(a, "from", "USD").toUpperCase())}` +
      `&symbols=${q(opt(a, "to", "EUR,GBP,JPY").toUpperCase())}&amount=${q(opt(a, "amount", "1"))}`,
    parse: (body) => {
      const json = asJson("fx", body);
      const base = str(dig(json, "base"));
      const date = str(dig(json, "date"));
      const rates = dig(json, "rates");
      if (!isRecord(rates)) throw new ServiceParseError("fx", "rates was not an object");
      const rows = Object.entries(rates).map(([code, v]): ServiceRow => ({
        title: code,
        detail: `Reference rate against ${base}`,
        meta: String(num(v) ?? v),
      }));
      return {
        rows,
        summary: rows.length === 0
          ? "No rates returned for those symbols."
          : `ECB rates on ${date}, base ${base}: ${rows.map((r) => `${r.title} ${r.meta}`).join(", ")}`,
        empty: rows.length === 0,
      };
    },
  },
  {
    id: "crypto",
    name: "Crypto Prices",
    category: "finance",
    description: "Return the current price and 24-hour change of named cryptocurrencies.",
    provider: "CoinGecko",
    licence: "Free tier, attribution required",
    docs: "https://docs.coingecko.com/reference/simple-price",
    reach: "proxy",
    params: [
      { name: "ids", label: "Coins", placeholder: "bitcoin,ethereum", required: false, kind: "text", default: "bitcoin,ethereum" },
      { name: "vs", label: "Against", placeholder: "usd", required: false, kind: "text", default: "usd" },
    ],
    url: (a) =>
      `https://api.coingecko.com/api/v3/simple/price?ids=${q(opt(a, "ids", "bitcoin,ethereum"))}` +
      `&vs_currencies=${q(opt(a, "vs", "usd"))}&include_24hr_change=true`,
    parse: (body) => {
      const json = asJson("crypto", body);
      if (!isRecord(json)) throw new ServiceParseError("crypto", "payload was not an object");
      const rows: ServiceRow[] = [];
      for (const [coin, v] of Object.entries(json)) {
        if (!isRecord(v)) continue;
        const priceKey = Object.keys(v).find((k) => !k.endsWith("_24h_change"));
        const price = priceKey ? num(v[priceKey]) : undefined;
        const change = num(v[`${priceKey}_24h_change`]);
        rows.push({
          title: coin,
          detail: change !== undefined ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}% over 24h` : "24h change unavailable",
          meta: price !== undefined ? `${price} ${priceKey?.toUpperCase() ?? ""}`.trim() : undefined,
        });
      }
      return result(rows, listSummary("coin"));
    },
  },
  {
    id: "worldbank",
    name: "World Bank",
    category: "finance",
    description: "Return a World Bank development indicator over time for one country.",
    provider: "The World Bank",
    licence: "CC BY 4.0",
    docs: "https://datahelpdesk.worldbank.org/knowledgebase/articles/889392",
    reach: "proxy",
    params: [
      { name: "country", label: "Country (ISO-3)", placeholder: "ISL", required: false, kind: "text", default: "WLD" },
      { name: "indicator", label: "Indicator", placeholder: "NY.GDP.PCAP.CD", required: false, kind: "text", default: "NY.GDP.PCAP.CD" },
    ],
    url: (a) =>
      `https://api.worldbank.org/v2/country/${q(opt(a, "country", "WLD"))}/indicator/${q(opt(a, "indicator", "NY.GDP.PCAP.CD"))}?format=json&per_page=15`,
    parse: (body) => {
      const json = asJson("worldbank", body);
      // The World Bank always wraps its answer in [meta, data]. A bare object
      // is its error envelope.
      if (!Array.isArray(json)) throw new ServiceParseError("worldbank", "expected a [meta, data] pair");
      const data = json[1];
      if (!Array.isArray(data)) return result([], listSummary("observation"));
      const rows = data
        .filter((d) => num(dig(d, "value")) !== undefined)
        .map((d): ServiceRow => ({
          title: str(dig(d, "date")),
          detail: str(dig(d, "indicator", "value"), "Indicator"),
          meta: String(num(dig(d, "value"))),
        }));
      return result(rows, listSummary("observation"));
    },
  },
  {
    id: "countries",
    name: "Country Facts",
    // Was REST Countries until 2026-09-16, when a live probe found that every
    // version of that API — v3.1 AND the v5 it tells you to migrate to — now
    // answers with a deprecation envelope instead of data. The recorded-payload
    // test still passed, because a parser cannot tell that the shape it was
    // taught is no longer the shape anyone sends. Only calling it could.
    //
    // The World Bank is keyless, stable and public-domain. It carries a
    // narrower fact set: capital, region, income group and coordinates, but no
    // population, languages or currencies. `geocode` resolves a place NAME to
    // a country and a population, which is the gap this leaves.
    category: "civic",
    description: "Return the capital, region, income group and coordinates of a country by its ISO code.",
    provider: "The World Bank",
    licence: "CC BY 4.0",
    docs: "https://datahelpdesk.worldbank.org/knowledgebase/articles/898590",
    reach: "proxy",
    params: [{ name: "country", label: "Country (ISO-2 or ISO-3)", placeholder: "ISL", required: true, kind: "text" }],
    url: (a) => `https://api.worldbank.org/v2/country/${q(need(a, "country", "countries"))}?format=json`,
    parse: (body) => {
      const json = asJson("countries", body);
      // Always [meta, data]. A bare object is the error envelope.
      if (!Array.isArray(json)) throw new ServiceParseError("countries", "expected a [meta, data] pair");
      const data = json[1];
      if (!Array.isArray(data)) return result([], listSummary("country"));
      const rows = data.map((c): ServiceRow => {
        const lat = num(dig(c, "latitude"));
        const lon = num(dig(c, "longitude"));
        return {
          title: str(dig(c, "name"), "(unnamed)"),
          detail: clean([
            str(dig(c, "capitalCity")) ? `Capital ${str(dig(c, "capitalCity"))}` : "",
            str(dig(c, "region", "value")),
            str(dig(c, "incomeLevel", "value")) ? `${str(dig(c, "incomeLevel", "value"))} economy` : "",
            str(dig(c, "iso2Code")) ? `ISO ${str(dig(c, "iso2Code"))}/${str(dig(c, "id"))}` : "",
          ].filter(Boolean).join(" · ")) || "No detail returned.",
          meta: lat !== undefined && lon !== undefined ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : undefined,
        };
      // An aggregate row ("Europe & Central Asia") has no region of its own and
      // is not a country; including it makes a one-country lookup look wrong.
      }).filter((r) => r.detail !== "No detail returned.");
      return result(rows, listSummary("country"));
    },
  },

  /* -- civic ------------------------------------------------------------- */
  {
    id: "holidays",
    name: "Public Holidays",
    category: "civic",
    description: "List the public holidays of a country for a year.",
    provider: "Nager.Date",
    licence: "MIT",
    docs: "https://date.nager.at/Api",
    reach: "proxy",
    params: [
      { name: "country", label: "Country (ISO-2)", placeholder: "US", required: false, kind: "text", default: "US" },
      { name: "year", label: "Year", placeholder: "2026", required: false, kind: "number", default: "2026" },
    ],
    url: (a) => `https://date.nager.at/api/v3/PublicHolidays/${q(opt(a, "year", "2026"))}/${q(opt(a, "country", "US").toUpperCase())}`,
    parse: (body) => {
      const json = asJson("holidays", body);
      if (!Array.isArray(json)) throw new ServiceParseError("holidays", "expected an array of holidays");
      const rows = json.map((h): ServiceRow => ({
        title: str(dig(h, "localName"), str(dig(h, "name"), "(unnamed)")),
        detail: str(dig(h, "name"), ""),
        meta: str(dig(h, "date")),
      }));
      return result(rows, listSummary("holiday"));
    },
  },
  {
    id: "wayback",
    name: "Wayback Machine",
    category: "civic",
    description: "Find the nearest archived snapshot of a URL in the Internet Archive.",
    provider: "Internet Archive",
    licence: "Free public service",
    docs: "https://archive.org/help/wayback_api.php",
    reach: "proxy",
    params: [
      { name: "url", label: "URL", placeholder: "example.com", required: true, kind: "text" },
      { name: "timestamp", label: "Near (YYYYMMDD)", placeholder: "20200101", required: false, kind: "text" },
    ],
    url: (a) => {
      const ts = opt(a, "timestamp", "");
      return `https://archive.org/wayback/available?url=${q(need(a, "url", "wayback"))}${ts ? `&timestamp=${q(ts)}` : ""}`;
    },
    parse: (body) => {
      const json = asJson("wayback", body);
      const snap = dig(json, "archived_snapshots", "closest");
      if (!isRecord(snap)) return result([], listSummary("snapshot"));
      const ts = str(snap.timestamp);
      return {
        rows: [{
          title: `Snapshot ${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
          detail: `HTTP ${str(snap.status, "?")} · ${snap.available === true ? "available" : "unavailable"}`,
          url: str(snap.url) || undefined,
          meta: ts || undefined,
        }],
        summary: `Closest snapshot ${ts} — ${str(snap.url)}`,
        empty: false,
      };
    },
  },

  /* -- dev --------------------------------------------------------------- */
  {
    id: "hackernews",
    name: "Hacker News",
    category: "dev",
    description: "Search Hacker News stories and comments by relevance or date.",
    provider: "Algolia for Y Combinator",
    licence: "Free public API",
    docs: "https://hn.algolia.com/api",
    reach: "direct",
    params: [
      { name: "query", label: "Query", placeholder: "agent harness", required: true, kind: "text" },
      { name: "sort", label: "Sort", placeholder: "relevance or date", required: false, kind: "text", default: "relevance" },
    ],
    url: (a) => {
      const path = opt(a, "sort", "relevance") === "date" ? "search_by_date" : "search";
      return `https://hn.algolia.com/api/v1/${path}?tags=story&hitsPerPage=12&query=${q(need(a, "query", "hackernews"))}`;
    },
    parse: (body) => {
      const json = asJson("hackernews", body);
      const rows = arrayAt("hackernews", json, "hits").map((h): ServiceRow => {
        const points = num(dig(h, "points"));
        const comments = num(dig(h, "num_comments"));
        const id = str(dig(h, "objectID"));
        return {
          title: clean(str(dig(h, "title"), str(dig(h, "story_title"), "(untitled)")), 200),
          detail: `${str(dig(h, "author"), "anon")} · ${comments ?? 0} comment${comments === 1 ? "" : "s"} · ${str(dig(h, "created_at")).slice(0, 10)}`,
          url: str(dig(h, "url")) || (id ? `https://news.ycombinator.com/item?id=${id}` : undefined),
          meta: points !== undefined ? `${points} pts` : undefined,
        };
      });
      return result(rows, listSummary("story"));
    },
  },
  {
    id: "github",
    name: "GitHub Repositories",
    category: "dev",
    description: "Search public GitHub repositories by keyword and return stars, language and description.",
    provider: "GitHub",
    licence: "Unauthenticated API, rate-limited",
    docs: "https://docs.github.com/rest/search",
    reach: "proxy",
    params: [
      { name: "query", label: "Query", placeholder: "model context protocol", required: true, kind: "text" },
      { name: "sort", label: "Sort", placeholder: "stars or updated", required: false, kind: "text", default: "stars" },
    ],
    url: (a) => `https://api.github.com/search/repositories?q=${q(need(a, "query", "github"))}&sort=${q(opt(a, "sort", "stars"))}&order=desc&per_page=10`,
    parse: (body) => {
      const json = asJson("github", body);
      // GitHub answers a rate limit with 403 and a `message`, not with items.
      if (dig(json, "items") === undefined) {
        const msg = str(dig(json, "message"));
        throw new ServiceParseError("github", msg || "no items in the response");
      }
      const rows = arrayAt("github", json, "items").map((r): ServiceRow => {
        const stars = num(dig(r, "stargazers_count"));
        return {
          title: str(dig(r, "full_name"), "(unnamed)"),
          detail: clean(`${str(dig(r, "description"), "No description.")}${str(dig(r, "language")) ? ` · ${str(dig(r, "language"))}` : ""}`),
          url: str(dig(r, "html_url")) || undefined,
          meta: stars !== undefined ? `${stars.toLocaleString("en-US")} stars` : undefined,
        };
      });
      return result(rows, listSummary("repository"));
    },
  },
  {
    id: "npm",
    name: "npm Registry",
    category: "dev",
    description: "Search the npm registry and return package versions, descriptions and publishers.",
    provider: "npm, Inc.",
    licence: "Public registry API",
    docs: "https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md",
    reach: "proxy",
    params: [{ name: "query", label: "Query", placeholder: "zustand", required: true, kind: "text" }],
    url: (a) => `https://registry.npmjs.org/-/v1/search?text=${q(need(a, "query", "npm"))}&size=10`,
    parse: (body) => {
      const json = asJson("npm", body);
      const rows = arrayAt("npm", json, "objects").map((o): ServiceRow => {
        const p = dig(o, "package");
        const name = str(dig(p, "name"), "(unnamed)");
        return {
          title: name,
          detail: clean(str(dig(p, "description"), "No description.")),
          url: `https://www.npmjs.com/package/${name}`,
          meta: str(dig(p, "version")) || undefined,
        };
      });
      return result(rows, listSummary("package"));
    },
  },

  /* -- language ---------------------------------------------------------- */
  {
    id: "dictionary",
    name: "Dictionary",
    category: "language",
    description: "Return definitions, parts of speech and examples for an English word.",
    provider: "Free Dictionary API",
    licence: "CC BY-SA 3.0 (Wiktionary data)",
    docs: "https://dictionaryapi.dev",
    reach: "proxy",
    params: [{ name: "word", label: "Word", placeholder: "eigenstate", required: true, kind: "text" }],
    url: (a) => `https://api.dictionaryapi.dev/api/v2/entries/en/${q(need(a, "word", "dictionary"))}`,
    parse: (body) => {
      const json = asJson("dictionary", body);
      // A miss is an object with `title`, not an array. Reporting that as a
      // parse failure would be wrong — the word simply is not in the corpus.
      if (!Array.isArray(json)) return result([], listSummary("sense"));
      const rows: ServiceRow[] = [];
      for (const entry of json) {
        for (const m of Array.isArray(dig(entry, "meanings")) ? (dig(entry, "meanings") as unknown[]) : []) {
          const pos = str(dig(m, "partOfSpeech"), "?");
          const defs = Array.isArray(dig(m, "definitions")) ? (dig(m, "definitions") as unknown[]) : [];
          for (const d of defs.slice(0, 3)) {
            rows.push({
              title: pos,
              detail: clean(str(dig(d, "definition"), "")) + (str(dig(d, "example")) ? ` — "${clean(str(dig(d, "example")), 120)}"` : ""),
            });
          }
        }
      }
      return result(rows, listSummary("sense"));
    },
  },
  {
    id: "datamuse",
    name: "Word Relations",
    category: "language",
    description: "Find words related to a given word by meaning, sound or common usage.",
    provider: "Datamuse",
    licence: "Free, no key",
    docs: "https://www.datamuse.com/api/",
    reach: "direct",
    params: [
      { name: "word", label: "Word", placeholder: "coherence", required: true, kind: "text" },
      { name: "relation", label: "Relation", placeholder: "means_like, sounds_like, triggers", required: false, kind: "text", default: "means_like" },
    ],
    url: (a) => {
      const rel = opt(a, "relation", "means_like");
      const key = rel === "sounds_like" ? "sl" : rel === "triggers" ? "rel_trg" : "ml";
      return `https://api.datamuse.com/words?${key}=${q(need(a, "word", "datamuse"))}&max=20`;
    },
    parse: (body) => {
      const json = asJson("datamuse", body);
      if (!Array.isArray(json)) throw new ServiceParseError("datamuse", "expected an array of words");
      const rows = json.map((w): ServiceRow => ({
        title: str(dig(w, "word"), "(none)"),
        detail: Array.isArray(dig(w, "tags")) ? (dig(w, "tags") as unknown[]).map((t) => str(t)).join(", ") : "",
        meta: String(num(dig(w, "score")) ?? ""),
      }));
      return result(rows, listSummary("word"));
    },
  },

  /* -- media ------------------------------------------------------------- */
  {
    id: "openfoodfacts",
    name: "Open Food Facts",
    category: "media",
    description: "Look up a packaged food product by name and return its nutrition grade and ingredients.",
    provider: "Open Food Facts",
    licence: "ODbL 1.0",
    docs: "https://openfoodfacts.github.io/openfoodfacts-server/api/",
    reach: "proxy",
    params: [{ name: "query", label: "Product", placeholder: "oat milk", required: true, kind: "text" }],
    url: (a) => `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q(need(a, "query", "openfoodfacts"))}&search_simple=1&action=process&json=1&page_size=10&fields=product_name,brands,nutrition_grades,ingredients_text,code`,
    parse: (body) => {
      const json = asJson("openfoodfacts", body);
      // Filter BEFORE naming, not after. Open Food Facts returns a present but
      // empty product_name for half-entered records, and `str("")` is "" — so
      // a filter that looks for a "(unnamed)" sentinel downstream never
      // matches anything and every blank row survives.
      const rows = arrayAt("openfoodfacts", json, "products")
        .filter((p) => str(dig(p, "product_name")).trim() !== "")
        .map((p): ServiceRow => ({
          title: str(dig(p, "product_name")),
          detail: clean([str(dig(p, "brands")), str(dig(p, "ingredients_text"))].filter(Boolean).join(" — ")) || "No ingredient list.",
          url: str(dig(p, "code")) ? `https://world.openfoodfacts.org/product/${str(dig(p, "code"))}` : undefined,
          meta: str(dig(p, "nutrition_grades")).toUpperCase() || undefined,
        }));
      return result(rows, listSummary("product"));
    },
  },
  {
    id: "metmuseum",
    name: "Met Museum",
    category: "media",
    description: "Search the Metropolitan Museum of Art's open collection for objects matching a term.",
    provider: "The Metropolitan Museum of Art",
    licence: "CC0 1.0 (open access objects)",
    docs: "https://metmuseum.github.io",
    reach: "proxy",
    params: [{ name: "query", label: "Query", placeholder: "hokusai", required: true, kind: "text" }],
    url: (a) => `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${q(need(a, "query", "metmuseum"))}`,
    parse: (body) => {
      const json = asJson("metmuseum", body);
      const total = num(dig(json, "total"));
      const ids = dig(json, "objectIDs");
      // The Met sends `objectIDs: null` for a miss, which is not an array and
      // is not an error either.
      if (ids === null || ids === undefined) return result([], listSummary("object"));
      if (!Array.isArray(ids)) throw new ServiceParseError("metmuseum", "objectIDs was neither null nor an array");
      const rows = ids.slice(0, 12).map((id): ServiceRow => ({
        title: `Object ${str(id)}`,
        detail: "Open on the Met's site for the image, artist and provenance.",
        url: `https://www.metmuseum.org/art/collection/search/${str(id)}`,
      }));
      return {
        rows,
        summary: `${total ?? ids.length} matching objects; showing the first ${rows.length}.`,
        empty: rows.length === 0,
      };
    },
  },

  /* ── round two ─────────────────────────────────────────────────────────
     Every entry below was probed live before its parser was written, and
     every `reach: "direct"` was confirmed by reading the host's real
     access-control-allow-origin header rather than assumed. A service marked
     direct that the browser cannot actually call fails with an opaque network
     error indistinguishable from the host being down. */

  {
    id: "openalex",
    name: "OpenAlex",
    category: "science",
    description: "Search the OpenAlex index of scholarly works and return citation counts and DOIs.",
    provider: "OurResearch",
    licence: "CC0 1.0",
    docs: "https://docs.openalex.org",
    reach: "direct",
    params: [
      { name: "query", label: "Query", placeholder: "mechanistic interpretability", required: true, kind: "text" },
      { name: "limit", label: "Results", placeholder: "10", required: false, kind: "number", default: "10" },
    ],
    url: (a) =>
      `https://api.openalex.org/works?search=${q(need(a, "query", "openalex"))}&per-page=${q(opt(a, "limit", "10"))}` +
      `&select=id,title,publication_year,cited_by_count,doi`,
    parse: (body) => {
      const json = asJson("openalex", body);
      const rows = arrayAt("openalex", json, "results").map((w): ServiceRow => {
        const cites = num(dig(w, "cited_by_count"));
        const year = num(dig(w, "publication_year"));
        return {
          title: clean(str(dig(w, "title"), "(untitled)"), 200),
          detail: cites !== undefined ? `Cited ${cites.toLocaleString("en-US")} times` : "Citation count unavailable",
          url: str(dig(w, "doi")) || str(dig(w, "id")) || undefined,
          meta: year !== undefined ? String(year) : undefined,
        };
      });
      return result(rows, listSummary("work"));
    },
  },
  {
    id: "openfda",
    name: "Drug Labels",
    category: "science",
    description: "Search FDA-approved drug labelling for a generic or brand name and return its indications and warnings.",
    provider: "US Food and Drug Administration",
    licence: "Public domain",
    docs: "https://open.fda.gov/apis/drug/label/",
    reach: "proxy",
    params: [{ name: "drug", label: "Drug", placeholder: "ibuprofen", required: true, kind: "text" }],
    url: (a) => `https://api.fda.gov/drug/label.json?search=openfda.generic_name:${q(need(a, "drug", "openfda"))}&limit=5`,
    parse: (body) => {
      const json = asJson("openfda", body);
      // openFDA reports a miss as an `error` object with NOT_FOUND, which is a
      // miss and not an outage.
      if (str(dig(json, "error", "code")) === "NOT_FOUND") return result([], listSummary("label"));
      const rows = arrayAt("openfda", json, "results").map((r): ServiceRow => {
        const names = dig(r, "openfda", "brand_name");
        const first = (k: string) => {
          const v = dig(r, k);
          return Array.isArray(v) && v.length > 0 ? str(v[0]) : "";
        };
        return {
          title: Array.isArray(names) && names.length > 0 ? str(names[0]) : "(unnamed product)",
          detail: clean(first("indications_and_usage") || first("purpose") || first("description") || "No indications section.", 600),
          meta: first("effective_time").slice(0, 4) || undefined,
        };
      });
      return result(rows, listSummary("label"));
    },
  },
  {
    id: "species",
    name: "Species",
    category: "science",
    description: "Look up a species in the Global Biodiversity Information Facility backbone and return its taxonomy.",
    provider: "GBIF",
    licence: "CC BY 4.0",
    docs: "https://techdocs.gbif.org/en/openapi/",
    reach: "direct",
    params: [{ name: "query", label: "Species", placeholder: "puffin", required: true, kind: "text" }],
    url: (a) => `https://api.gbif.org/v1/species/search?q=${q(need(a, "query", "species"))}&limit=10&status=ACCEPTED`,
    parse: (body) => {
      const json = asJson("species", body);
      const rows = arrayAt("species", json, "results").map((s): ServiceRow => ({
        title: str(dig(s, "scientificName"), str(dig(s, "canonicalName"), "(unnamed)")),
        detail: clean([str(dig(s, "kingdom")), str(dig(s, "phylum")), str(dig(s, "class")), str(dig(s, "order")), str(dig(s, "family"))].filter(Boolean).join(" > ")) || "No taxonomy given.",
        url: num(dig(s, "key")) !== undefined ? `https://www.gbif.org/species/${num(dig(s, "key"))}` : undefined,
        meta: str(dig(s, "rank")) || undefined,
      }));
      return result(rows, listSummary("taxon"));
    },
  },

  /* -- dev --------------------------------------------------------------- */
  {
    id: "stackexchange",
    name: "Stack Overflow",
    category: "dev",
    description: "Search Stack Overflow questions and return scores, answer counts and whether one is accepted.",
    provider: "Stack Exchange",
    licence: "CC BY-SA 4.0",
    docs: "https://api.stackexchange.com/docs",
    reach: "direct",
    params: [{ name: "query", label: "Query", placeholder: "zustand persist hydration", required: true, kind: "text" }],
    url: (a) =>
      `https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&q=${q(need(a, "query", "stackexchange"))}` +
      `&pagesize=10&order=desc&sort=relevance&filter=default`,
    parse: (body) => {
      const json = asJson("stackexchange", body);
      // Stack Exchange reports throttling as an error envelope with no items.
      if (dig(json, "items") === undefined) {
        throw new ServiceParseError("stackexchange", str(dig(json, "error_message")) || "no items in the response");
      }
      const rows = arrayAt("stackexchange", json, "items").map((h): ServiceRow => {
        const score = num(dig(h, "score"));
        const answers = num(dig(h, "answer_count"));
        const accepted = dig(h, "is_answered") === true;
        return {
          // Titles arrive HTML-escaped; showing &quot; to the reader is a bug.
          title: clean(decodeEntities(str(dig(h, "title"), "(untitled)")), 200),
          detail: `${answers ?? 0} answer${answers === 1 ? "" : "s"}${accepted ? ", accepted" : ", none accepted"} · ${(Array.isArray(dig(h, "tags")) ? (dig(h, "tags") as unknown[]).map((t) => str(t)) : []).slice(0, 5).join(", ")}`,
          url: str(dig(h, "link")) || undefined,
          meta: score !== undefined ? `${score} score` : undefined,
        };
      });
      return result(rows, listSummary("question"));
    },
  },
  {
    id: "pypi",
    name: "PyPI",
    category: "dev",
    description: "Look up a Python package on PyPI and return its version, summary, licence and project links.",
    provider: "Python Software Foundation",
    licence: "Public registry API",
    docs: "https://docs.pypi.org/api/json/",
    reach: "direct",
    params: [{ name: "package", label: "Package", placeholder: "requests", required: true, kind: "text" }],
    url: (a) => `https://pypi.org/pypi/${q(need(a, "package", "pypi"))}/json`,
    parse: (body) => {
      const json = asJson("pypi", body);
      const info = dig(json, "info");
      if (!isRecord(info)) throw new ServiceParseError("pypi", "no info object — the package may not exist");
      const releases = dig(json, "releases");
      const versions = isRecord(releases) ? Object.keys(releases).length : undefined;
      return {
        rows: [{
          title: str(info.name, "(unnamed)"),
          detail: clean([
            str(info.summary, "No summary."),
            str(info.license) ? `Licence: ${str(info.license)}` : "",
            str(info.requires_python) ? `Requires Python ${str(info.requires_python)}` : "",
            versions !== undefined ? `${versions} releases` : "",
          ].filter(Boolean).join(" · ")),
          url: str(info.project_url) || str(info.package_url) || undefined,
          meta: str(info.version) || undefined,
        }],
        summary: `${str(info.name)} ${str(info.version)} — ${clean(str(info.summary, "no summary"), 300)}`,
        empty: false,
      };
    },
  },
  {
    id: "crates",
    name: "crates.io",
    category: "dev",
    description: "Search the Rust crate registry and return downloads, latest version and description.",
    provider: "Rust Foundation",
    licence: "Public registry API",
    docs: "https://crates.io/data-access",
    reach: "proxy",
    params: [{ name: "query", label: "Query", placeholder: "serde", required: true, kind: "text" }],
    url: (a) => `https://crates.io/api/v1/crates?q=${q(need(a, "query", "crates"))}&per_page=10`,
    parse: (body) => {
      const json = asJson("crates", body);
      const rows = arrayAt("crates", json, "crates").map((c): ServiceRow => {
        const downloads = num(dig(c, "downloads"));
        const name = str(dig(c, "name"), "(unnamed)");
        return {
          title: name,
          detail: clean(str(dig(c, "description"), "No description.")),
          url: `https://crates.io/crates/${name}`,
          meta: [str(dig(c, "max_stable_version")) || str(dig(c, "newest_version")), downloads !== undefined ? `${downloads.toLocaleString("en-US")} downloads` : ""].filter(Boolean).join(" · ") || undefined,
        };
      });
      return result(rows, listSummary("crate"));
    },
  },
  {
    id: "depsdev",
    name: "Package Versions",
    category: "dev",
    description: "List every published version of a package across npm, PyPI, Cargo, Go, Maven or NuGet, flagging deprecated ones.",
    provider: "Google Open Source Insights",
    licence: "Free, no key",
    docs: "https://docs.deps.dev/api/v3alpha/",
    reach: "direct",
    params: [
      { name: "system", label: "Ecosystem", placeholder: "npm, pypi, cargo, go, maven, nuget", required: false, kind: "text", default: "npm" },
      { name: "package", label: "Package", placeholder: "zustand", required: true, kind: "text" },
    ],
    url: (a) => `https://api.deps.dev/v3alpha/systems/${q(opt(a, "system", "npm").toLowerCase())}/packages/${q(need(a, "package", "depsdev"))}`,
    parse: (body) => {
      const json = asJson("depsdev", body);
      const versions = arrayAt("depsdev", json, "versions");
      // Newest last in the API's own order; the reader wants newest first.
      const rows = versions.slice(-20).reverse().map((v): ServiceRow => {
        const deprecated = dig(v, "isDeprecated") === true;
        const isDefault = dig(v, "isDefault") === true;
        return {
          title: str(dig(v, "versionKey", "version"), "(no version)"),
          detail: [
            deprecated ? `DEPRECATED${str(dig(v, "deprecatedReason")) ? `: ${clean(str(dig(v, "deprecatedReason")), 160)}` : ""}` : "",
            isDefault ? "current default" : "",
            str(dig(v, "publishedAt")).slice(0, 10),
          ].filter(Boolean).join(" · ") || "Published",
          meta: deprecated ? "deprecated" : isDefault ? "default" : undefined,
        };
      });
      return result(rows, (r) => `${versions.length} published versions; newest ${r.length} shown: ${r.map((x) => x.title).join(", ")}`);
    },
  },
  {
    id: "cve",
    name: "Vulnerabilities",
    category: "dev",
    description: "Search the National Vulnerability Database by keyword and return CVE identifiers with their severity.",
    provider: "NIST",
    licence: "Public domain",
    docs: "https://nvd.nist.gov/developers/vulnerabilities",
    reach: "proxy",
    params: [{ name: "query", label: "Keyword", placeholder: "next.js", required: true, kind: "text" }],
    // Unauthenticated NVD allows roughly 5 requests per 30 seconds. The small
    // page size is deliberate: a large one makes a slow endpoint slower and
    // burns the same quota.
    url: (a) => `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${q(need(a, "query", "cve"))}&resultsPerPage=10`,
    parse: (body) => {
      const json = asJson("cve", body);
      const total = num(dig(json, "totalResults"));
      const rows = arrayAt("cve", json, "vulnerabilities").map((v): ServiceRow => {
        const cve = dig(v, "cve");
        const id = str(dig(cve, "id"), "(no id)");
        const descs = dig(cve, "descriptions");
        const en = Array.isArray(descs) ? descs.find((d) => str(dig(d, "lang")) === "en") : undefined;
        const metrics = dig(cve, "metrics", "cvssMetricV31");
        const score = Array.isArray(metrics) && metrics.length > 0 ? num(dig(metrics[0], "cvssData", "baseScore")) : undefined;
        const sev = Array.isArray(metrics) && metrics.length > 0 ? str(dig(metrics[0], "cvssData", "baseSeverity")) : "";
        return {
          title: id,
          detail: clean(str(dig(en, "value"), "No description."), 500),
          url: `https://nvd.nist.gov/vuln/detail/${id}`,
          meta: score !== undefined ? `CVSS ${score}${sev ? ` ${sev}` : ""}` : undefined,
        };
      });
      if (rows.length === 0) return result([], listSummary("vulnerability"));
      return { rows, summary: `${total ?? rows.length} matching CVEs; ${rows.length} shown: ${rows.map((r) => `${r.title}${r.meta ? ` (${r.meta})` : ""}`).join(", ")}`, empty: false };
    },
  },
  {
    id: "dockerhub",
    name: "Docker Hub",
    category: "dev",
    description: "Search Docker Hub for container images and return stars, pulls and whether the image is official.",
    provider: "Docker, Inc.",
    licence: "Public search API",
    docs: "https://docs.docker.com/reference/api/hub/latest/",
    reach: "proxy",
    params: [{ name: "query", label: "Query", placeholder: "postgres", required: true, kind: "text" }],
    url: (a) => `https://hub.docker.com/v2/search/repositories/?query=${q(need(a, "query", "dockerhub"))}&page_size=10`,
    parse: (body) => {
      const json = asJson("dockerhub", body);
      const rows = arrayAt("dockerhub", json, "results").map((r): ServiceRow => {
        const stars = num(dig(r, "star_count"));
        const pulls = num(dig(r, "pull_count"));
        const name = str(dig(r, "repo_name"), "(unnamed)");
        return {
          title: name,
          detail: clean([
            str(dig(r, "short_description"), "No description."),
            dig(r, "is_official") === true ? "OFFICIAL IMAGE" : "",
            pulls !== undefined ? `${pulls.toLocaleString("en-US")} pulls` : "",
          ].filter(Boolean).join(" · ")),
          url: `https://hub.docker.com/r/${name}`,
          meta: stars !== undefined ? `${stars.toLocaleString("en-US")} stars` : undefined,
        };
      });
      return result(rows, listSummary("image"));
    },
  },

  /* -- knowledge --------------------------------------------------------- */
  {
    id: "onthisday",
    name: "On This Day",
    category: "knowledge",
    description: "Return notable historical events that happened on a given month and day.",
    provider: "Wikimedia Foundation",
    licence: "CC BY-SA 4.0",
    docs: "https://en.wikipedia.org/api/rest_v1/",
    reach: "direct",
    params: [
      { name: "month", label: "Month (MM)", placeholder: "09", required: true, kind: "text" },
      { name: "day", label: "Day (DD)", placeholder: "16", required: true, kind: "text" },
    ],
    url: (a) => {
      const pad = (v: string) => (v.length === 1 ? `0${v}` : v);
      return `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${q(pad(need(a, "month", "onthisday")))}/${q(pad(need(a, "day", "onthisday")))}`;
    },
    parse: (body) => {
      const json = asJson("onthisday", body);
      const rows = arrayAt("onthisday", json, "events").map((e): ServiceRow => {
        const year = num(dig(e, "year"));
        const pages = dig(e, "pages");
        const first = Array.isArray(pages) && pages.length > 0 ? pages[0] : undefined;
        return {
          title: year !== undefined ? String(year) : "(undated)",
          detail: clean(str(dig(e, "text"), "")),
          url: str(dig(first, "content_urls", "desktop", "page")) || undefined,
        };
      // The feed arrives oldest-last; a reader scanning a millennium wants it
      // chronological.
      }).sort((a, b) => Number(a.title) - Number(b.title));
      return result(rows, listSummary("event"));
    },
  },
  {
    id: "pageviews",
    name: "Article Traffic",
    category: "knowledge",
    description: "Return monthly Wikipedia pageview counts for one article over a date range.",
    provider: "Wikimedia Foundation",
    licence: "CC0 1.0",
    docs: "https://wikimedia.org/api/rest_v1/",
    reach: "direct",
    params: [
      { name: "article", label: "Article", placeholder: "Quantum_state", required: true, kind: "text" },
      { name: "start", label: "From (YYYYMMDD)", placeholder: "20250101", required: false, kind: "text", default: "20250101" },
      { name: "end", label: "To (YYYYMMDD)", placeholder: "20251231", required: false, kind: "text", default: "20251231" },
    ],
    url: (a) =>
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/` +
      `${q(need(a, "article", "pageviews").replace(/ /g, "_"))}/monthly/${q(opt(a, "start", "20250101"))}/${q(opt(a, "end", "20251231"))}`,
    parse: (body) => {
      const json = asJson("pageviews", body);
      // A 404 body carries `type`/`title` instead of items; that is "no data
      // for this article", not a broken payload.
      if (dig(json, "items") === undefined) return result([], listSummary("month"));
      const items = arrayAt("pageviews", json, "items");
      const rows = items.map((i): ServiceRow => {
        const ts = str(dig(i, "timestamp"));
        const views = num(dig(i, "views"));
        return {
          title: `${ts.slice(0, 4)}-${ts.slice(4, 6)}`,
          detail: "Monthly pageviews, all access, all agents",
          meta: views !== undefined ? views.toLocaleString("en-US") : undefined,
        };
      });
      const total = items.reduce<number>((sum, i) => sum + (num(dig(i, "views")) ?? 0), 0);
      if (rows.length === 0) return result([], listSummary("month"));
      return { rows, summary: `${rows.length} months, ${total.toLocaleString("en-US")} views total: ${rows.map((r) => `${r.title} ${r.meta}`).join(", ")}`, empty: false };
    },
  },

  /* -- earth ------------------------------------------------------------- */
  {
    id: "reverse_geocode",
    name: "Reverse Geocoding",
    category: "earth",
    description: "Turn a latitude and longitude into a street address and administrative area.",
    provider: "OpenStreetMap Nominatim",
    licence: "ODbL 1.0",
    docs: "https://nominatim.org/release-docs/latest/api/Reverse/",
    reach: "proxy",
    params: [
      { name: "latitude", label: "Latitude", placeholder: "64.1466", required: true, kind: "number" },
      { name: "longitude", label: "Longitude", placeholder: "-21.9426", required: true, kind: "number" },
    ],
    url: (a) =>
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${q(need(a, "latitude", "reverse_geocode"))}&lon=${q(need(a, "longitude", "reverse_geocode"))}`,
    parse: (body) => {
      const json = asJson("reverse_geocode", body);
      // Nominatim answers an ocean coordinate with {"error": "Unable to geocode"}.
      if (dig(json, "error") !== undefined) return result([], listSummary("place"));
      const display = str(dig(json, "display_name"));
      if (!display) throw new ServiceParseError("reverse_geocode", "no display_name in the response");
      const addr = dig(json, "address");
      const rows: ServiceRow[] = [{
        title: str(dig(json, "name")) || display.split(",")[0] || "(unnamed)",
        detail: clean(display, 400),
        meta: str(dig(json, "addresstype")) || str(dig(json, "type")) || undefined,
      }];
      if (isRecord(addr)) {
        for (const [k, v] of Object.entries(addr)) {
          rows.push({ title: k.replace(/_/g, " "), detail: str(v), meta: undefined });
        }
      }
      return { rows, summary: clean(display, 500), empty: false };
    },
  },
  {
    id: "weather_history",
    name: "Historical Weather",
    category: "earth",
    description: "Return daily mean temperature and precipitation for a coordinate over a past date range.",
    provider: "Open-Meteo",
    licence: "CC BY 4.0",
    docs: "https://open-meteo.com/en/docs/historical-weather-api",
    reach: "direct",
    params: [
      { name: "latitude", label: "Latitude", placeholder: "64.15", required: true, kind: "number" },
      { name: "longitude", label: "Longitude", placeholder: "-21.94", required: true, kind: "number" },
      { name: "start_date", label: "From (YYYY-MM-DD)", placeholder: "2025-01-01", required: false, kind: "text", default: "2025-01-01" },
      { name: "end_date", label: "To (YYYY-MM-DD)", placeholder: "2025-01-31", required: false, kind: "text", default: "2025-01-31" },
    ],
    url: (a) =>
      `https://archive-api.open-meteo.com/v1/archive?latitude=${q(need(a, "latitude", "weather_history"))}` +
      `&longitude=${q(need(a, "longitude", "weather_history"))}&start_date=${q(opt(a, "start_date", "2025-01-01"))}` +
      `&end_date=${q(opt(a, "end_date", "2025-01-31"))}&daily=temperature_2m_mean,precipitation_sum&timezone=auto`,
    parse: (body) => {
      const json = asJson("weather_history", body);
      const days = arrayAt("weather_history", json, "daily", "time").map((x) => str(x));
      const mean = arrayAt("weather_history", json, "daily", "temperature_2m_mean");
      const rain = arrayAt("weather_history", json, "daily", "precipitation_sum");
      const rows = days.map((d, i): ServiceRow => {
        const t = num(mean[i]);
        const p = num(rain[i]);
        return {
          title: d,
          detail: p !== undefined ? `${p} mm precipitation` : "Precipitation unavailable",
          meta: t !== undefined ? `${t}°C mean` : undefined,
        };
      });
      if (rows.length === 0) return result([], listSummary("day"));
      const temps = mean.map((x) => num(x)).filter((x): x is number => x !== undefined);
      const avg = temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : undefined;
      return {
        rows,
        summary: `${rows.length} days from ${days[0]} to ${days[days.length - 1]}` +
          (avg !== undefined ? `, mean ${avg.toFixed(1)}°C` : "") +
          `, total precipitation ${rain.reduce<number>((a, b) => a + (num(b) ?? 0), 0).toFixed(1)} mm.`,
        empty: false,
      };
    },
  },

  /* -- finance ----------------------------------------------------------- */
  {
    id: "fx_history",
    name: "Exchange Rate History",
    category: "finance",
    description: "Return a time series of European Central Bank reference rates between two dates.",
    provider: "Frankfurter (ECB data)",
    licence: "Public data, free API",
    docs: "https://frankfurter.dev",
    reach: "direct",
    params: [
      { name: "from", label: "Base", placeholder: "USD", required: false, kind: "text", default: "USD" },
      { name: "to", label: "Against", placeholder: "EUR", required: false, kind: "text", default: "EUR" },
      { name: "start", label: "From (YYYY-MM-DD)", placeholder: "2026-01-01", required: false, kind: "text", default: "2026-01-01" },
      { name: "end", label: "To (YYYY-MM-DD)", placeholder: "2026-03-01", required: false, kind: "text", default: "2026-03-01" },
    ],
    url: (a) =>
      `https://api.frankfurter.dev/v1/${q(opt(a, "start", "2026-01-01"))}..${q(opt(a, "end", "2026-03-01"))}` +
      `?base=${q(opt(a, "from", "USD").toUpperCase())}&symbols=${q(opt(a, "to", "EUR").toUpperCase())}`,
    parse: (body) => {
      const json = asJson("fx_history", body);
      const base = str(dig(json, "base"));
      const rates = dig(json, "rates");
      if (!isRecord(rates)) throw new ServiceParseError("fx_history", "rates was not an object");
      const dates = Object.keys(rates).sort();
      const rows = dates.map((d): ServiceRow => {
        const day = rates[d];
        const pairs = isRecord(day) ? Object.entries(day) : [];
        return {
          title: d,
          detail: `Reference rate against ${base}`,
          meta: pairs.map(([sym, v]) => `${sym} ${num(v) ?? v}`).join(", ") || undefined,
        };
      });
      if (rows.length === 0) return result([], listSummary("day"));
      const firstDay = rates[dates[0] as string];
      const lastDay = rates[dates[dates.length - 1] as string];
      const sym = isRecord(firstDay) ? Object.keys(firstDay)[0] : undefined;
      const a0 = sym && isRecord(firstDay) ? num(firstDay[sym]) : undefined;
      const a1 = sym && isRecord(lastDay) ? num(lastDay[sym]) : undefined;
      const move = a0 !== undefined && a1 !== undefined && a0 !== 0 ? ((a1 - a0) / a0) * 100 : undefined;
      return {
        rows,
        summary: `${rows.length} observations from ${dates[0]} to ${dates[dates.length - 1]}, base ${base}` +
          (move !== undefined && sym ? `. ${sym} moved ${move >= 0 ? "+" : ""}${move.toFixed(2)}% over the period (${a0} to ${a1}).` : "."),
        empty: false,
      };
    },
  },

  /* -- civic ------------------------------------------------------------- */
  {
    id: "federalregister",
    name: "Federal Register",
    category: "civic",
    description: "Search United States federal rules, proposed rules and notices by term.",
    provider: "US Office of the Federal Register",
    licence: "Public domain",
    docs: "https://www.federalregister.gov/developers/api/v1",
    reach: "direct",
    params: [{ name: "query", label: "Term", placeholder: "artificial intelligence", required: true, kind: "text" }],
    url: (a) =>
      `https://www.federalregister.gov/api/v1/documents.json?per_page=10&order=newest` +
      `&conditions%5Bterm%5D=${q(need(a, "query", "federalregister"))}` +
      `&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=type&fields%5B%5D=html_url&fields%5B%5D=agencies`,
    parse: (body) => {
      const json = asJson("federalregister", body);
      // A zero-result search answers with count 0 and no `results` key at all.
      if (dig(json, "results") === undefined) return result([], listSummary("document"));
      const total = num(dig(json, "count"));
      const rows = arrayAt("federalregister", json, "results").map((d): ServiceRow => {
        const agencies = dig(d, "agencies");
        const names = Array.isArray(agencies)
          ? agencies.map((x) => str(dig(x, "name")) || str(dig(x, "raw_name"))).filter(Boolean)
          : [];
        return {
          title: clean(str(dig(d, "title"), "(untitled)"), 200),
          detail: clean([str(dig(d, "type")), names.slice(0, 3).join(", ")].filter(Boolean).join(" — ")) || "No agency given.",
          url: str(dig(d, "html_url")) || undefined,
          meta: str(dig(d, "publication_date")) || undefined,
        };
      });
      if (rows.length === 0) return result([], listSummary("document"));
      return { rows, summary: `${total ?? rows.length} matching documents; ${rows.length} newest shown:\n` + rows.map((r, i) => `${i + 1}. ${r.title} (${r.meta})`).join("\n"), empty: false };
    },
  },
  {
    id: "postcode",
    name: "Postal Codes",
    category: "civic",
    description: "Turn a postal code into its place names, state and coordinates.",
    provider: "Zippopotam.us",
    licence: "Free, no key",
    docs: "https://api.zippopotam.us",
    reach: "direct",
    params: [
      { name: "country", label: "Country (ISO-2)", placeholder: "us", required: false, kind: "text", default: "us" },
      { name: "code", label: "Postal code", placeholder: "90210", required: true, kind: "text" },
    ],
    url: (a) => `https://api.zippopotam.us/${q(opt(a, "country", "us").toLowerCase())}/${q(need(a, "code", "postcode"))}`,
    parse: (body) => {
      const json = asJson("postcode", body);
      // An unknown code answers with an empty object and HTTP 404.
      if (!isRecord(json) || Object.keys(json).length === 0) return result([], listSummary("place"));
      const places = dig(json, "places");
      if (!Array.isArray(places)) throw new ServiceParseError("postcode", "no places array in the response");
      const code = str(dig(json, "post code"));
      const rows = places.map((p): ServiceRow => {
        const lat = num(dig(p, "latitude"));
        const lon = num(dig(p, "longitude"));
        return {
          title: str(dig(p, "place name"), "(unnamed)"),
          detail: clean([str(dig(p, "state")), str(dig(json, "country"))].filter(Boolean).join(", ")),
          meta: lat !== undefined && lon !== undefined ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : undefined,
        };
      });
      return result(rows, (r) => `${code}: ${r.map((x) => `${x.title}${x.detail ? ` (${x.detail})` : ""}`).join("; ")}`);
    },
  },

  /* -- media ------------------------------------------------------------- */
  {
    id: "commons",
    name: "Wikimedia Commons",
    category: "media",
    description: "Search Wikimedia Commons for freely licensed images and media files.",
    provider: "Wikimedia Foundation",
    licence: "Varies per file; each is free to reuse with attribution",
    docs: "https://commons.wikimedia.org/w/api.php",
    reach: "direct",
    params: [{ name: "query", label: "Query", placeholder: "aurora borealis", required: true, kind: "text" }],
    url: (a) =>
      `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&list=search&srnamespace=6&srlimit=12` +
      `&srsearch=${q(need(a, "query", "commons"))}`,
    parse: (body) => {
      const json = asJson("commons", body);
      const hits = dig(json, "query", "search");
      if (hits === undefined) return result([], listSummary("file"));
      if (!Array.isArray(hits)) throw new ServiceParseError("commons", "query.search was not an array");
      const rows = hits.map((h): ServiceRow => {
        const title = str(dig(h, "title"), "(untitled)");
        return {
          title: title.replace(/^File:/, ""),
          // The snippet is HTML with <span class="searchmatch"> highlighting.
          detail: clean(decodeEntities(stripTags(str(dig(h, "snippet"))))) || "No description.",
          url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(title)}`,
          meta: num(dig(h, "size")) !== undefined ? `${num(dig(h, "size"))} bytes of text` : undefined,
        };
      });
      return result(rows, listSummary("file"));
    },
  },
];

/** WMO weather interpretation codes, as used by Open-Meteo. */
const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

/* ── catalogue accessors ─────────────────────────────────────────────────── */

export function serviceById(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

export function servicesByCategory(category: ServiceCategory): ServiceDef[] {
  return SERVICES.filter((s) => s.category === category);
}

export const SERVICE_CATEGORIES: ServiceCategory[] = [
  "knowledge", "science", "earth", "finance", "dev", "language", "civic", "media",
];

/** Fill in every declared default so a caller may pass only what it cares
 *  about, and `url()` still sees a complete argument set. */
export function withDefaults(def: ServiceDef, args: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of def.params) {
    if (p.default !== undefined) out[p.name] = p.default;
  }
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") out[k] = String(v);
  }
  return out;
}

/** Which required parameters are still missing. Empty means ready to call. */
export function missingParams(def: ServiceDef, args: Record<string, string>): string[] {
  const filled = withDefaults(def, args);
  return def.params.filter((p) => p.required && !(filled[p.name] ?? "").trim()).map((p) => p.name);
}
