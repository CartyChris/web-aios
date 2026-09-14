import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/** eslint-config-next 16 ships native flat config, so no FlatCompat shim. */
const config = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [".next/**", "node_modules/**", "public/sw.js", "next-env.d.ts", ".test-build/**"],
  },
];

export default config;
