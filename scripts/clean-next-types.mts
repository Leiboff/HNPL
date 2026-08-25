// Deletes Next's GENERATED route-type directories before `tsc --noEmit`.
//
// Why this exists:
//
// tsconfig.json deliberately includes `.next/types/**/*.ts`, which is how
// Next type-checks route handlers and page props. Those files are
// generated at build time and are NOT cleaned up when a route is deleted.
//
// So removing a route leaves behind a validator referencing a page that
// no longer exists:
//
//   .next/types/validator.ts:449 - error TS2307: Cannot find module
//   '../../app/onboarding/liveness/page.js'
//
// That fails `pnpm typecheck`, which is wired to the pre-commit hook —
// meaning deleting a route blocks the very commit that deletes it, with
// an error pointing at generated code the developer never wrote. It cost
// a confusing debugging detour once; this makes it not happen again.
//
// Deleting the directory is safe: it is gitignored, and Next regenerates
// it on the next dev server start or build. `pnpm build` runs typecheck
// BEFORE `next build`, and next build performs its own route type
// checking afterwards, so nothing is lost.
//
// Written in Node rather than as a shell one-liner because the repo is
// developed on Windows and CI is Linux — `rm -rf` is not portable, and
// adding rimraf for one line is not worth a dependency.

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const targets = ['.next/types', '.next/dev/types'];

for (const dir of targets) {
  rmSync(resolve(process.cwd(), dir), { recursive: true, force: true });
}
