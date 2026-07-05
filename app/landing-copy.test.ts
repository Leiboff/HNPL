import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Landing page copy pass ────────────────────────────────────────────
//
// The landing page describes the LAUNCH model:
//   • credit + affordability check at signup → interest-free healthcare
//     allowance (a spending limit).
//   • bills split into 2 or 3 interest-free instalments.
//   • instalments collected by DebiCheck debit order on chosen salary
//     dates. NEVER card holds, NEVER card preauth.
//
// Pins:
//   1. Forbidden strings absent (all card-hold / card-limit / no-check
//      claims removed).
//   2. Seven approved slogans present exactly once, in the right
//      section container.
//   3. Two reserved slogans absent from the landing page entirely.
//   4. Still-true claims preserved (interest-free, practice fee, POPIA).

const ROOT = resolve(process.cwd());
const LANDING = readFileSync(resolve(ROOT, 'app/LandingPage.tsx'), 'utf8');

// Strip inline SVG icon function bodies + comments to reduce false
// positives for regex sweeps on prose content. Icon function bodies
// contain `stroke` etc which is fine; but section-scope regexes below
// slice within the JSX return statement, so no stripping needed there.

// ─── Forbidden card-preauth strings ────────────────────────────────────

describe('Forbidden card-preauth / card-limit / no-check strings — all absent', () => {
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
    // Prior debit-order rail wording (from c870f18, now corrected —
    // collection is tokenised card charges, not debit orders).
    'debit order',
    'DebiCheck',
    'A South African bank account',
    'no card required',
    'a bank account (so we can collect',
  ];

  for (const bad of FORBIDDEN) {
    it(`does NOT contain: "${bad}"`, () => {
      expect(LANDING).not.toContain(bad);
    });
  }
});

// ─── Seven approved slogans — present exactly once, correct section ────

// Helper: extract the JSX slice between two markers so we can pin a
// slogan to its section container.
function slice(startMarker: string, endMarker: string): string {
  const startIdx = LANDING.indexOf(startMarker);
  const endIdx   = LANDING.indexOf(endMarker, startIdx + 1);
  expect(startIdx, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(endIdx,   `end marker not found: ${endMarker}`  ).toBeGreaterThan(startIdx);
  return LANDING.slice(startIdx, endIdx);
}

describe('Slogan 1 — hero tagline: "Get better now. Pay better later."', () => {
  const heroScope = slice('{/* ── Hero ──', '{/* ── For patients ──');

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

describe('Slogan 2 — patient section heading: "Health can\'t wait. Payments can."', () => {
  const patientHead = slice('id="patients"', '<div className="steps">');

  it('appears as the section h2', () => {
    expect(patientHead).toMatch(/<h2>Health can&apos;t wait\. Payments can\.<\/h2>/);
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
  const exampleScope = slice('className="example reveal"', 'className="lp-grid"');

  it('appears inside the patient example block', () => {
    expect(exampleScope).toMatch(/<div className="lead">Take your bill in smaller doses\.<\/div>/);
  });

  it('the old "A R3,600 bill — Pay in 3" lead is gone', () => {
    expect(LANDING).not.toMatch(/<div className="lead">A R3,600 bill/);
  });

  it('the R3,600 total is preserved elsewhere in the block (chips still show R1,200 × 3)', () => {
    expect(exampleScope).toMatch(/R1,200[\s\S]*?R1,200[\s\S]*?R1,200/);
    expect(exampleScope).toContain('R3,600');
  });
});

describe('Slogan 4 — allowance feature card: "Give your health some credit — it\'s due."', () => {
  const featuresScope = slice('className="lp-grid"', 'className="sec-cta reveal"');

  it('appears as an h4 in the patient features grid', () => {
    expect(featuresScope).toMatch(/<h4>Give your health some credit — it&apos;s due\.<\/h4>/);
  });

  it('replaces the old "Your own credit, used smarter" card', () => {
    expect(featuresScope).not.toContain('Your own credit');
  });

  it('the card body describes the allowance (approved + interest-free + a once-off check)', () => {
    // The card body should MENTION approved, interest-free, allowance
    // — the shape of the honest allowance claim.
    expect(featuresScope).toMatch(/A once-off check[\s\S]*?approved, interest-free healthcare allowance/);
  });
});

describe('Slogan 5 — patient CTA: "Give yourself a new bill of health."', () => {
  const patientCTA = slice('className="sec-cta reveal"', '{/* ── All you need ──');

  it('appears as the patient section CTA button label', () => {
    expect(patientCTA).toContain('Give yourself a new bill of health.');
    expect(patientCTA).toMatch(/href="\/signup\/patient"/);
  });

  it('the old "Get care now, pay later" CTA is gone', () => {
    expect(LANDING).not.toContain('Get care now, pay later');
  });
});

describe('Slogan 6 — trust section sub-line: "The best bill of health is one you can actually afford."', () => {
  // Slice from the Trust section comment marker (guaranteed to be BEFORE
  // the h2) up to the FAQ section. Then order-check: h2 < slogan < .pillars.
  const trustScope = slice('{/* ── Trust ──', 'id="faq"');

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
  const finalScope = slice('className="final reveal"', '{/* ── Footer ──');

  it('appears as the final band h2', () => {
    expect(finalScope).toMatch(/<h2>Full recovery\. Zero interest\.<\/h2>/);
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

// ─── Still-true claims preserved ──────────────────────────────────────

describe('Still-true claims preserved', () => {
  it('the "Always interest-free" feature card is still present', () => {
    expect(LANDING).toMatch(/<h4>Always interest-free<\/h4>/);
  });

  it('the interest-free promise appears verbatim in the R3,600 example block', () => {
    expect(LANDING).toMatch(/Interest-free\. You pay R3,600 in total — never more\./);
  });

  it('the practice-fee FAQ is intact', () => {
    expect(LANDING).toMatch(/What does it cost my practice\?/);
    expect(LANDING).toMatch(/less a small percentage we keep as our fee/);
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

  it('practice-side "Paid upfront" + "Collection is on us" features intact', () => {
    expect(LANDING).toMatch(/<h4>Paid upfront<\/h4>/);
    expect(LANDING).toMatch(/<h4>Collection is on us<\/h4>/);
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

  it('the getting-started pillars are "A debit or credit card" + "A couple of minutes"', () => {
    expect(LANDING).toMatch(/<h4>A debit or credit card<\/h4>/);
    expect(LANDING).toMatch(/<h4>A couple of minutes<\/h4>/);
    // Pillar 1 body describes tokenised card charges — no bank-account
    // / debit-order fallback.
    expect(LANDING).toMatch(/charged automatically to your Visa or Mastercard/);
    // Pillar 2 body states eligibility (18+ / good credit record).
    expect(LANDING).toMatch(/18 or older with a good credit record/);
    // Old pillars (both the c870f18 bank-account version and the
    // pre-c870f18 "A credit card" version + "30 seconds") are all gone.
    expect(LANDING).not.toMatch(/<h4>A South African bank account<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>A credit card<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>30 seconds<\/h4>/);
  });

  it('patient Step 2 and Step 3 describe card charges (no debit order language)', () => {
    // Steps live inside the patient section .steps container. Pin the
    // card-charge phrases the copy pass installed.
    expect(LANDING).toMatch(/charged automatically to your card on your next paydays/);
    expect(LANDING).toMatch(/Each instalment is charged to your saved card automatically on the date you chose/);
  });

  it('practice Step 2 describes card charges (no debit order)', () => {
    expect(LANDING).toMatch(/interest-free instalments charged automatically to their card, timed to their salary dates/);
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
