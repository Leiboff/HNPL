import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /legal/privacy — public page + verbatim policy text ────────────────
//
// Mirror of app/legal/terms/terms-page.test.ts. Pins: the route is public
// (no auth/redirect), version + date come from lib/legal/privacy, the
// internal amber "to confirm before publishing" flag box is NOT ported,
// a spot-check of the policy stays byte-faithful, and the footer links it.

const ROOT   = resolve(process.cwd());
const read   = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PAGE   = read('app/legal/privacy/page.tsx');
const BODY   = read('app/legal/privacy/LegalPrivacyPage.tsx');
const FOOTER = read('app/_landing/SiteFooter.tsx');

describe('/legal/privacy route wiring', () => {
  it('page.tsx exports metadata and renders the LegalPrivacyPage component', () => {
    expect(PAGE).toMatch(/export const metadata/);
    expect(PAGE).toMatch(/<LegalPrivacyPage\s*\/>/);
  });

  it('is publicly reachable — no auth gate, no redirect', () => {
    expect(PAGE).not.toMatch(/getUser|redirect\(|createClient/);
    expect(BODY).not.toMatch(/redirect\(/);
    expect(BODY).toMatch(/SiteHeader/);
    expect(BODY).toMatch(/SiteFooter/);
  });

  it('reads version + effective date from lib/legal/privacy (not hard-typed)', () => {
    expect(PAGE).toMatch(/from '@\/lib\/legal\/privacy'/);
    expect(BODY).toMatch(/from '@\/lib\/legal\/privacy'/);
    expect(BODY).toMatch(/PRIVACY_VERSION/);
    expect(BODY).toMatch(/PRIVACY_EFFECTIVE_DATE_LABEL/);
  });

  it('does NOT port the internal amber pre-publish flag box', () => {
    // That box is an internal checklist, not customer content. Assert on
    // strings unique to the box (never present in customer copy).
    expect(BODY).not.toMatch(/Remove this box before going live/i);
    expect(BODY).not.toMatch(/failure to register is itself a violation/i);
    expect(BODY).not.toMatch(/Attorney to confirm/i);
    expect(BODY).not.toMatch(/class="flag"/);
  });
});

describe('/legal/privacy — policy text ported verbatim', () => {
  it('has exactly 12 sections wired into the side-nav', () => {
    for (let n = 1; n <= 12; n++) {
      expect(BODY).toMatch(new RegExp(`id: 's${n}'`));
    }
    expect(BODY).not.toMatch(/id: 's13'/);
  });

  it('carries the minors + special-category exclusion (1.3)', () => {
    expect(BODY).toMatch(/We do not knowingly Process the Personal Information of minors \(persons under 18\)/);
    expect(BODY).toMatch(/special categories of Personal Information \(such as information about health, race, religious beliefs, or biometric data\)/);
  });

  it('carries the automated-decision disclosure (4.4)', () => {
    expect(BODY).toMatch(/may be made by automated means — that is, by our systems without human intervention/);
    expect(BODY).toMatch(/make representations regarding, any such automated decision/);
  });

  it('cross-border clause (6) names no specific country and cites section 72 of POPIA', () => {
    expect(BODY).toMatch(/section 72 of POPIA/);
    expect(BODY).not.toMatch(/European Union/);
    // The only country named is South Africa itself (the reference point).
    expect(BODY).not.toMatch(/United States|Ireland|Germany|Netherlands/);
  });

  it('carries the Information Regulator contact (12) and the info table (2)', () => {
    expect(BODY).toMatch(/Information Regulator \(South Africa\)/);
    expect(BODY).toMatch(/inforegulator\.org\.za/);
    // Section 2 collection table.
    expect(BODY).toMatch(/head: \['Category', 'Examples'\]/);
    expect(BODY).toMatch(/PCI-compliant payment processor/);
  });

  it('cross-links the Customer Terms & Conditions to /legal/terms', () => {
    expect(BODY).toMatch(/<Link href="\/legal\/terms">Customer Terms and Conditions<\/Link>/);
  });
});

describe('site footer links to the privacy page', () => {
  it('the Legal column Privacy link points at /legal/privacy', () => {
    expect(FOOTER).toMatch(/<Link href="\/legal\/privacy">Privacy Policy<\/Link>/);
  });
});
