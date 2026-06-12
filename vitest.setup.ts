import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Auto-cleanup the DOM between tests. Without this, render() output from
// one test bleeds into the next via the shared document body, and queries
// like getByRole('radio') return matches from previous renders.
afterEach(() => { cleanup(); });
