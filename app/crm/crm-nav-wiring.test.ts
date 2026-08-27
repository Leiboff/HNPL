import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── CRM nav wiring — admins reach the CRM from AdminNav ─────────────
//
// The CRM has its own /crm shell + nav for sales users. Admin users see
// the CRM link inside AdminNav so they can walk into the same surface
// without switching sessions. Sales users NEVER see AdminNav (the
// admin layout gate rejects role='sales'); they land on /crm directly
// via the login → dashboard router or the /crm URL.

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

describe('AdminNav wiring for CRM + sales team', () => {
  const SRC = read('app/admin/AdminNav.tsx');

  it('has a /crm link', () => {
    expect(SRC).toMatch(/href:\s*['"]\/crm['"]/);
    expect(SRC).toMatch(/label:\s*['"]CRM['"]/);
  });

  it('has a /admin/sales-team link', () => {
    expect(SRC).toMatch(/href:\s*['"]\/admin\/sales-team['"]/);
    expect(SRC).toMatch(/label:\s*['"]Sales team['"]/);
  });
});

describe('CRM shell — sales-and-admin gate + own nav', () => {
  it('layout.tsx uses requireSalesOrAdmin, not requireConfirmedUser alone', () => {
    const src = read('app/crm/layout.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/auth\/requireSalesOrAdmin['"]/);
    expect(src).toMatch(/requireSalesOrAdmin\s*\(/);
  });

  it('CrmNav + CrmBottomNav point to the four Phase 3 sections (Today / Leads / Accounts / Settings)', () => {
    // Superseded from the four Phase 1 sections (/crm, /crm/leads,
    // /crm/board, /crm/import) — Phase 3 explicitly collapses the nav
    // to Today/Leads/Accounts/Settings; Board and Map become faces of
    // the Leads surface (a switcher on the page, not separate nav
    // items), and Import moves under Settings.
    const nav  = read('app/crm/CrmNav.tsx');
    const bnav = read('app/crm/CrmBottomNav.tsx');
    for (const href of ['/crm', '/crm/leads', '/crm/accounts', '/crm/settings']) {
      expect(nav).toMatch(new RegExp(`href:\\s*['"]${href.replace('/', '\\/')}['"]`));
      expect(bnav).toMatch(new RegExp(`href:\\s*['"]${href.replace('/', '\\/')}['"]`));
    }
    // Import is still reachable — now from Settings, not top-level nav.
    expect(read('app/crm/settings/page.tsx')).toMatch(/href="\/crm\/import"/);
  });
});
