import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from './vitest.config';

// Database-backed tests are intentionally isolated from the unit/UI suite.
// New database tests should use the `.pglite.test.ts` suffix; the explicit
// entries below retain coverage for older tests that predate that convention.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        '**/*.pglite.test.ts',
        'supabase/migrations/**/*.test.ts',
        'app/practice/pos/devices/pinRoundTrip.test.ts',
        'lib/security/rateLimit.buckets.test.ts',
      ],
      // Database files already run serially through the package script. A
      // single worker prevents concurrent PGlite WASM instances from
      // starving each other on small CI runners.
      maxWorkers: 1,
    },
  }),
);
