import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

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

// ─── No unfinished content may ship in a legal instrument ──────────────
//
// The Privacy Policy went live with clause 12.2 reading
// "Information Officer: [INSERT NAME / TITLE]". A bracketed placeholder in a
// published policy is worse than an omission: it advertises that the document
// was never finished, on the page a merchant-onboarding reviewer and any POPIA
// data subject both read. Two profiles had already recorded accepting it.
//
// Scope is BOTH legal pages plus the constants, not only the clause that was
// broken — the next placeholder will not be where the last one was.
//
// Every source is stripped of comments first, via the repo's own
// lib/testing/stripComments. Two reasons: prose explaining a placeholder that
// was REMOVED must not trip the guard that it is gone (the first draft of
// these tests failed exactly that way), and only rendered content is in scope.

const PLACEHOLDER = /\[[A-Z][A-Z0-9 /_-]{2,}\]/;

describe('legal pages carry no unfinished placeholders', () => {
  const SOURCES: Array<[string, string]> = [
    ['privacy page',      stripComments(BODY)],
    ['terms page',        stripComments(read('app/legal/terms/LegalTermsPage.tsx'))],
    ['privacy constants', stripComments(read('lib/legal/privacy.ts'))],
    ['terms constants',   stripComments(read('lib/legal/terms.ts'))],
  ];

  it.each(SOURCES)('%s has no [BRACKETED] placeholder', (_label, src) => {
    // Bracketed ALL-CAPS runs, tolerant of the spaces / slashes / underscores
    // these markers are usually written with: [INSERT NAME / TITLE], [TBC],
    // [COMPANY_NAME]. Scoped to ALL-CAPS so it cannot collide with ordinary
    // TypeScript array syntax in the ported clause structures.
    expect(src).not.toMatch(PLACEHOLDER);
  });

  it.each(SOURCES)('%s has no insert/TBC/TODO marker', (_label, src) => {
    for (const marker of [/\[insert/i, /\bTBC\b/, /\bTODO\b/, /\bFIXME\b/, /\bXXX\b/, /\[your\b/i]) {
      expect(src).not.toMatch(marker);
    }
  });

  it('the guard actually fires on the placeholder it was built for', () => {
    // Without this, a broken PLACEHOLDER regex would make every case above
    // pass vacuously — the same failure mode as a scanner that stops matching.
    expect('Information Officer: [INSERT NAME / TITLE]').toMatch(PLACEHOLDER);
    expect('[TBC]').toMatch(PLACEHOLDER);
    // And does not fire on ordinary source syntax.
    expect("parts: [{ b: 'Information Officer:' }]").not.toMatch(PLACEHOLDER);
  });
});

describe('clause 12.2 identifies the Information Officer by ROLE, not by person', () => {
  const clause = () => {
    const src = stripComments(BODY);
    return src.slice(src.indexOf("n: '12.2'"), src.indexOf("n: '12.3'"));
  };

  it('states the role and a contact route', () => {
    expect(clause()).toMatch(/Information Officer/);
    // The route is the shared SUPPORT constant, so it cannot drift from the
    // address the rest of the document already uses.
    expect(clause()).toMatch(/SUPPORT/);
  });

  it('leaves nothing to fill in', () => {
    expect(clause()).not.toMatch(/INSERT/i);
    expect(clause()).not.toMatch(PLACEHOLDER);
  });

  it('names no individual', () => {
    // A personal name would appear as two consecutive capitalised words. The
    // role itself is the only capitalised phrase the clause is allowed.
    const withoutRole = clause().replace(/Information Officer/g, '');
    expect(withoutRole).not.toMatch(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);
  });
});

describe('the footer carries no dead links', () => {
  // Stripped for the same reason as above: the footer now carries a comment
  // explaining why the PAIA link was removed, and naming it there must not
  // read as still shipping it.
  const FOOT = stripComments(FOOTER);

  it('the PAIA Manual link is gone, not repointed to a placeholder', () => {
    // It was <a href="#">PAIA Manual</a>. We are not publishing a PAIA manual
    // yet, and a link that looks like a published document but goes nowhere is
    // worse than its absence — especially in the Legal column, which is the
    // part of the footer a merchant-onboarding reviewer reads closely.
    expect(FOOT).not.toMatch(/PAIA/);
  });

  it('no href="#" anywhere in the footer', () => {
    // The general form of the same defect.
    expect(FOOT).not.toMatch(/href="#"/);
  });

  it('the real legal links survived the removal', () => {
    // Guards over-deletion: taking out the dead link must not take the live
    // ones with it.
    expect(FOOT).toMatch(/href="\/legal\/terms"/);
    expect(FOOT).toMatch(/href="\/legal\/privacy"/);
    expect(FOOT).toMatch(/href="\/contact"/);
  });
});
