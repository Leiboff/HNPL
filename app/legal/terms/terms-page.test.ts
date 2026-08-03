import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /legal/terms — public page + verbatim legal text ───────────────────
//
// The page is a restyle of the standalone terms HTML: the WRAPPER is the
// app's marketing chrome (SiteHeader/SiteFooter, .lp-root tokens), but
// the WORDS are the legal text verbatim. These pins guard both:
//   • the route is public (no auth import / redirect),
//   • the version + date come from lib/legal/terms (not hard-typed),
//   • a spot-check of clauses stays byte-faithful, and
//   • the footer links to it.

const ROOT   = resolve(process.cwd());
const read   = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const PAGE   = read('app/legal/terms/page.tsx');
const BODY   = read('app/legal/terms/LegalTermsPage.tsx');
const FOOTER = read('app/_landing/SiteFooter.tsx');

describe('/legal/terms route wiring', () => {
  it('page.tsx exports metadata and renders the LegalTermsPage component', () => {
    expect(PAGE).toMatch(/export const metadata/);
    expect(PAGE).toMatch(/<LegalTermsPage\s*\/>/);
  });

  it('is publicly reachable — no auth gate, no redirect', () => {
    // A public marketing page: it must not pull a server auth client or
    // redirect unauthenticated visitors away.
    expect(PAGE).not.toMatch(/getUser|redirect\(|createClient/);
    expect(BODY).not.toMatch(/redirect\(/);
    // It uses the shared public chrome.
    expect(BODY).toMatch(/SiteHeader/);
    expect(BODY).toMatch(/SiteFooter/);
  });

  it('reads version + effective date from lib/legal/terms (not hard-typed)', () => {
    expect(PAGE).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(BODY).toMatch(/from '@\/lib\/legal\/terms'/);
    expect(BODY).toMatch(/TERMS_VERSION/);
    expect(BODY).toMatch(/TERMS_EFFECTIVE_DATE_LABEL/);
  });
});

describe('/legal/terms — legal text ported verbatim', () => {
  it('carries the R115 default fee, the R345 / 25% cap, and the 3-fee maximum', () => {
    expect(BODY).toMatch(/Default Fee of R115\.00 \(including VAT\)/);
    expect(BODY).toMatch(/R345\.00 \(including VAT\), being three Default Fees/);
    expect(BODY).toMatch(/25% of the Purchase Price \(including VAT\)/);
    // The 3-fee maximum — the phrase is split across a bold fragment in
    // the source ('a maximum of ', { b: 'three (3) Default Fees' }).
    expect(BODY).toMatch(/three \(3\) Default Fees/);
  });

  it('carries the default-freeze clause (3.5) verbatim', () => {
    expect(BODY).toMatch(
      /you will be frozen from taking out further Payment Plans until the defaulted amount \(including any Default Fees\) has been settled in full/,
    );
  });

  it('carries the plain-language fee callout', () => {
    expect(BODY).toMatch(/never more than 25% of your purchase/);
    expect(BODY).toMatch(/never pay a cent in fees/);
  });

  it('carries the debit-mandate authorisation (4.4) and Pay-in-2 / Pay-in-3 definition', () => {
    expect(BODY).toMatch(/unconditionally and irrevocably authorise us to debit your Card/);
    expect(BODY).toMatch(/Pay-in-2/);
    expect(BODY).toMatch(/Pay-in-3/);
  });

  it('has all 15 sections wired into the side-nav', () => {
    for (let n = 1; n <= 15; n++) {
      expect(BODY).toMatch(new RegExp(`id: 's${n}'`));
    }
  });
});

describe('site footer links to the terms page', () => {
  it('the Legal column Terms link points at /legal/terms', () => {
    expect(FOOTER).toMatch(/<Link href="\/legal\/terms">Terms/);
  });
});
