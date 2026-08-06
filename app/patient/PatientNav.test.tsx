import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Patient nav — v4 four-tab structure ───────────────────────────────
//
// v4 collapsed the five-tab portal (Home / Orders / Explore / Cards /
// Profile) to four: Home / Plans / Find care / Account. Cards folded into
// Account and the standalone /patient/payment-methods + /patient/profile
// routes dropped out of the nav (they remain reachable as deep routes).
// This pins the desktop sidebar and mobile bottom nav to that shape so a
// regression that reintroduces the old tabs surfaces as a red test.

const ROOT = resolve(process.cwd());
const NAV        = readFileSync(resolve(ROOT, 'app/patient/PatientNav.tsx'),       'utf8');
const BOTTOM_NAV = readFileSync(resolve(ROOT, 'app/patient/PatientBottomNav.tsx'), 'utf8');

const TABS: Array<[string, string]> = [
  ['/patient',         'Home'],
  ['/patient/orders',  'Plans'],
  ['/patient/explore', 'Find care'],
  ['/patient/account', 'Account'],
];

describe('PatientNav (desktop sidebar) — v4 four tabs', () => {
  it.each(TABS)('includes the %s route labelled "%s"', (href, label) => {
    expect(NAV).toMatch(new RegExp(`href:\\s*'${href.replace(/\//g, '\\/')}',\\s*label:\\s*'${label}'`));
  });

  it('no longer routes to the retired Cards / Profile tabs from the nav', () => {
    expect(NAV).not.toMatch(/href:\s*'\/patient\/payment-methods'/);
    expect(NAV).not.toMatch(/href:\s*'\/patient\/profile'/);
  });

  it('desktop nav is rendered at md+ viewports (not hidden)', () => {
    expect(NAV).toContain('md:flex');
    expect(NAV).toContain('hidden');
  });
});

describe('PatientBottomNav (mobile) — v4 four tabs, parity with desktop', () => {
  it.each(TABS)('includes the %s route labelled "%s"', (href, label) => {
    expect(BOTTOM_NAV).toMatch(new RegExp(`href:\\s*'${href.replace(/\//g, '\\/')}',\\s*label:\\s*'${label}'`));
  });

  it('no longer routes to the retired Cards / Profile tabs', () => {
    expect(BOTTOM_NAV).not.toMatch(/href:\s*'\/patient\/payment-methods'/);
    expect(BOTTOM_NAV).not.toMatch(/href:\s*'\/patient\/profile'/);
  });
});
