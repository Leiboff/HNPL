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
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
