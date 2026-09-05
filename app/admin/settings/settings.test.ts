import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const ACTION = read('app/admin/settings/actions.ts');
const FORM = read('app/admin/settings/BillLimitForm.tsx');
const PAGE = read('app/admin/settings/page.tsx');
const NAV = read('app/admin/AdminNav.tsx');

describe('admin-configurable maximum bill amount', () => {
  it('is visible in the admin navigation and loaded through session RLS', () => {
    expect(NAV).toMatch(/href: '\/admin\/settings'/);
    expect(PAGE).toMatch(/\.from\('platform_settings'\)/);
    expect(PAGE).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('limits the dashboard input to the R30,000 database ceiling', () => {
    expect(FORM).toMatch(/max="30000"/);
    expect(FORM).toMatch(/step="0\.01"/);
  });

  it('re-authorizes, requires fresh critical AAL2, and calls the narrow RPC', () => {
    expect(ACTION).toMatch(/profile\?\.role !== 'admin'/);
    expect(ACTION).toMatch(/requireAAL2\('critical'\)/);
    expect(ACTION).toMatch(/\.rpc\('set_max_bill_amount'/);
    expect(ACTION).toMatch(/p_actor_id: user\.id/);
  });
});
