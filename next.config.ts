import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The desktop shell is a single client-rendered surface; keep the server
  // bundle lean and let every app chunk load on demand.
  // Pin the workspace root: without this, Turbopack walks up to the home
  // directory looking for a lockfile and infers the wrong project.
  turbopack: { root: path.resolve(import.meta.dirname) },
  experimental: { optimizePackageImports: ["lucide-react"] },
};

export default nextConfig;
