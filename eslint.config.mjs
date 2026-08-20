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
    // Vendored third-party FaceTec Browser SDK v10.1.9 static assets —
    // not project source, never hand-edited (see lib/facetec/browserSdkTypes.ts
    // for the corresponding hand-transcribed type declarations).
    "public/facetec/**",
  ]),
]);

export default eslintConfig;
