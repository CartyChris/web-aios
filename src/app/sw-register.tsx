"use client";

import { useEffect } from "react";

/** Registers the service worker so the desktop installs as a PWA and opens
 *  offline. Registration is deferred to load so it never competes with the
 *  first paint. */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("[sw] registration failed:", e));
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
