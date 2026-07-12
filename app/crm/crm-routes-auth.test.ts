import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── CRM route auth — server-side gate pattern ────────────────────────
//
// Mirrors admin-routes-auth.test.ts. Every /crm/* page.tsx must:
//   • import requireConfirmedUser OR requireSalesOrAdmin
//   • read profiles.role
//   • allow ONLY role IN ('sales','admin')  — everyone else is redirected
//
// The CRM layout runs the check once; page.tsx repeats it belt-and-braces
// so a future refactor that relocates a route can't silently drop the gate.

const ROOT = resolve(process.cwd());
function readSrc(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

const CRM_PAGES = [
  'app/crm/layout.tsx',
  'app/crm/page.tsx',
  'app/crm/leads/page.tsx',
  'app/crm/leads/[id]/page.tsx',
  'app/crm/leads/new/page.tsx',
  'app/crm/board/page.tsx',
  'app/crm/import/page.tsx',
];

describe('CRM routes — server-side sales-or-admin auth pattern', () => {
  it.each(CRM_PAGES)('%s imports requireConfirmedUser or requireSalesOrAdmin', (path) => {
    const src = readSrc(path);
    expect(
      /from\s+['"]@\/lib\/auth\/requireConfirmedUser['"]/.test(src) ||
      /from\s+['"]@\/lib\/auth\/requireSalesOrAdmin['"]/.test(src),
    ).toBe(true);
  });

  const PAGES_WITH_ROLE_CHECK = CRM_PAGES.filter(p => p !== 'app/crm/layout.tsx');

  it.each(PAGES_WITH_ROLE_CHECK)('%s only allows role IN (sales, admin) and redirects everyone else', (path) => {
    const src = readSrc(path);
    // The idiomatic form we use across CRM pages:
    //   if (profile?.role !== 'sales' && profile?.role !== 'admin') { … redirect(…) }
    expect(src).toMatch(/profile\?\.role\s*!==\s*['"]sales['"]/);
    expect(src).toMatch(/profile\?\.role\s*!==\s*['"]admin['"]/);
    expect(src).toMatch(/redirect\s*\(/);
  });
});

describe('CRM server actions — server-side sales-or-admin auth pattern', () => {
  const ACTIONS = [
    'app/crm/leads/actions.ts',
    'app/crm/import/actions.ts',
    'app/admin/sales-team/actions.ts',
  ];

  it.each(ACTIONS)('%s enforces role check before mutating', (path) => {
    const src = readSrc(path);
    // Every CRM action file declares a guard that inspects profile.role
    // and returns early for the wrong role.
    expect(src).toMatch(/profile\?\.role/);
    expect(src).toMatch(/Unauthorized/i);
  });

  it('app/crm/leads/actions.ts checks both "sales" and "admin"', () => {
    const src = readSrc('app/crm/leads/actions.ts');
    expect(src).toMatch(/['"]sales['"]/);
    expect(src).toMatch(/['"]admin['"]/);
  });

  it('app/admin/sales-team/actions.ts gates on admin only (grant/revoke sales)', () => {
    const src = readSrc('app/admin/sales-team/actions.ts');
    expect(src).toMatch(/profile\?\.role\s*!==\s*['"]admin['"]/);
  });
});

describe('lib/auth/requireSalesOrAdmin — the gate helper', () => {
  it('rejects non-sales / non-admin roles by redirecting to their portal', () => {
    const src = readSrc('lib/auth/requireSalesOrAdmin.ts');
    expect(src).toMatch(/role\s*!==\s*['"]sales['"]/);
    expect(src).toMatch(/role\s*!==\s*['"]admin['"]/);
    // Redirects for the four other role families the app currently ships.
    expect(src).toMatch(/redirect\s*\(\s*['"]\/patient['"]\s*\)/);
    expect(src).toMatch(/redirect\s*\(\s*['"]\/practice['"]\s*\)/);
    expect(src).toMatch(/redirect\s*\(\s*['"]\/provider['"]\s*\)/);
    expect(src).toMatch(/redirect\s*\(\s*['"]\/login['"]\s*\)/);
  });
});
