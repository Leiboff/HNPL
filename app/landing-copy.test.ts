import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Landing page copy pass (patient-only) ─────────────────────────────
//
// The landing page describes the LAUNCH model for patients:
//   • credit + affordability check at signup → interest-free healthcare
//     allowance (a spending limit).
//   • bills split into 2 or 3 interest-free instalments.
//   • instalments collected by tokenised card charges on chosen salary
//     dates. NEVER card holds, NEVER card preauth, NEVER DebiCheck /
//     debit orders.
//
// Post-restructure (July 2026), the landing page is PATIENT-ONLY:
//   • Practice content moved to /practices — its pins live in
//     practices-copy.test.ts alongside this file.
//   • The WHY section is now exactly 3 reason cards (Payflex pattern).
//   • The hero has ONE patient CTA (no "I run a practice").
//   • Time wording is normalised: "1 minute" everywhere.
//
// Pins:
//   1. Forbidden strings absent (all card-hold / card-limit /
//      no-check / debit-order / DebiCheck claims removed).
//   2. Seven approved slogans present exactly once, in the right
//      section container (S4's home moved to the "Getting started"
//      sec-head sub-line).
//   3. Two reserved slogans absent from the landing page entirely.
//   4. Still-true claims preserved (interest-free promise, POPIA,
//      credit check answered honestly).
//   5. The 3-card WHY grid is EXACTLY these 3 cards in this order.
//   6. Practice content is GONE from the landing page (moved to
//      /practices).

const ROOT = resolve(process.cwd());
const LANDING = readFileSync(resolve(ROOT, 'app/LandingPage.tsx'), 'utf8');

// ─── Forbidden card-preauth / card-limit / no-check / debit-order strings ─

describe('Forbidden strings — all absent from landing', () => {
  const FORBIDDEN = [
    // Old model card-hold / preauth framing (must never come back)
    'on your credit card',
    'on their credit card',
    'reserve the bill amount',
    'a hold, not a charge',
    'the reserve simply sets the funds aside',
    "'pending' or 'uncleared'",
    'available credit',
    'the hold shrinks',
    'reserved amount',
    // Old model card-limit / no-new-debt framing
    'available limit',
    'existing credit card',
    'No new debt',
    'no new debt',
    // Old model no-credit-check claim
    'no applications and no credit checks',
    'no credit checks',
    // Old FAQ heads (deleted)
    'How does it work on my card',
    'Have I been charged the full amount',
    'Will I see the hold on my statement',
    // Old feature/pillar wording specific to the deleted card-limit story
    'Your own credit, used smarter',
    'If your card has the available limit',
    'Approved on the spot',
    // Prior debit-order rail wording
    'debit order',
    'DebiCheck',
    'A South African bank account',
    'no card required',
    'a bank account (so we can collect',
    // Forbidden inside the new "Flexible payment options" card:
    // options we DON'T offer must never be listed as if we do.
    'Pay in 4',
    'once-off',
  ];

  for (const bad of FORBIDDEN) {
    it(`does NOT contain: "${bad}"`, () => {
      expect(LANDING).not.toContain(bad);
    });
  }
});

// ─── Seven approved slogans — present exactly once, correct section ────

function slice(startMarker: string, endMarker: string): string {
  const startIdx = LANDING.indexOf(startMarker);
  const endIdx   = LANDING.indexOf(endMarker, startIdx + 1);
  expect(startIdx, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(endIdx,   `end marker not found: ${endMarker}`  ).toBeGreaterThan(startIdx);
  return LANDING.slice(startIdx, endIdx);
}

describe('Slogan 1 — hero tagline: "Get better now. Pay better later."', () => {
  const heroScope = slice('{/* ── Hero ──', '{/* ── How it works');

  it('appears in the hero section', () => {
    expect(heroScope).toContain('Get better now. Pay better later.');
  });

  it('the tagline paragraph carries the .tagline class (positioned above the functional sub)', () => {
    expect(heroScope).toMatch(/<p className="tagline">[\s\S]*?Get better now\. Pay better later\./);
  });

  it('appears exactly once on the page', () => {
    const matches = LANDING.match(/Get better now\. Pay better later\./g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('Slogan 2 — how-it-works heading: "Health can\'t wait. Payments can."', () => {
  const howHead = slice('id="how"', '<div className="steps">');

  it('appears as the section h2', () => {
    expect(howHead).toMatch(/<h2>Health can&apos;t wait\. Payments can\.<\/h2>/);
  });

  it('the old heading is gone', () => {
    expect(LANDING).not.toContain("Care shouldn&apos;t wait for payday");
    expect(LANDING).not.toContain("Care shouldn't wait for payday");
  });

  it('appears exactly once', () => {
    const matches = LANDING.match(/Health can&apos;t wait\. Payments can\./g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('Slogan 3 — R3,600 example lead line: "Take your bill in smaller doses."', () => {
  const exampleScope = slice('className="example reveal"', '{/* ── Why betternow');

  it('appears inside the how-it-works example block', () => {
    expect(exampleScope).toMatch(/<div className="lead">Take your bill in smaller doses\.<\/div>/);
  });

  it('the old "A R3,600 bill — Pay in 3" lead is gone', () => {
    expect(LANDING).not.toMatch(/<div className="lead">A R3,600 bill/);
  });

  it('the R3,600 total is preserved (chips still show R1,200 × 3)', () => {
    expect(exampleScope).toMatch(/R1,200[\s\S]*?R1,200[\s\S]*?R1,200/);
    expect(exampleScope).toContain('R3,600');
  });
});

describe('Slogan 4 — allowance strapline: "Give your health some credit — it\'s due."', () => {
  // Post-restructure this slogan is no longer an h4 in a features
  // grid — the six-card feature soup was collapsed into three
  // reason cards. The slogan now lives as the sub-line under the
  // "All you need to get started" heading, where the credit-check
  // reality is most relevant.
  const gettingStarted = slice('{/* ── All you need to get started', '{/* ── Trust ──');

  it('appears as the "Getting started" sec-head sub-line', () => {
    expect(gettingStarted).toMatch(/<div className="kicker">Getting started<\/div>[\s\S]*?<h2>All you need to get started<\/h2>[\s\S]*?<p>Give your health some credit — it&apos;s due\.<\/p>/);
  });

  it('the old "Your own credit, used smarter" phrasing stays gone', () => {
    expect(LANDING).not.toContain('Your own credit');
  });

  it('appears exactly once', () => {
    const matches = LANDING.match(/Give your health some credit — it&apos;s due\./g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('Slogan 5 — hero + final CTA: "Get started" (single patient CTA)', () => {
  // The old S5 "Give yourself a new bill of health." lived as the
  // patient-section CTA button — which no longer exists as a
  // separate section CTA. The single-audience redesign uses the
  // simpler "Get started" copy for both the hero CTA and the final
  // CTA. The old S5 line is dropped in favour of clarity.

  it('the hero has exactly ONE patient CTA labelled "Get started" pointing to /signup/patient', () => {
    const heroCtas = slice('<div className="ctas">', '</div>\n        </div>\n      </div>\n\n      {/* ── How it works');
    expect(heroCtas).toContain('Get started');
    expect(heroCtas).toMatch(/href="\/signup\/patient"/);
    // No practice CTA in the hero.
    expect(heroCtas).not.toContain('I run a practice');
    expect(heroCtas).not.toMatch(/href="\/signup\/practice"/);
  });

  it('the old dual-audience hero buttons ("I\'m a patient" / "I run a practice") are gone from the hero', () => {
    const heroScope = slice('{/* ── Hero ──', '{/* ── How it works');
    expect(heroScope).not.toContain('I&apos;m a patient');
    expect(heroScope).not.toContain('I run a practice');
  });
});

describe('Slogan 6 — trust section sub-line: "The best bill of health is one you can actually afford."', () => {
  const trustScope = slice('{/* ── Trust ──', '{/* ── FAQ');

  it('appears immediately under the "Built on trust." heading', () => {
    const headIdx     = trustScope.indexOf('<h2>Built on trust.</h2>');
    const sloganIdx   = trustScope.indexOf('The best bill of health is one you can actually afford.');
    const pillarsIdx  = trustScope.indexOf('className="pillars"');
    expect(headIdx).toBeGreaterThan(-1);
    expect(sloganIdx).toBeGreaterThan(headIdx);
    expect(pillarsIdx).toBeGreaterThan(sloganIdx);
  });

  it('appears exactly once', () => {
    const matches = LANDING.match(/The best bill of health is one you can actually afford\./g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('Slogan 7 — final CTA band headline: "Full recovery. Zero interest."', () => {
  const finalScope = slice('className="final reveal"', '<SiteFooter');

  it('appears as the final band h2', () => {
    expect(finalScope).toMatch(/<h2>Full recovery\. Zero interest\.<\/h2>/);
  });

  it('the final CTA is a SINGLE patient CTA (no "I run a practice" here either)', () => {
    expect(finalScope).toMatch(/href="\/signup\/patient"/);
    expect(finalScope).not.toContain('I run a practice');
    expect(finalScope).not.toMatch(/href="\/signup\/practice"/);
  });

  it('the old "Healthcare you can afford. Now." headline is gone', () => {
    expect(LANDING).not.toContain('Healthcare you can afford. Now.');
  });
});

// ─── Reserved slogans (must not appear on the landing page) ───────────

describe('Reserved slogans — absent from the landing page', () => {
  it('does NOT contain "First aid for big bills"', () => {
    expect(LANDING).not.toContain('First aid for big bills');
  });

  it('does NOT contain "Split the bill, not your priorities"', () => {
    expect(LANDING).not.toContain('Split the bill, not your priorities');
  });
});

// ─── The 3-card WHY grid (Payflex pattern) ────────────────────────────

describe('Why betternow — EXACTLY 3 reason cards', () => {
  const whyScope = slice('id="why"', '{/* ── All you need to get started');

  it('the section heading is "Why betternow"', () => {
    expect(whyScope).toMatch(/<h2>Why betternow<\/h2>/);
  });

  it('card (a): "Flexible payment options" — mentions Pay in 2, Pay in 3, salary dates', () => {
    expect(whyScope).toMatch(/<h4>Flexible payment options<\/h4>/);
    // The card body must NOT invent options we don't offer.
    const cardA = whyScope.slice(
      whyScope.indexOf('Flexible payment options'),
      whyScope.indexOf('Always interest-free'),
    );
    expect(cardA).toMatch(/Pay in 2/);
    expect(cardA).toMatch(/Pay in 3/);
    expect(cardA).toMatch(/salary dates/);
  });

  it('card (b): "Always interest-free" — describes the interest-free promise', () => {
    expect(whyScope).toMatch(/<h4>Always interest-free<\/h4>/);
    const cardB = whyScope.slice(
      whyScope.indexOf('Always interest-free'),
      whyScope.indexOf('1-minute approval'),
    );
    expect(cardB).toMatch(/never a cent more/);
    expect(cardB).toMatch(/No interest, no fees/);
  });

  it('card (c): "1-minute approval" — 1 minute, no paperwork, no branch visits', () => {
    expect(whyScope).toMatch(/<h4>1-minute approval<\/h4>/);
    const cardC = whyScope.slice(
      whyScope.indexOf('1-minute approval'),
      whyScope.length,
    );
    expect(cardC).toMatch(/in 1 minute/);
    expect(cardC).toMatch(/No paperwork/);
    expect(cardC).toMatch(/No .*? branch visits/i);
  });

  it('does NOT carry the six-card feature soup any more (allowance card, portal card, data-protection card GONE from features grid)', () => {
    // These h4s used to live in the .lp-grid — they must not
    // reappear as feature cards on the landing.
    expect(whyScope).not.toMatch(/<h4>One simple portal<\/h4>/);
    expect(whyScope).not.toMatch(/<h4>Your data, protected<\/h4>/);
    expect(whyScope).not.toMatch(/<h4>Approved online, in minutes<\/h4>/);
    expect(whyScope).not.toMatch(/<h4>Timed to your salary<\/h4>/);
    // The allowance card as an h4 is gone (S4 moved to Getting-started sub-line).
    expect(whyScope).not.toMatch(/<h4>Give your health some credit — it&apos;s due\.<\/h4>/);
  });
});

// ─── 1-minute consistency sweep ───────────────────────────────────────

describe('Time wording — consistently "1 minute" (never a stray "in minutes")', () => {
  it('the Getting-started pillar heading is "1 minute" (not "A couple of minutes")', () => {
    expect(LANDING).toMatch(/<h4>1 minute<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>A couple of minutes<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>30 seconds<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>A South African bank account<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>A credit card<\/h4>/);
  });

  it('the WHY card (c) claims "in 1 minute" (not "in minutes")', () => {
    // Guard against the previous "Approved online, in minutes" phrasing.
    expect(LANDING).not.toMatch(/Approved online, in minutes/);
    expect(LANDING).not.toMatch(/minutes, not weeks/);
  });

  it('FAQ answers align to "about 1 minute"', () => {
    // Old copy said "a couple of minutes online" in the credit-check
    // FAQ answer — swept to "about 1 minute online".
    expect(LANDING).toMatch(/about 1 minute online/);
    expect(LANDING).not.toMatch(/a couple of minutes online/);
    expect(LANDING).toMatch(/about 1 minute to complete the credit and affordability check/);
    expect(LANDING).not.toMatch(/a couple of minutes to complete the credit and affordability check/);
  });
});

// ─── Practice content GONE from the landing page ──────────────────────

describe('Practice content — moved to /practices, absent from landing', () => {
  it('no practice-signup CTA anywhere on the landing page', () => {
    expect(LANDING).not.toMatch(/href="\/signup\/practice"/);
  });

  it('no "For practices" tag inline (that content moved to its own page)', () => {
    expect(LANDING).not.toMatch(/className="tag pro"/);
  });

  it('the practice-fee FAQ is GONE (moved to /practices)', () => {
    expect(LANDING).not.toMatch(/What does it cost my practice\?/);
    expect(LANDING).not.toMatch(/less a small percentage we keep as our fee/);
  });

  it('the practice-side "Paid upfront" + "Collection is on us" features are GONE from landing', () => {
    expect(LANDING).not.toMatch(/<h4>Paid upfront<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>Collection is on us<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>More patients say yes<\/h4>/);
  });

  it('the practice steps are GONE from landing', () => {
    expect(LANDING).not.toMatch(/<h3>Record the bill<\/h3>/);
    expect(LANDING).not.toMatch(/<h3>Patient pays in 2 or 3<\/h3>/);
    expect(LANDING).not.toMatch(/<h3>Get paid upfront<\/h3>/);
  });

  it('the R3,600-shortfall STATS strip is GONE from landing (it belongs to /practices)', () => {
    // The patient split visual ("R1,200 today / next payday / payday after")
    // stays; the practice stats ("Days / R0 / 0 min admin") do not.
    expect(LANDING).not.toMatch(/<div className="lbl">to get paid<\/div>/);
    expect(LANDING).not.toMatch(/<div className="lbl">to chase<\/div>/);
    expect(LANDING).not.toMatch(/<div className="lbl">admin<\/div>/);
  });

  it('the specialties strip is GONE from landing (moved to /practices — provider-targeting)', () => {
    expect(LANDING).not.toMatch(/className="specialty-pills/);
    expect(LANDING).not.toMatch(/Built for South African healthcare\./);
  });
});

// ─── Still-true claims preserved ──────────────────────────────────────

describe('Still-true claims preserved', () => {
  it('the "Always interest-free" claim is present (now as the WHY card b)', () => {
    expect(LANDING).toMatch(/<h4>Always interest-free<\/h4>/);
  });

  it('the interest-free promise appears verbatim in the R3,600 example block', () => {
    expect(LANDING).toMatch(/Interest-free\. You pay R3,600 in total — never more\./);
  });

  it('the POPIA FAQ is intact', () => {
    expect(LANDING).toMatch(/Is my information safe\?/);
    expect(LANDING).toMatch(/handled in line with POPIA/);
  });

  it('the "Genuinely interest-free" trust pillar is intact', () => {
    expect(LANDING).toMatch(/<h4>Genuinely interest-free<\/h4>/);
  });

  it('the "Bank-grade security" and "POPIA-conscious" trust pillars are intact', () => {
    expect(LANDING).toMatch(/<h4>Bank-grade security<\/h4>/);
    expect(LANDING).toMatch(/<h4>POPIA-conscious<\/h4>/);
  });
});

// ─── Honest allowance/credit-check framing present ────────────────────

describe('Honest allowance + credit-check framing present', () => {
  it('the "Is there a credit check?" FAQ exists and answers honestly (YES)', () => {
    expect(LANDING).toMatch(/Is there a credit check\?/);
    expect(LANDING).toMatch(/Yes[\s\S]*?credit and affordability check/);
  });

  it('the "How does my allowance work?" FAQ describes the allowance model', () => {
    expect(LANDING).toMatch(/How does my allowance work\?/);
    expect(LANDING).toMatch(/interest-free healthcare allowance[\s\S]*?spending limit/);
  });

  it('the "When are instalments collected?" FAQ describes card-charge collection (no debit order)', () => {
    expect(LANDING).toMatch(/When are instalments collected\?/);
    expect(LANDING).toMatch(/Automatically charged to your saved card on the salary dates you choose/);
  });

  it('the "What do I need to use betternow?" FAQ names eligibility (18+, good credit) + debit or credit card + ID', () => {
    expect(LANDING).toMatch(/What do I need to use betternow\?/);
    expect(LANDING).toMatch(/18 or older with a good credit record/);
    expect(LANDING).toMatch(/debit or credit card \(Visa or Mastercard\)/);
    expect(LANDING).toMatch(/your ID for a quick verification/);
    expect(LANDING).toMatch(/credit and affordability check/);
  });

  it('the trust pillar reframed to "Checked for affordability"', () => {
    expect(LANDING).toMatch(/<h4>Checked for affordability<\/h4>/);
    expect(LANDING).toMatch(/quick affordability check at signup/);
  });

  it('the getting-started pillars are "A debit or credit card" + "1 minute"', () => {
    expect(LANDING).toMatch(/<h4>A debit or credit card<\/h4>/);
    expect(LANDING).toMatch(/<h4>1 minute<\/h4>/);
    // Pillar 1 body describes tokenised card charges.
    expect(LANDING).toMatch(/charged automatically to your Visa or Mastercard/);
    // Pillar 2 body states eligibility (18+ / good credit record).
    expect(LANDING).toMatch(/18 or older with a good credit record/);
  });

  it('patient Step 2 and Step 3 describe card charges (no debit order language)', () => {
    expect(LANDING).toMatch(/charged automatically to your card on your next paydays/);
    expect(LANDING).toMatch(/Each instalment is charged to your saved card automatically on the date you chose/);
  });
});

// ─── Header + footer wiring ───────────────────────────────────────────

describe('Header + footer wiring — "For practices" routes to /practices', () => {
  it('landing imports the shared SiteHeader + SiteFooter', () => {
    expect(LANDING).toMatch(/from '\.\/_landing\/SiteHeader'/);
    expect(LANDING).toMatch(/from '\.\/_landing\/SiteFooter'/);
  });

  it('the legacy inline <header> and <footer> markup are gone from LandingPage.tsx', () => {
    // The old inline nav is replaced by <SiteHeader />. Guards
    // against a copy-paste regression bringing them back.
    expect(LANDING).not.toMatch(/<header>\s*<div className="wrap nav">/);
    expect(LANDING).not.toMatch(/<footer>\s*<div className="wrap">\s*<div className="foot">/);
  });

  it('client-side redirect from the legacy #practices anchor to /practices', () => {
    expect(LANDING).toMatch(/window\.location\.hash === '#practices'/);
    expect(LANDING).toMatch(/window\.location\.replace\('\/practices'\)/);
  });
});

// ─── Diff scope — landing page only ───────────────────────────────────

describe('Diff scope — landing page only, no app-portal / payment / auth changes', () => {
  it('the landing page does not import payment / webhook / finance modules', () => {
    const FORBIDDEN = [
      '@/lib/payments/',
      '@/lib/paystack/',
      '@/lib/bills/lifecycle',
      'app/api/webhooks/paystack',
      '@/lib/finance',
      '@/lib/auth/',
    ];
    for (const mod of FORBIDDEN) {
      expect(LANDING).not.toContain(`from '${mod}`);
      expect(LANDING).not.toContain(`from "${mod}`);
    }
  });
});
