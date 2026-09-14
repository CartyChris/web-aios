/* Web-AIOS service worker.
 *
 * Strategy is deliberately conservative:
 *  - Navigations: network-first with a cached shell fallback, so a deploy is
 *    picked up immediately but the app still opens on a plane.
 *  - Static assets: stale-while-revalidate — instant, and refreshed in the
 *    background.
 *  - API calls: never cached. A cached AI response or a cached proxy fetch
 *    would be actively wrong.
 */
const VERSION = "webaios-v1";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const PRECACHE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never serve a stale model response or a stale proxied page.
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r ?? new Response("Offline", { status: 503 }))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(ASSETS).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});
