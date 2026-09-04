import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Server-side admin authorization regression ─────────────────────────────
//
// Every page under /admin must enforce admin auth server-side — hiding
// the link in the nav is not enough. The /admin/layout.tsx runs the
// check (belt-and-braces for everything underneath), and we ALSO repeat
// the check on each route page so a future change that moves the route
// can't accidentally drop the guard.
//
// This test grep-verifies the pattern on every admin page.tsx.

const ROOT = resolve(process.cwd());

function readSrc(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const ADMIN_PAGES = [
  'app/admin/layout.tsx',
  'app/admin/page.tsx',
  'app/admin/collections/page.tsx',
  'app/admin/collections/[paymentId]/page.tsx',
  'app/admin/collections/cron/page.tsx',
  'app/admin/customers/page.tsx',
  'app/admin/customers/[patientId]/page.tsx',
  'app/admin/payouts/page.tsx',
  'app/admin/practices/page.tsx',
  'app/admin/practices/[id]/page.tsx',
  // The privileged-action log (audit A-12). Every row on it is an admin
  // action against a practice, a customer or the money — so it is the LAST
  // page that should be reachable by a demoted account.
  'app/admin/audit/page.tsx',
  // The fraud review queue and the kill switches (audit S-07). Clearing a
  // review lets a held subject transact and releasing a kill switch restarts
  // credit issuance platform-wide, so a demoted account reaching this page
  // would be worse than reaching the audit log.
  'app/admin/risk/page.tsx',
];

describe('admin routes — server-side admin auth pattern', () => {
  it.each(ADMIN_PAGES)('%s imports requireConfirmedUser', (path) => {
    const src = readSrc(path);
    expect(src).toMatch(/from\s+['"]@\/lib\/auth\/requireConfirmedUser['"]/);
    expect(src).toMatch(/requireConfirmedUser\s*\(/);
  });

  // The layout is the canonical place. Every PAGE other than the layout
  // also repeats the role check — the belt-and-braces layer.
  const PAGES_WITH_ROLE_CHECK = ADMIN_PAGES.filter(
    (p) => p !== 'app/admin/layout.tsx',
  );

  it.each(PAGES_WITH_ROLE_CHECK)('%s checks profile.role !== "admin" and redirects', (path) => {
    const src = readSrc(path);
    expect(src).toMatch(/profile\?\.role\s*!==\s*['"]admin['"]/);
    expect(src).toMatch(/redirect\s*\(/);
  });
});

describe('admin server actions — server-side admin auth pattern', () => {
  // Each action file declares a guardAdmin / verifyAdmin helper that
  // returns ok:false / unauthorized for non-admin callers BEFORE any
  // database write. The helper variant differs slightly per file
  // (guardAdmin vs verifyAdmin); we just verify the role check is
  // present in source.
  const ADMIN_ACTIONS = [
    'app/admin/collections/actions.ts',
    'app/admin/payouts/actions.ts',
    'app/admin/practices/actions.ts',
    'app/admin/risk/actions.ts',
  ];

  it.each(ADMIN_ACTIONS)('%s enforces profile.role check before mutating', (path) => {
    const src = readSrc(path);
    expect(src).toMatch(/['"]admin['"]/);
    expect(src).toMatch(/Unauthorized/);
  });
});
