import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    // Default to happy-dom so React component tests have a DOM available
    // without paying the cost on pure-logic tests (they use `jsdom: false`
    // in-file if needed). happy-dom is lighter than jsdom.
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    // Vitest's 10s default is too tight for the pglite (real-Postgres)
    // suites and made a full run flakily red — a DIFFERENT subset of files
    // failed each time with "Hook timed out in 10000ms", always inside a
    // hook calling `new PGlite()`.
    //
    // Measured on this 4-core box: ONE PGlite boot costs ~2.6-4.0s of
    // CPU-bound WASM compile + initdb, and it does NOT amortise across
    // instances in a process. There are 9 pglite test files and several
    // boot one instance PER TEST, so with ~3 files running concurrently
    // the boots contend for 4 cores and routinely blow past 10s. Nothing
    // was actually broken or hanging — the hook just needed longer than
    // the default allows.
    //
    // Raising this only changes how long we WAIT for a hook before calling
    // it hung; it cannot make a failing assertion pass. Kept generous so a
    // cold or slower CI machine has headroom too.
    hookTimeout: 60_000,
    // The same contention, in TESTS rather than hooks — the other half of the
    // problem above, which raising hookTimeout alone left in place.
    //
    // The repo has a family of tests that walk `app` + `lib` and regex every
    // source file (app/no-geocoding-api.test.ts and friends). Each such scan
    // costs ~0.9s of pure CPU when the box is idle. Under a full run they are
    // competing with the pglite WASM boots described above, and the SAME
    // scans stretch past 5s — so a full run went red with
    // "Test timed out in 5000ms" on an arbitrary two or three of them, while
    // every one of them passed when its file was run on its own.
    //
    // The tell that this is contention and not a broken assertion: which
    // tests fail changes from run to run, exactly as it did for the hooks.
    // Confirmed directly by re-running the same file with --testTimeout=800,
    // which fails a DIFFERENT pair with the identical timeout error.
    //
    // Same argument as hookTimeout: this only changes how long we wait before
    // declaring a test hung, so it cannot turn a genuine failure green. 30s
    // is well beyond the ~0.9s these scans actually need while still catching
    // a real hang.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
