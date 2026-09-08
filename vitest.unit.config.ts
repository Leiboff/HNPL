import { defineConfig, mergeConfig } from 'vitest/config';

import baseConfig from './vitest.config';

// Keep the fast suite independent from tests that boot an in-process
// PostgreSQL database. This gives CI a useful result even if a database test
// leaks a worker or exhausts its runtime budget.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        '**/*.pglite.test.ts',
        'supabase/migrations/**/*.test.ts',
        'app/practice/pos/devices/pinRoundTrip.test.ts',
        'lib/security/rateLimit.buckets.test.ts',
      ],
    },
  }),
);
