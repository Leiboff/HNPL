import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const ACTION = read('app/admin/settings/actions.ts');
const FORM = read('app/admin/settings/BillLimitForm.tsx');
const PAGE = read('app/admin/settings/page.tsx');
// The nav's link list moved out of AdminNav.tsx when the phone nav became
// a hamburger — the desktop sidebar and the mobile menu both render this
// one source now, so "visible in the admin navigation" is answered here,
// and answering it here means BOTH widths rather than only desktop.
const NAV = read('app/admin/adminNavLinks.ts');

describe('admin-configurable maximum bill amount', () => {
  it('is visible in the admin navigation and loaded through session RLS', () => {
    expect(NAV).toMatch(/href: '\/admin\/settings'/);
    expect(PAGE).toMatch(/\.from\('platform_settings'\)/);
    expect(PAGE).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('limits the dashboard input to the shared floor and R30,000 database ceiling', () => {
    expect(FORM).toMatch(/min=\{MIN_BILL_AMOUNT\}/);
    expect(FORM).toMatch(/max=\{MAX_BILL_AMOUNT\}/);
    expect(FORM).toMatch(/step="0\.01"/);
    expect(ACTION).toMatch(/amount < MIN_BILL_AMOUNT/);
    expect(ACTION).toMatch(/amount > MAX_BILL_AMOUNT/);
  });

  it('re-authorizes, requires fresh critical AAL2, and calls the narrow RPC', () => {
    expect(ACTION).toMatch(/profile\?\.role !== 'admin'/);
    expect(ACTION).toMatch(/requireAAL2\('critical'\)/);
    expect(ACTION).toMatch(/\.rpc\('set_max_bill_amount'/);
    expect(ACTION).toMatch(/p_actor_id: user\.id/);
  });
});
