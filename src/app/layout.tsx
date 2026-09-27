import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorker } from "./sw-register";

export const metadata: Metadata = {
  title: "Web-AIOS",
  description: "A fully customizable AI/Agent desktop operating system for the web.",
  applicationName: "Web-AIOS",
  manifest: "/manifest.webmanifest",
  // The Apple web-app tags are written by hand in <head> below: Next's
  // appleWebApp always adds a status-bar-style tag ("default" when unset),
  // and two conflicting tags leave iOS to pick one.

  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false, date: false, address: false, email: false },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The OS supplies its own zoom control; pinch-zooming a desktop shell only
  // ever strands the user mid-gesture.
  maximumScale: 1,
  userScalable: false,
  // Required for env(safe-area-inset-*) to report real values on iPhone.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#07111f" },
    { media: "(prefers-color-scheme: light)", color: "#f4f7fb" },
  ],
};

const BOOT_SCRIPT = `(function(){try{var d=document.documentElement,n=navigator;var sa=n.standalone===true||matchMedia('(display-mode: standalone)').matches||matchMedia('(display-mode: fullscreen)').matches;d.dataset.displayMode=sa?'standalone':'browser';var p='translucent';try{var st=JSON.parse(localStorage.getItem('webaios.settings.v1')||'{}').state;if(st&&st.statusBar==='solid')p='solid';}catch(e){}var m=document.createElement('meta');m.name='apple-mobile-web-app-status-bar-style';m.id='os-status-bar';m.content=p==='solid'?'black':'black-translucent';document.head.appendChild(m);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs during head parsing, before first paint: marks an installed app
            (so the CSS can use the large viewport at once, with no flash of a
            short screen) and adds the chosen Apple status-bar style. The
            script creates that tag itself: a tag React rendered would be
            re-created by hydration with its original content (seen: two
            conflicting tags), since the script had changed it. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Web-AIOS" />
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
