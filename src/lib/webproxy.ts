/* Pure rewriting logic for the Browser's Web mode (/api/web).

   No I/O, no DOM, no clock, no randomness: every function here takes strings
   in and gives strings out, so it is tested directly in tests/webproxy.test.mjs.
   The route handler does the fetching; this module decides what the bytes
   become on the way through.

   URL SCHEME. A proxied URL looks like
       <origin>/api/web/<sid>/<scheme>/<host[:port]><path><?query>
   rather than /api/web?u=<encoded>. Keeping the upstream path as a real path
   means relative references a page computes at runtime (webpack chunks,
   `import("./x.js")`, `new URL("a.png", import.meta.url)`) still resolve to the
   right upstream directory. A trailing slash is encoded as a final DIR_MARKER
   segment because Next.js 308-redirects any path ending in "/", which would
   silently change "/docs/" into "/docs" upstream.

   SECURITY. Proxied pages are served from the OS's own origin. They must never
   run with that origin, or they could read localStorage, where the user's AI
   keys live. Every /api/web response therefore carries SANDBOX_CSP (a
   `sandbox` CSP without allow-same-origin, giving the document an opaque
   origin even on a top-level visit), and the Browser's iframe uses the same
   token list. Headers that could act on our origin (Set-Cookie,
   Clear-Site-Data, HSTS, Service-Worker-Allowed) are dropped, never relayed. */

export const DIR_MARKER = "__aios_dir__";

/** Sandbox tokens for Web mode. Deliberately no allow-same-origin and no
 *  allow-top-navigation. Shared by the iframe attribute and the CSP header. */
export const SANDBOX_TOKENS =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-presentation allow-modals";

export const SANDBOX_CSP = `sandbox ${SANDBOX_TOKENS}`;

/** Largest HTML or CSS body buffered for rewriting. Everything else streams. */
export const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

/** Upper bound on the serialized cookie-jar cookie (browsers cap a cookie near 4 KB). */
export const MAX_JAR_CHARS = 3800;

const SKIP_SCHEME = /^\s*(data:|blob:|javascript:|about:|mailto:|tel:|sms:|#)/i;

/* ── URL encoding ───────────────────────────────────────────────────────── */

/** "https://a.com/x/?q=1" -> "https/a.com/x/__aios_dir__?q=1". Null for non-http(s). */
export function encodeTarget(target: string): string | null {
  let u: URL;
  try { u = new URL(target); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let path = u.pathname || "/";
  if (path.endsWith("/")) path += DIR_MARKER;
  return `${u.protocol.slice(0, -1)}/${u.host}${path}${u.search}`;
}

/** Inverse of encodeTarget. `rest` is everything after "/api/web/<sid>/". */
export function decodeTarget(rest: string, search: string): string | null {
  const m = /^(https?)\/([^/?#]+)(\/[^?#]*)?$/.exec(rest);
  if (!m) return null;
  let path = m[3] ?? "/";
  if (path === `/${DIR_MARKER}`) path = "/";
  else if (path.endsWith(`/${DIR_MARKER}`)) path = path.slice(0, -DIR_MARKER.length);
  try {
    const u = new URL(`${m[1]}://${m[2]}${path}${search}`);
    return u.href;
  } catch {
    return null;
  }
}

/** Resolve `raw` against `base` and route it through the proxy at `prefix`
 *  (an absolute "<origin>/api/web/<sid>"). Left untouched: fragments, data:,
 *  blob:, javascript:, mailto:, and anything already proxied. The result is
 *  absolute because the page carries a <base href> of the upstream URL, which
 *  would otherwise resolve "/api/web/..." against the upstream host. */
export function proxify(raw: string, base: string, prefix: string): string {
  const s = raw.trim();
  if (!s || SKIP_SCHEME.test(s) || s.startsWith(`${prefix}/`)) return raw;
  let abs: URL;
  try { abs = new URL(s, base); } catch { return raw; }
  const enc = encodeTarget(abs.href);
  if (!enc) return raw;
  return `${prefix}/${enc}${abs.hash}`;
}

/** The upstream URL a proxied URL stands for, or null if it is not one. */
export function unproxify(url: string, prefix: string): string | null {
  if (!url.startsWith(`${prefix}/`)) return null;
  const rest = url.slice(prefix.length + 1);
  const hashAt = rest.indexOf("#");
  const noHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const q = noHash.indexOf("?");
  const decoded = decodeTarget(q >= 0 ? noHash.slice(0, q) : noHash, q >= 0 ? noHash.slice(q) : "");
  return decoded && hashAt >= 0 ? decoded + rest.slice(hashAt) : decoded;
}

/* ── CSS ────────────────────────────────────────────────────────────────── */

/** Rewrite url(...) and @import "..." so stylesheets, fonts and background
 *  images load through the proxy. */
export function rewriteCss(css: string, base: string, prefix: string): string {
  return css
    .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (whole, q: string, u: string) => {
      if (!u.trim()) return whole;
      return `url(${q}${proxify(u, base, prefix)}${q})`;
    })
    .replace(/@import\s+(["'])([^"']+)\1/gi, (_w, q: string, u: string) => `@import ${q}${proxify(u, base, prefix)}${q}`);
}

/** Rewrite each candidate of a srcset ("a.png 1x, b.png 2x"). */
export function rewriteSrcset(value: string, base: string, prefix: string): string {
  return value
    .split(/,(?=\s*\S)/)
    .map((part) => {
      const m = /^(\s*)(\S+)(.*)$/.exec(part);
      if (!m) return part;
      return `${m[1]}${proxify(m[2], base, prefix)}${m[3]}`;
    })
    .join(",");
}

/* ── HTML ───────────────────────────────────────────────────────────────── */

const URL_ATTRS: Record<string, string[]> = {
  a: ["href"], area: ["href"], link: ["href"],
  img: ["src"], script: ["src"], iframe: ["src"], frame: ["src"], embed: ["src"],
  source: ["src"], track: ["src"], audio: ["src"], video: ["src", "poster"], input: ["src", "formaction"],
  form: ["action"], button: ["formaction"], object: ["data"],
  body: ["background"], table: ["background"], td: ["background"],
};

function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|#39|apos|lt|gt|#x27|#x2F|#47);/gi, (m, e: string) => {
    switch (e.toLowerCase()) {
      case "amp": return "&";
      case "quot": return '"';
      case "#39": case "apos": case "#x27": return "'";
      case "lt": return "<";
      case "gt": return ">";
      case "#x2f": case "#47": return "/";
      default: return m;
    }
  });
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Resolve the effective document base: a page's own <base href> wins. */
export function effectiveBase(html: string, pageUrl: string): string {
  const m = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const raw = m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : "";
  if (!raw) return pageUrl;
  try { return new URL(raw, pageUrl).href; } catch { return pageUrl; }
}

function rewriteTag(name: string, attrs: string, base: string, prefix: string): string | null {
  const tag = name.toLowerCase();
  if (tag === "base") return null; // replaced by the injected one
  if (tag === "meta") {
    const equiv = /\bhttp-equiv\s*=\s*["']?([\w-]+)/i.exec(attrs)?.[1]?.toLowerCase();
    // A meta CSP would re-impose exactly the policy the header filter removed.
    if (equiv === "content-security-policy" || equiv === "content-security-policy-report-only") return null;
  }
  const wanted = new Set(URL_ATTRS[tag] ?? []);
  const out = attrs.replace(
    /([^\s=/>"']+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>"']+))/g,
    (whole, rawName: string, _eq: string, _v: string, d?: string, sq?: string, bare?: string) => {
      const attr = rawName.toLowerCase();
      const value = decodeEntities(d ?? sq ?? bare ?? "");
      // SRI hashes cannot survive rewriting (CSS bodies change) and are keyed
      // to upstream bytes; drop them rather than let every stylesheet fail.
      if (attr === "integrity" || attr === "nonce") return "";
      if (attr === "target" && /^_(top|parent)$/i.test(value)) return `${rawName}="_self"`;
      if (attr === "style") return `${rawName}="${escapeAttr(rewriteCss(value, base, prefix))}"`;
      if (attr === "srcset" || attr === "imagesrcset") return `${rawName}="${escapeAttr(rewriteSrcset(value, base, prefix))}"`;
      if (tag === "meta" && attr === "content" && /http-equiv\s*=\s*["']?refresh/i.test(attrs)) {
        const r = /^(\s*\d+\s*[;,]\s*url\s*=\s*)(["']?)(.+?)\2\s*$/i.exec(value);
        return r ? `${rawName}="${escapeAttr(r[1] + proxify(r[3], base, prefix))}"` : whole;
      }
      if (wanted.has(attr)) return `${rawName}="${escapeAttr(proxify(value, base, prefix))}"`;
      return whole;
    },
  );
  return `<${name}${out}>`;
}

/** Rewrite a whole HTML document for the proxy and inject `headInject`
 *  (the <base> plus the runtime shim) at the top of <head>. Script and style
 *  bodies are not touched except that <style> bodies get CSS rewriting. */
export function rewriteHtml(html: string, pageUrl: string, prefix: string, headInject: string): string {
  const base = effectiveBase(html, pageUrl);
  const re = /<!--[\s\S]*?-->|<(script|style|textarea|title|noscript)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let injected = false;
  let body = html.replace(re, (whole, rawTag?: string, rawAttrs?: string, inner?: string, tag?: string, attrs?: string) => {
    if (whole.startsWith("<!--")) return whole;
    if (rawTag) {
      const open = rewriteTag(rawTag, rawAttrs ?? "", base, prefix) ?? "";
      const content = rawTag.toLowerCase() === "style" ? rewriteCss(inner ?? "", base, prefix) : inner ?? "";
      return `${open}${content}</${rawTag}>`;
    }
    const name = tag ?? "";
    const rewritten = rewriteTag(name, attrs ?? "", base, prefix);
    if (rewritten === null) return "";
    if (!injected && name.toLowerCase() === "head") {
      injected = true;
      return rewritten + headInject;
    }
    return rewritten;
  });
  if (!injected) {
    const htmlOpen = /<html\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(body);
    body = htmlOpen
      ? body.slice(0, htmlOpen.index + htmlOpen[0].length) + `<head>${headInject}</head>` + body.slice(htmlOpen.index + htmlOpen[0].length)
      : headInject + body;
  }
  return body;
}

/** The <base> tag plus the runtime shim, ready to inject. */
export function headInjection(finalUrl: string, prefix: string, docCookies: string): string {
  const cfg = JSON.stringify({ prefix, url: finalUrl, marker: DIR_MARKER, cookies: docCookies })
    .replace(/</g, "\\u003c");
  return `<base href="${escapeAttr(finalUrl)}"><script>${shimSource(cfg)}</script>`;
}

/** The runtime shim, as source. Runs first in the proxied page, before any of
 *  its own scripts, inside the opaque-origin sandbox. It patches the request
 *  APIs a page uses to fetch or navigate so dynamic URLs go through the proxy,
 *  gives the page in-memory stand-ins for document.cookie and Web Storage
 *  (both throw in an opaque origin, which breaks many sites), and reports the
 *  real URL and title to the Browser app via postMessage.
 *
 *  What it cannot do: location.assign/replace and `location.href = ...` are
 *  [LegacyUnforgeable] and cannot be patched, and ES module import specifiers
 *  starting with "/" resolve against the OS origin. Those navigations leave
 *  the proxy; the Browser app offers Cloud or Reader mode for such sites. */
export function shimSource(cfgJson: string): string {
  return `(function(){try{
var C=${cfgJson};var P=C.prefix,M=C.marker;
function enc(abs){var u;try{u=new URL(abs)}catch(e){return null}if(u.protocol!=="http:"&&u.protocol!=="https:")return null;var p=u.pathname||"/";if(p.charAt(p.length-1)==="/")p+=M;return P+"/"+u.protocol.slice(0,-1)+"/"+u.host+p+u.search+u.hash}
function px(raw){if(raw==null)return raw;var s=String(raw);if(s.indexOf(P+"/")===0)return s;if(/^\\s*(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(s))return s;var a;try{a=new URL(s,document.baseURI).href}catch(e){return s}return enc(a)||s}
function real(){var h=location.href;if(h.indexOf(P+"/")!==0)return C.url;var r=h.slice(P.length+1),hi=r.indexOf("#"),hash=hi>=0?r.slice(hi):"";if(hi>=0)r=r.slice(0,hi);var qi=r.indexOf("?"),q=qi>=0?r.slice(qi):"";if(qi>=0)r=r.slice(0,qi);var m=/^(https?)\\/([^\\/]+)(\\/.*)?$/.exec(r);if(!m)return C.url;var p=m[3]||"/";if(p==="/"+M)p="/";else if(p.slice(-M.length-1)==="/"+M)p=p.slice(0,-M.length);return m[1]+"://"+m[2]+p+q+hash}
var of=window.fetch;if(of){window.fetch=function(i,o){o=Object.assign({},o||{});if(!o.credentials)o.credentials="include";try{if(typeof i==="string"||i instanceof URL)i=px(String(i));else if(i&&i.url)i=new Request(px(i.url),i)}catch(e){}return of.call(this,i,o)}}
var X=window.XMLHttpRequest&&XMLHttpRequest.prototype;if(X){var xo=X.open;X.open=function(m,u){var a=Array.prototype.slice.call(arguments);a[1]=px(u);var r=xo.apply(this,a);try{this.withCredentials=true}catch(e){}return r}}
var wo=window.open;window.open=function(u,t,f){return wo.call(window,u==null?u:px(u),t,f)};
["pushState","replaceState"].forEach(function(k){var f=history[k];history[k]=function(s,t,u){var r=f.call(history,s,t,u==null?u:px(u));report();return r}});
var fs=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){try{this.setAttribute("action",px(this.getAttribute("action")||real()))}catch(e){}return fs.call(this)};
document.addEventListener("submit",function(e){var f=e.target;if(f&&f.getAttribute){var a=f.getAttribute("action");if(a==null||a.indexOf(P+"/")!==0)f.setAttribute("action",px(a||real()))}},true);
document.addEventListener("click",function(e){var n=e.target;while(n&&n.nodeType===1&&n.tagName!=="A"&&n.tagName!=="AREA")n=n.parentNode;if(!n||n.nodeType!==1)return;var h=n.getAttribute("href");if(h&&h.indexOf(P+"/")!==0){var p=px(h);if(p!==h)n.setAttribute("href",p)}var t=n.getAttribute("target");if(t==="_top"||t==="_parent")n.setAttribute("target","_self")},true);
var jar={};String(C.cookies||"").split(/;\\s*/).forEach(function(kv){var i=kv.indexOf("=");if(i>0)jar[kv.slice(0,i)]=kv.slice(i+1)});
try{Object.defineProperty(document,"cookie",{configurable:true,get:function(){return Object.keys(jar).map(function(k){return k+"="+jar[k]}).join("; ")},set:function(v){var s=String(v),first=s.split(";")[0],i=first.indexOf("=");if(i<=0)return;var k=first.slice(0,i).trim();if(/max-age=\\s*-?0\\b|max-age=\\s*-|expires=thu, 01 jan 1970/i.test(s))delete jar[k];else jar[k]=first.slice(i+1)}})}catch(e){}
function mem(){var d={};return{get length(){return Object.keys(d).length},key:function(i){return Object.keys(d)[i]||null},getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}}}}
["localStorage","sessionStorage"].forEach(function(k){try{window[k].length}catch(e){try{Object.defineProperty(window,k,{configurable:true,value:mem()})}catch(e2){}}});
var last="";function report(){try{var u=real(),t=document.title||"",s=u+"\\n"+t;if(s===last)return;last=s;parent.postMessage({type:"aios-web",url:u,title:t},"*")}catch(e){}}
addEventListener("DOMContentLoaded",report);addEventListener("load",report);addEventListener("popstate",report);addEventListener("hashchange",report);setInterval(report,1000);
}catch(e){}})();`;
}

/* ── Headers ────────────────────────────────────────────────────────────── */

/** Response headers never relayed from upstream. Framing and isolation
 *  policies are what this proxy exists to remove; the rest would either act on
 *  the OS's own origin (cookies, site data, HSTS, service workers) or be wrong
 *  after the body is re-encoded. */
const DROP_RESPONSE = new Set([
  "x-frame-options", "content-security-policy", "content-security-policy-report-only",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "set-cookie", "set-cookie2", "clear-site-data", "strict-transport-security", "service-worker-allowed",
  "report-to", "reporting-endpoints", "nel", "alt-svc", "permissions-policy", "origin-agent-cluster",
  "access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods",
  "access-control-allow-headers", "access-control-expose-headers", "access-control-max-age",
  "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "trailer",
  "location", "refresh", "link", "timing-allow-origin", "server-timing",
]);

/** Filter upstream response headers. `rewritten`: the body was changed, so
 *  length and encoding no longer apply. `decoded`: the fetch layer already
 *  decompressed the body, so Content-Encoding/Length would lie. */
export function filterResponseHeaders(
  entries: Array<[string, string]>,
  opts: { rewritten: boolean; decoded: boolean },
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (DROP_RESPONSE.has(key)) continue;
    if ((opts.rewritten || opts.decoded) && (key === "content-encoding" || key === "content-length")) continue;
    if (opts.rewritten && (key === "etag" || key === "content-md5" || key === "digest")) continue;
    out.push([k, v]);
  }
  out.push(["content-security-policy", SANDBOX_CSP]);
  return out;
}

/** CORS headers for an /api/web response. The sandboxed page has the opaque
 *  origin "null"; its shim sends credentialed requests (so the cookie jar
 *  travels), which requires echoing the origin rather than "*". Any other
 *  caller gets "*" without credentials. */
export function corsHeaders(requestOrigin: string | null): Array<[string, string]> {
  if (requestOrigin === "null") {
    return [["access-control-allow-origin", "null"], ["access-control-allow-credentials", "true"], ["vary", "origin"]];
  }
  return [["access-control-allow-origin", "*"], ["vary", "origin"]];
}

/** Can a page with these headers be shown in a cross-origin iframe?
 *  A CSP frame-ancestors directive, when present, overrides X-Frame-Options. */
export function frameVerdict(xfo: string | null, csp: string | null): { frameable: boolean; reason: string } {
  if (csp) {
    const directives = csp.split(/[,;]/).map((d) => d.trim().toLowerCase());
    const fa = directives.filter((d) => d.startsWith("frame-ancestors"));
    if (fa.length) {
      // Every policy must allow us (multiple policies intersect).
      const ok = fa.every((d) => {
        const srcs = d.split(/\s+/).slice(1);
        return srcs.includes("*") || srcs.includes("https:");
      });
      return ok
        ? { frameable: true, reason: "frame-ancestors allows any site" }
        : { frameable: false, reason: `Content-Security-Policy: ${fa[0]}` };
    }
  }
  if (xfo) {
    const v = xfo.trim().toLowerCase();
    if (v === "deny" || v === "sameorigin" || v.startsWith("allow-from")) {
      return { frameable: false, reason: `X-Frame-Options: ${xfo.trim()}` };
    }
  }
  return { frameable: true, reason: "no framing restriction" };
}

/* ── Cookie jar ─────────────────────────────────────────────────────────── */

/* A proxied page cannot keep cookies itself: its origin is opaque, and in
   any case upstream cookies would land on the OS's origin. Instead the route
   keeps upstream cookies in ONE cookie on our origin, scoped by Path to this
   Browser session (/api/web/<sid>/), HttpOnly, and namespaced per cookie
   domain. Deliberate limits, stated plainly:
     - total size is capped at MAX_JAR_CHARS; the oldest entries are evicted;
     - cookie Path attributes are ignored (a cookie applies to its whole host);
     - every site visited in one Browser window shares the jar, so a page in
       Web mode could make proxied requests that carry another site's cookies.
       Web mode is for reading; sign in to things in Cloud mode. */

export interface JarEntry { v: string; h?: 1; e?: number }
export type Jar = Record<string, Record<string, JarEntry>>;

export function parseJar(raw: string | undefined | null): Jar {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Jar : {};
  } catch {
    return {};
  }
}

export function serializeJar(jar: Jar): string {
  const copy: Jar = JSON.parse(JSON.stringify(jar));
  let s = encodeURIComponent(JSON.stringify(copy));
  // Evict oldest-first (insertion order) until it fits.
  while (s.length > MAX_JAR_CHARS) {
    const domains = Object.keys(copy);
    if (!domains.length) return "";
    const first = domains[0];
    const names = Object.keys(copy[first]);
    if (names.length <= 1) delete copy[first];
    else delete copy[first][names[0]];
    s = encodeURIComponent(JSON.stringify(copy));
  }
  return s;
}

/** Apply upstream Set-Cookie headers for a response from `host`. `nowSec` is
 *  passed in (this module never reads the clock). Returns a new jar. */
export function applySetCookies(jar: Jar, host: string, setCookies: string[], nowSec: number): Jar {
  const next: Jar = JSON.parse(JSON.stringify(jar));
  const h = host.toLowerCase();
  for (const line of setCookies) {
    const parts = line.split(";");
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    let domain = h;
    let foreign = false;
    let httpOnly = false;
    let expires: number | undefined;
    for (const p of parts) {
      const [k, ...rest] = p.split("=");
      const key = k.trim().toLowerCase();
      const val = rest.join("=").trim();
      if (key === "domain" && val) {
        const d = val.replace(/^\./, "").toLowerCase();
        // A host may only set cookies for itself or a parent domain; anything
        // else is rejected outright, as a browser would.
        if (h === d || h.endsWith(`.${d}`)) domain = d;
        else foreign = true;
      } else if (key === "httponly") httpOnly = true;
      else if (key === "max-age" && /^-?\d+$/.test(val)) expires = nowSec + Number(val);
      else if (key === "expires" && expires === undefined) {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
      }
    }
    if (foreign) continue;
    const bucket = next[domain] ?? {};
    if (expires !== undefined && expires <= nowSec) {
      delete bucket[name];
    } else {
      delete bucket[name]; // re-insert so recency drives eviction order
      bucket[name] = { v: value, ...(httpOnly ? { h: 1 as const } : {}), ...(expires !== undefined ? { e: expires } : {}) };
    }
    if (Object.keys(bucket).length) {
      delete next[domain];
      next[domain] = bucket;
    } else delete next[domain];
  }
  return next;
}

/** The Cookie header value to send upstream to `host`. With `jsVisibleOnly`,
 *  HttpOnly cookies are left out (used to seed the page's document.cookie). */
export function cookieHeaderFor(jar: Jar, host: string, nowSec: number, jsVisibleOnly = false): string {
  const h = host.toLowerCase();
  const pairs: string[] = [];
  for (const [domain, bucket] of Object.entries(jar)) {
    if (h !== domain && !h.endsWith(`.${domain}`)) continue;
    for (const [name, c] of Object.entries(bucket)) {
      if (c.e !== undefined && c.e <= nowSec) continue;
      if (jsVisibleOnly && c.h) continue;
      pairs.push(`${name}=${c.v}`);
    }
  }
  return pairs.join("; ");
}

/** Session ids are client-generated random tokens; anything else is refused. */
export function validSid(sid: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(sid);
}

/** Pull a charset out of a Content-Type (default utf-8). */
export function charsetOf(contentType: string): string {
  return /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
}
