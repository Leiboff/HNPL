import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Desktop sidebar nav — Cards entry pin ─────────────────────────
//
// The mobile bottom nav has always shown "Cards" for
// /patient/payment-methods, but the desktop sidebar used
// "Payment Methods". To someone scanning for "Cards" on desktop the
// link read as absent (defect 3, 2026-07-20). This pin locks the
// desktop label to match mobile so a future edit that reintroduces
// the mismatch surfaces as a red test rather than a visual regression.

const ROOT = resolve(process.cwd());
const NAV        = readFileSync(resolve(ROOT, 'app/patient/PatientNav.tsx'),       'utf8');
const BOTTOM_NAV = readFileSync(resolve(ROOT, 'app/patient/PatientBottomNav.tsx'), 'utf8');

describe('PatientNav (desktop sidebar) — Cards route parity with mobile', () => {
  it('desktop nav includes the payment-methods route with the label "Cards"', () => {
    // Route present + label reads "Cards" (not "Payment Methods").
    expect(NAV).toContain("href: '/patient/payment-methods'");
    expect(NAV).toMatch(/href:\s*'\/patient\/payment-methods',\s*label:\s*'Cards'/);
    // Old label MUST NOT reappear on desktop.
    expect(NAV).not.toMatch(/href:\s*'\/patient\/payment-methods',\s*label:\s*'Payment Methods'/);
  });

  it('mobile bottom nav still uses the same route + label — parity holds', () => {
    expect(BOTTOM_NAV).toContain("href: '/patient/payment-methods'");
    expect(BOTTOM_NAV).toMatch(/href:\s*'\/patient\/payment-methods',\s*label:\s*'Cards'/);
  });

  it('desktop nav is rendered at md+ viewports (not hidden)', () => {
    // Guard against a future edit that accidentally hides the sidebar
    // — the "hidden md:flex" pattern is Tailwind's mobile-hide,
    // desktop-show recipe.
    expect(NAV).toContain('md:flex');
    expect(NAV).toContain('hidden');
  });
});
