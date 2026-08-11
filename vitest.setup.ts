import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Auto-cleanup the DOM between tests. Without this, render() output from
// one test bleeds into the next via the shared document body, and queries
// like getByRole('radio') return matches from previous renders.
afterEach(() => { cleanup(); });

// Testing Library's default asyncUtilTimeout is 1000ms, which is tuned for
// an idle machine. A full run saturates all cores (many happy-dom workers
// plus the pglite suites each booting a Postgres-in-WASM), and under that
// load a React state update + effect flush can take longer than a second —
// so `waitFor`/`findBy*` failed spuriously on a DIFFERENT component test
// each run while every one of them passed in isolation. Same root shape as
// the hookTimeout bump in vitest.config.ts: an idle-machine default, not a
// real defect.
//
// This cannot mask a genuine failure — waitFor RETRIES the assertion until
// it passes or the timeout elapses, so a permanently-wrong assertion still
// fails, just after a longer wait.
configure({ asyncUtilTimeout: 15_000 });
