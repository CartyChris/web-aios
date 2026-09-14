import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorker } from "./sw-register";

export const metadata: Metadata = {
  title: "Web-AIOS",
  description: "A fully customizable AI/Agent desktop operating system for the web.",
  applicationName: "Web-AIOS",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Web-AIOS",
    // "black-translucent" is what lets the wallpaper run under the Dynamic
    // Island on an iPhone instead of leaving a dead black bar.
    statusBarStyle: "black-translucent",
  },
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
