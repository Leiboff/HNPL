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
    // The verified Experian reference implementation, committed verbatim as
    // the record of what was learned against the live service. It is an
    // artefact, not part of the program — tsconfig.json and vitest.config.ts
    // exclude it for the same reason, and linting a file nobody may edit only
    // produces findings nobody may act on.
    "docs/**",
  ]),
]);

export default eslintConfig;
