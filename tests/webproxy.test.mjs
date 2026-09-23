/**
 * Web mode (the Browser's rewriting proxy). The pure rewriting module decides
 * what upstream bytes become; the security properties that keep a proxied
 * page away from the OS's localStorage are pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIR_MARKER, SANDBOX_CSP, SANDBOX_TOKENS, encodeTarget, decodeTarget, proxify, unproxify, rewriteCss,
  rewriteSrcset, rewriteHtml, headInjection, filterResponseHeaders, corsHeaders, frameVerdict,
  parseJar, serializeJar, applySetCookies, cookieHeaderFor, validSid, effectiveBase, MAX_JAR_CHARS,
} from "../.test-build/webproxy.js";

const P = "https://os.example/api/web/sid12345";
const BASE = "https://site.test/a/b/page.html";

test("the sandbox never grants same-origin or top navigation", () => {
  assert.ok(SANDBOX_CSP.startsWith("sandbox "));
  assert.ok(SANDBOX_TOKENS.includes("allow-scripts"));
  assert.ok(!SANDBOX_TOKENS.includes("allow-same-origin"), "allow-same-origin would expose localStorage keys");
  assert.ok(!SANDBOX_TOKENS.includes("allow-top-navigation"));
});

test("every filtered response carries the sandbox CSP and drops framing/isolation/cookie headers", () => {
  const out = filterResponseHeaders([
    ["X-Frame-Options", "DENY"],
    ["Content-Security-Policy", "frame-ancestors 'none'"],
    ["Content-Security-Policy-Report-Only", "default-src 'self'"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Embedder-Policy", "require-corp"],
    ["Set-Cookie", "a=b"],
    ["Clear-Site-Data", "\"storage\""],
    ["Strict-Transport-Security", "max-age=1"],
    ["Content-Type", "text/html"],
    ["Content-Encoding", "gzip"],
    ["Content-Length", "100"],
    ["Cache-Control", "max-age=60"],
  ], { rewritten: true, decoded: true });
  const keys = out.map(([k]) => k.toLowerCase());
  for (const gone of ["x-frame-options", "content-security-policy-report-only", "cross-origin-opener-policy", "cross-origin-embedder-policy", "set-cookie", "clear-site-data", "strict-transport-security", "content-encoding", "content-length"]) {
    assert.ok(!keys.includes(gone), `${gone} must be dropped`);
  }
  const csp = out.filter(([k]) => k.toLowerCase() === "content-security-policy");
  assert.deepEqual(csp, [["content-security-policy", SANDBOX_CSP]], "exactly one CSP: ours");
  assert.ok(keys.includes("content-type") && keys.includes("cache-control"));
  // A streamed, untouched body keeps its length (Range/media need it).
  const passthrough = filterResponseHeaders([["Content-Length", "5"], ["Content-Range", "bytes 0-4/10"]], { rewritten: false, decoded: false });
  assert.ok(passthrough.some(([k]) => k === "Content-Length"));
  assert.ok(passthrough.some(([k]) => k === "Content-Range"));
});

test("CORS: the opaque origin gets credentialed access, everyone else gets * without credentials", () => {
  assert.deepEqual(corsHeaders("null").slice(0, 2), [["access-control-allow-origin", "null"], ["access-control-allow-credentials", "true"]]);
  const other = corsHeaders("https://evil.test");
  assert.equal(other[0][1], "*");
  assert.ok(!other.some(([k]) => k === "access-control-allow-credentials"));
});

test("target encoding round-trips, including trailing slashes, ports and queries", () => {
  for (const u of ["https://site.test/", "https://site.test/docs/", "https://site.test/a/b.js?x=1&y=2", "http://site.test:8080/p", "https://site.test/a%20b"]) {
    const enc = encodeTarget(u);
    assert.ok(enc, u);
    const q = enc.indexOf("?");
    assert.equal(decodeTarget(q >= 0 ? enc.slice(0, q) : enc, q >= 0 ? enc.slice(q) : ""), u);
  }
  assert.equal(encodeTarget("https://site.test/docs/"), `https/site.test/docs/${DIR_MARKER}`);
  assert.equal(encodeTarget("javascript:alert(1)"), null);
  assert.equal(encodeTarget("file:///etc/passwd"), null);
  assert.equal(decodeTarget("ftp/site.test/x", ""), null);
});

test("proxify resolves against the base, keeps fragments and skips non-web schemes", () => {
  assert.equal(proxify("c.png", BASE, P), `${P}/https/site.test/a/b/c.png`);
  assert.equal(proxify("/root.css", BASE, P), `${P}/https/site.test/root.css`);
  assert.equal(proxify("//cdn.test/x.js", BASE, P), `${P}/https/cdn.test/x.js`);
  assert.equal(proxify("/p#sec", BASE, P), `${P}/https/site.test/p#sec`);
  for (const keep of ["#top", "data:image/png;base64,AA", "javascript:void(0)", "mailto:a@b.c", "blob:https://x/1"]) {
    assert.equal(proxify(keep, BASE, P), keep);
  }
  const once = proxify("c.png", BASE, P);
  assert.equal(proxify(once, BASE, P), once, "idempotent");
  assert.equal(unproxify(`${P}/https/site.test/docs/${DIR_MARKER}?q=1#h`, P), "https://site.test/docs/?q=1#h");
  assert.equal(unproxify("https://elsewhere/x", P), null);
});

test("CSS url() and @import are rewritten", () => {
  const css = `@import "theme.css"; .a{background:url('img/bg.png')} .b{src:url(/f.woff2)} .c{background:url(data:image/png;base64,AA)}`;
  const out = rewriteCss(css, BASE, P);
  assert.ok(out.includes(`@import "${P}/https/site.test/a/b/theme.css"`));
  assert.ok(out.includes(`url('${P}/https/site.test/a/b/img/bg.png')`));
  assert.ok(out.includes(`url(${P}/https/site.test/f.woff2)`));
  assert.ok(out.includes("url(data:image/png;base64,AA)"));
});

test("srcset candidates are each rewritten", () => {
  assert.equal(rewriteSrcset("a.png 1x, /b.png 2x", BASE, P), `${P}/https/site.test/a/b/a.png 1x, ${P}/https/site.test/b.png 2x`);
});

test("HTML: links, sources, forms, styles, meta refresh; CSP meta, base and SRI removed; shim injected first in head", () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><base href="/a/"><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><meta http-equiv="refresh" content="3; url=/next"><link rel="stylesheet" href="s.css" integrity="sha384-x"><style>.x{background:url(bg.png)}</style><script src="app.js"></script><script>var s = '<a href="/raw">';</script></head>
<body><a href="/x?a=1&amp;b=2" target="_top">x</a><img src="i.png" srcset="i.png 1x, i2.png 2x"><form action="/search" method="post"></form><div style="background:url(/d.png)"></div><a href="#frag">f</a><video poster="p.jpg" src="v.mp4"></video></body></html>`;
  const inject = headInjection("https://site.test/a/page", P, "");
  const out = rewriteHtml(html, "https://site.test/a/page", P, inject);
  // Injection is the first thing inside <head>.
  assert.ok(out.includes(`<head>${inject}`), "shim must run before page scripts");
  assert.ok(out.includes('<base href="https://site.test/a/page">'));
  assert.ok(!/<base href="\/a\/"/.test(out), "the page's own base tag is replaced");
  assert.ok(!/http-equiv="Content-Security-Policy"/i.test(out), "meta CSP removed");
  assert.ok(!out.includes("integrity="), "SRI removed");
  // The page's own <base href="/a/"> sets the resolution base.
  assert.ok(out.includes(`href="${P}/https/site.test/a/s.css"`));
  assert.ok(out.includes(`src="${P}/https/site.test/a/app.js"`));
  assert.ok(out.includes(`url(${P}/https/site.test/a/bg.png)`));
  assert.ok(out.includes(`content="3; url=${P}/https/site.test/next"`));
  assert.ok(out.includes(`href="${P}/https/site.test/x?a=1&amp;b=2"`), "entities decoded then re-escaped");
  assert.ok(out.includes('target="_self"'), "_top would be blocked by the sandbox");
  assert.ok(out.includes(`action="${P}/https/site.test/search"`));
  assert.ok(out.includes(`srcset="${P}/https/site.test/a/i.png 1x, ${P}/https/site.test/a/i2.png 2x"`));
  assert.ok(out.includes(`style="background:url(${P}/https/site.test/d.png)"`));
  assert.ok(out.includes('href="#frag"'));
  assert.ok(out.includes(`poster="${P}/https/site.test/a/p.jpg"`));
  // Script bodies are left alone.
  assert.ok(out.includes(`var s = '<a href="/raw">';`));
});

test("HTML without a head still gets the shim", () => {
  const out = rewriteHtml("<html><body>hi</body></html>", BASE, P, "<!--INJ-->");
  assert.ok(out.startsWith("<html><head><!--INJ--></head>"));
  assert.ok(rewriteHtml("hello", BASE, P, "<!--INJ-->").startsWith("<!--INJ-->"));
  assert.ok(!rewriteHtml("<header><head>", BASE, P, "X").startsWith("<header>X"), "<header> is not <head>");
});

test("effectiveBase honours a page's own base tag", () => {
  assert.equal(effectiveBase('<base href="https://cdn.test/root/">', BASE), "https://cdn.test/root/");
  assert.equal(effectiveBase("<p>no base</p>", BASE), BASE);
});

test("the injected config cannot break out of its script tag", () => {
  const inj = headInjection("https://site.test/</script><script>alert(1)</script>", P, "");
  assert.equal(inj.split("</script>").length, 2, "only the shim's own closing tag");
  assert.ok(inj.includes("postMessage"), "the shim reports URL and title to the Browser");
  assert.ok(inj.includes('credentials="include"'), "shim fetches carry the cookie jar");
});

test("frame verdicts: XFO and frame-ancestors", () => {
  assert.equal(frameVerdict(null, null).frameable, true);
  assert.equal(frameVerdict("DENY", null).frameable, false);
  assert.equal(frameVerdict("sameorigin", null).frameable, false);
  assert.equal(frameVerdict(null, "default-src 'self'; frame-ancestors 'self'").frameable, false);
  assert.equal(frameVerdict(null, "frame-ancestors 'none'").frameable, false);
  assert.equal(frameVerdict("DENY", "frame-ancestors *").frameable, true, "CSP overrides XFO");
  assert.equal(frameVerdict(null, "script-src 'self'").frameable, true);
});

test("cookie jar: per-domain, expiry, httpOnly, parent-domain rules, size cap", () => {
  const now = 1_000_000;
  let jar = applySetCookies({}, "www.site.test", [
    "sid=abc; Path=/; HttpOnly; Secure",
    "pref=dark; Domain=.site.test; Max-Age=3600",
    "evil=1; Domain=other.test",
  ], now);
  assert.equal(cookieHeaderFor(jar, "www.site.test", now), "sid=abc; pref=dark");
  assert.equal(cookieHeaderFor(jar, "api.site.test", now), "pref=dark", "domain cookie reaches subdomains");
  assert.equal(cookieHeaderFor(jar, "other.test", now), "", "a host cannot set cookies for an unrelated domain");
  assert.equal(cookieHeaderFor(jar, "www.site.test", now, true), "pref=dark", "httpOnly hidden from the page");
  assert.equal(cookieHeaderFor(jar, "www.site.test", now + 7200), "sid=abc", "expired cookie not sent");
  jar = applySetCookies(jar, "www.site.test", ["sid=; Max-Age=0"], now);
  assert.equal(cookieHeaderFor(jar, "www.site.test", now), "pref=dark", "Max-Age=0 deletes");
  assert.deepEqual(parseJar(serializeJar(jar)), jar, "round trip");
  assert.deepEqual(parseJar("%%%garbage"), {});
  let big = {};
  for (let i = 0; i < 80; i++) big = applySetCookies(big, `h${i}.test`, [`c=${"x".repeat(100)}`], now);
  const s = serializeJar(big);
  assert.ok(s.length <= MAX_JAR_CHARS);
  const kept = parseJar(s);
  assert.ok(kept["h79.test"] && !kept["h0.test"], "oldest evicted first");
});

test("session ids are validated", () => {
  assert.equal(validSid("abcDEF12_-"), true);
  for (const bad of ["", "short", "../../etc", "a".repeat(65), "has space1"]) assert.equal(validSid(bad), false, bad);
});
