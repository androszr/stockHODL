import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored tooling we do not author — gitignored, but ESLint still walks it.
    ".gitnexus/**",
    ".agents/**",
    // The native client (docs/ios-native.md A.2). Stated explicitly rather
    // than left to "there is no TypeScript in there": the first .md, .json or
    // config file dropped under ios/ would start pulling ESLint plugins into a
    // tree they know nothing about.
    "ios/**",
  ]),
]);

export default eslintConfig;
