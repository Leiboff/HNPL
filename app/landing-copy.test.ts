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
// Normalise CRLF→LF at read: these are source-text assertions, and git
// (core.autocrlf) checks the files out with CRLF on Windows. Without this,
// any pin keying on "\n" silently mismatches. Line endings are not part of
// what this suite means to assert.
const LANDING = readFileSync(resolve(ROOT, 'app/LandingPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
const HEADER  = readFileSync(resolve(ROOT, 'app/_landing/SiteHeader.tsx'), 'utf8').replace(/\r\n/g, '\n');

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
    // Cherry-style landing pass — rate copy and plan lengths we
    // deliberately do NOT offer. Marketing must not imply a
    // "qualifying" tier, a promotional teaser rate, or a plan
    // longer than Pay in 3.
    'promotional rate',
    'qualifying rate',
    'Pay in 6',
    'Pay in 12',
    'Pay in 24',
    '6 months',
    '12 months',
    '24 months',
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
  const heroScope = slice('{/* ── Hero ──', '{/* ── Why betternow');

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
  // Section body now uses a two-column layout (timeline + mockup)
  // instead of the old horizontal .steps grid. Slice up to that
  // container to scope the assertions to the section header.
  const howHead = slice('id="how"', 'className="how-two-col"');

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

describe('Slogan 3 — how-it-works sec-head sub-line: "Take your bill in smaller doses."', () => {
  // Post-restructure the old R3,600 split visual is retired; the
  // plan-chooser mockup does its explanatory job. S3 relocates
  // from that visual's lead line to the How-it-works sec-head
  // sub-line so the slogan survives the visual retirement.
  const howHead = slice('id="how"', 'className="how-two-col"');

  it('appears as the how-it-works sec-head sub-line under the h2', () => {
    expect(howHead).toMatch(/<h2>Health can&apos;t wait\. Payments can\.<\/h2>[\s\S]*?<p>Take your bill in smaller doses\.<\/p>/);
  });

  it('appears exactly once on the page', () => {
    const matches = LANDING.match(/Take your bill in smaller doses\./g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('the old "A R3,600 bill — Pay in 3" lead is gone', () => {
    expect(LANDING).not.toMatch(/<div className="lead">A R3,600 bill/);
  });
});

describe('Old R3,600 split visual — RETIRED entirely', () => {
  it('no R1,200 chip present anywhere on the landing', () => {
    expect(LANDING).not.toContain('R1,200');
  });

  it('no R3,600 total present anywhere on the landing', () => {
    expect(LANDING).not.toContain('R3,600');
  });

  it('no <div className="example reveal"> container present', () => {
    expect(LANDING).not.toMatch(/className="example reveal"/);
  });
});

describe('Slogan 4 — allowance strapline: "Give your health some credit — it\'s due."', () => {
  // Post-restructure this slogan is no longer an h4 in a features
  // grid — the six-card feature soup was collapsed into three
  // reason cards. The slogan now lives as the sub-line under the
  // "All you need to get started" heading, where the credit-check
  // reality is most relevant.
  const gettingStarted = slice('{/* ── All you need to get started', '{/* ── FAQ');

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

describe('Hero CTAs — two-button pair (Get started + See how it works)', () => {
  const heroScope = slice('{/* ── Hero ──', '{/* ── Why betternow');

  it('hero has BOTH a filled primary "Get started" and an outlined "See how it works" button', () => {
    // Filled primary → /signup/patient.
    expect(heroScope).toMatch(/<Link[^>]*className="btn btn-primary btn-lg"[^>]*href="\/signup\/patient"[^>]*>Get started<\/Link>/);
    // Outlined secondary → the How-it-works anchor. v3 moves Sign in to
    // the header (still asserted in the SiteHeader block below) and makes
    // the hero's secondary CTA "See how it works".
    expect(heroScope).toMatch(/<Link[^>]*className="btn btn-outline btn-lg"[^>]*href="\/#how"[^>]*>See how it works<\/Link>/);
  });

  it('no practice CTA in the hero', () => {
    expect(heroScope).not.toContain('I run a practice');
    expect(heroScope).not.toMatch(/href="\/signup\/practice"/);
  });

  it('the old dual-audience "I\'m a patient" / "I run a practice" pair stays gone', () => {
    expect(heroScope).not.toContain('I&apos;m a patient');
  });
});

describe('Slogan 6 — final CTA sub-line: "The best bill of health is one you can actually afford."', () => {
  // Post-restructure S6 relocates. Its home was the trust section
  // sub-line; the trust section is gone (its claims folded into
  // FAQ answers). S6 now sits under "Full recovery. Zero interest."
  // as the affordability closer — thematically the strongest fit.
  const finalScope = slice('className="final reveal"', '<SiteFooter');

  it('appears immediately under the "Full recovery. Zero interest." heading', () => {
    const headIdx    = finalScope.indexOf('<h2>Full recovery. Zero interest.</h2>');
    const sloganIdx  = finalScope.indexOf('The best bill of health is one you can actually afford.');
    const ctaIdx     = finalScope.indexOf('className="ctas"');
    expect(headIdx).toBeGreaterThan(-1);
    expect(sloganIdx).toBeGreaterThan(headIdx);
    expect(ctaIdx).toBeGreaterThan(sloganIdx);
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
  const whyScope = slice('id="why"', '{/* ── How it works');

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
  it('the "Always interest-free" claim is present (as the WHY card b)', () => {
    expect(LANDING).toMatch(/<h4>Always interest-free<\/h4>/);
  });

  it('the interest-free promise still lives in WHY card (b) copy (the R3,600 example that used to carry it is retired)', () => {
    // Old wording ("You pay R3,600 in total — never more.") retired
    // with the split visual. The WHY card copy carries the same
    // promise in the current landing.
    expect(LANDING).toMatch(/You pay your bill, never a cent more/);
    // And FAQ 1 covers "no interest, no fees".
    expect(LANDING).toMatch(/No interest, no fees added to your plan/);
  });

  // The trust section is GONE — its four claims fold into FAQ answers.

  it('trust claim: "Genuinely interest-free" folded into FAQ 1 (loan-that-snowballs phrasing)', () => {
    // The FAQ "Is it really interest-free?" answer now carries the
    // extra reassurance that lived in the trust pillar.
    expect(LANDING).toMatch(/Is it really interest-free\?/);
    expect(LANDING).toMatch(/Instalments, not a loan that snowballs — the total never grows beyond your original bill/);
  });

  it('trust claim: "Checked for affordability" folded into FAQ 3 (never take on more than you can manage)', () => {
    expect(LANDING).toMatch(/Is there a credit check\?/);
    expect(LANDING).toMatch(/you never take on more than you can manage/);
  });

  it('trust claim: "Bank-grade security" folded into the POPIA FAQ (encrypted end-to-end + secure audited rails)', () => {
    expect(LANDING).toMatch(/Is my information safe\?/);
    expect(LANDING).toMatch(/encrypted end-to-end and processed over secure, audited rails/);
    expect(LANDING).toMatch(/handled in line with POPIA/);
  });

  it('the "Built on trust." section header is GONE (folded into FAQ)', () => {
    expect(LANDING).not.toMatch(/<h2>Built on trust\.<\/h2>/);
    // Pillar h4s from the removed trust section are gone too.
    expect(LANDING).not.toMatch(/<h4>Genuinely interest-free<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>Checked for affordability<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>Bank-grade security<\/h4>/);
    expect(LANDING).not.toMatch(/<h4>POPIA-conscious<\/h4>/);
    // The trust section's own <section id="trust"> is gone.
    expect(LANDING).not.toMatch(/id="trust"/);
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

  it('the affordability language is preserved (folded into FAQ 3, not the removed trust pillar)', () => {
    // The old "<h4>Checked for affordability</h4>" pillar is gone;
    // the words that mattered ("credit and affordability check")
    // survive inside the credit-check FAQ.
    expect(LANDING).toMatch(/credit and affordability check/);
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

// ─── Cherry-style How-it-works: vertical timeline + phone mockup ──────

describe('How it works — vertical timeline (Cherry pattern)', () => {
  it('the How-it-works section uses a two-column layout on desktop', () => {
    expect(LANDING).toMatch(/className="how-two-col"/);
  });

  it('renders an ordered timeline with numbered circles 1 → 2 → 3', () => {
    // The <ol> carries the timeline; each tl-step has a tl-num
    // labelled 1, 2, or 3. Order matters — the numbered circles
    // are the visual anchor.
    const idx1 = LANDING.indexOf('<div className="tl-num">1</div>');
    const idx2 = LANDING.indexOf('<div className="tl-num">2</div>');
    const idx3 = LANDING.indexOf('<div className="tl-num">3</div>');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it('the three step titles ride inside the timeline (as h3s in tl-body)', () => {
    expect(LANDING).toMatch(/<div className="tl-body">[\s\S]*?<h3>Get treated today<\/h3>/);
    expect(LANDING).toMatch(/<div className="tl-body">[\s\S]*?<h3>Choose Pay in 2 or Pay in 3<\/h3>/);
    expect(LANDING).toMatch(/<div className="tl-body">[\s\S]*?<h3>Pay over your paydays<\/h3>/);
  });

  it('the old horizontal .steps grid is GONE from the landing', () => {
    // Guards against a copy-paste regression bringing the old
    // three-card layout back.
    expect(LANDING).not.toMatch(/<div className="steps">/);
    expect(LANDING).not.toMatch(/<div className="num">STEP 1<\/div>/);
  });

  it('the timeline sits INSIDE the two-column how-two-col container (LEFT), plan-chooser image on the RIGHT', () => {
    const twoColIdx  = LANDING.indexOf('className="how-two-col"');
    const timelineIdx = LANDING.indexOf('className="timeline reveal"');
    const visualIdx = LANDING.indexOf('className="how-visual reveal"');
    expect(twoColIdx).toBeGreaterThan(-1);
    expect(timelineIdx).toBeGreaterThan(twoColIdx);
    expect(visualIdx).toBeGreaterThan(timelineIdx);
  });
});

describe('Mockups — plan-chooser in How-it-works + device-approved in Getting-started band', () => {
  it('landing imports next/image', () => {
    expect(LANDING).toMatch(/from 'next\/image'/);
  });

  it('How-it-works right column carries plan-chooser.png with the specified alt', () => {
    // The alt text is required by the task and must be verbatim.
    expect(LANDING).toMatch(/src="\/marketing\/plan-chooser\.png"/);
    expect(LANDING).toMatch(/alt="betternow payment plan options — pay in 2 or pay in 3, interest-free"/);
    // width/height set (any positive integers) to prevent CLS —
    // pin the presence, not the exact numbers.
    expect(LANDING).toMatch(/className="plan-chooser"[\s\S]{0,400}width=\{\d+\}[\s\S]{0,80}height=\{\d+\}/);
  });

  it('the plan-chooser lives inside the How-it-works section, not the Getting-started band', () => {
    const planChooserIdx = LANDING.indexOf('/marketing/plan-chooser.png');
    const gsBandIdx      = LANDING.indexOf('<section className="gs-band">');
    expect(planChooserIdx).toBeGreaterThan(-1);
    expect(gsBandIdx).toBeGreaterThan(planChooserIdx);
  });

  it('Getting-started band carries device-approved.png with the specified alt', () => {
    expect(LANDING).toMatch(/src="\/marketing\/device-approved\.png"/);
    expect(LANDING).toMatch(/alt="betternow app showing an approved interest-free healthcare allowance"/);
    expect(LANDING).toMatch(/className="device"[\s\S]{0,400}width=\{\d+\}[\s\S]{0,80}height=\{\d+\}/);
  });

  it('the device-approved mockup lives INSIDE the Getting-started band', () => {
    const gsBandStart = LANDING.indexOf('<section className="gs-band">');
    const gsBandEnd   = LANDING.indexOf('</section>', gsBandStart);
    expect(gsBandStart).toBeGreaterThan(-1);
    const bandContent = LANDING.slice(gsBandStart, gsBandEnd);
    expect(bandContent).toMatch(/src="\/marketing\/device-approved\.png"/);
  });

  it('NO "Illustration" caption anywhere near the device mockup — removed with the CTA reorder', () => {
    // The R15,000 figure inside the phone screen must still not be
    // read as guaranteed. The caption removal is deliberate; NO
    // replacement copy is allowed to compensate for it, so the pin
    // asserts absence rather than presence.
    const gsBandStart = LANDING.indexOf('<section className="gs-band">');
    const gsBandEnd   = LANDING.indexOf('</section>', gsBandStart);
    const bandContent = LANDING.slice(gsBandStart, gsBandEnd);
    expect(bandContent).not.toMatch(/className="illustration-note"/);
    expect(bandContent).not.toContain('Illustration');
  });
});

describe('Getting-started band — narrative order: what you need → what you get → act', () => {
  function bandContent(): string {
    const start = LANDING.indexOf('<section className="gs-band">');
    const end   = LANDING.indexOf('</section>', start);
    expect(start).toBeGreaterThan(-1);
    return LANDING.slice(start, end);
  }

  it('renders as a .gs-band section (not the old .band alternate)', () => {
    expect(LANDING).toMatch(/<section className="gs-band">/);
  });

  it('uses the two-column layout (gs-two-col > gs-text + gs-visual)', () => {
    const bc = bandContent();
    expect(bc).toMatch(/className="gs-two-col reveal"/);
    expect(bc).toMatch(/className="gs-text"/);
    expect(bc).toMatch(/className="gs-visual"/);
    // Text column comes before the visual column in DOM order.
    const textIdx = bc.indexOf('className="gs-text"');
    const visIdx  = bc.indexOf('className="gs-visual"');
    expect(textIdx).toBeLessThan(visIdx);
  });

  it('DOM order is content → image → CTA (mobile stacks in that order; desktop reads content-left / image-right / CTA below)', () => {
    // The narrative: what you need (pillars in gs-text) → what
    // you get (approved-screen image in gs-visual) → act (CTA).
    // On desktop the gs-cta sits OUTSIDE the two-column grid as
    // a full-width centered row so it reads as the closing step.
    const bc = bandContent();
    const textIdx = bc.indexOf('className="gs-text"');
    const visIdx  = bc.indexOf('className="gs-visual"');
    const ctaIdx  = bc.indexOf('className="gs-cta');
    expect(textIdx).toBeGreaterThan(-1);
    expect(visIdx).toBeGreaterThan(textIdx);
    expect(ctaIdx).toBeGreaterThan(visIdx);
  });

  it('the primary CTA lives OUTSIDE the two-column grid (sibling to gs-two-col, not nested in gs-text or gs-visual)', () => {
    const bc = bandContent();
    const gridStart = bc.indexOf('className="gs-two-col');
    const ctaIdx    = bc.indexOf('className="gs-cta');
    expect(gridStart).toBeGreaterThan(-1);
    // Narrative order: the CTA is the closing step, after the grid content.
    expect(ctaIdx).toBeGreaterThan(gridStart);
    // Sibling, not nested: the two-column wrapper closes (gs-visual's
    // </div> then gs-two-col's </div>) before the CTA. Matched
    // whitespace-flexibly so it survives reformatting / CRLF — the
    // structure is what matters, not the exact indentation.
    const beforeCta = bc.slice(gridStart, ctaIdx);
    expect(beforeCta).toMatch(/<\/div>\s*<\/div>/);
    // The CTA still targets patient signup with the expected label.
    expect(bc).toMatch(/className="gs-cta[^"]*"[\s\S]{0,200}href="\/signup\/patient"[^>]*>Get started</);
  });

  it('the two pillars ("A debit or credit card" + "1 minute") stay inside the band', () => {
    const bc = bandContent();
    expect(bc).toMatch(/<h4>A debit or credit card<\/h4>/);
    expect(bc).toMatch(/<h4>1 minute<\/h4>/);
  });

  it('NO "Illustration" caption anywhere in the band (removed with the CTA reorder)', () => {
    const bc = bandContent();
    // The task requires the caption to be gone entirely, and no
    // replacement copy anywhere near the image.
    expect(bc).not.toContain('Illustration');
    expect(bc).not.toMatch(/className="illustration-note"/);
  });
});

// ─── Section order (post-restructure) ─────────────────────────────────

describe('Landing section order — Why → How → Getting started → FAQ', () => {
  it('sections appear in the specified order', () => {
    const whyIdx    = LANDING.indexOf('id="why"');
    const howIdx    = LANDING.indexOf('id="how"');
    const gsIdx     = LANDING.indexOf('{/* ── All you need to get started');
    const faqIdx    = LANDING.indexOf('id="faq"');
    const finalIdx  = LANDING.indexOf('{/* ── Final CTA');
    expect(whyIdx).toBeGreaterThan(-1);
    expect(howIdx).toBeGreaterThan(whyIdx);         // Why before How
    expect(gsIdx).toBeGreaterThan(howIdx);          // How before Getting started
    expect(faqIdx).toBeGreaterThan(gsIdx);          // Getting started before FAQ
    expect(finalIdx).toBeGreaterThan(faqIdx);       // FAQ before Final CTA
  });
});

// ─── Header nav order (shared component) ──────────────────────────────

describe('SiteHeader — nav link order matches spec (Why / How / For practices / FAQ)', () => {
  // The desktop nav <nav className="nav-links"> block orders the
  // four Link components. Grab the ordered positions to enforce
  // Why → How → For practices → FAQ.
  function navLinkIndexes(source: string): { why: number; how: number; practices: number; faq: number } {
    return {
      why:       source.indexOf('href="/#why"'),
      how:       source.indexOf('href="/#how"'),
      practices: source.indexOf('href="/practices"'),
      faq:       source.indexOf('href="/#faq"'),
    };
  }

  it('desktop nav lists Why → How → For practices → FAQ', () => {
    const idx = navLinkIndexes(HEADER);
    expect(idx.why).toBeGreaterThan(-1);
    expect(idx.how).toBeGreaterThan(idx.why);
    expect(idx.practices).toBeGreaterThan(idx.how);
    expect(idx.faq).toBeGreaterThan(idx.practices);
  });

  it('has a Sign in link and a burger button', () => {
    expect(HEADER).toMatch(/<Link className="signin" href="\/login">Sign in<\/Link>/);
    expect(HEADER).toMatch(/data-testid="site-header-burger"/);
  });

  it('has "For practices" pointing at /practices (not a legacy hash anchor)', () => {
    expect(HEADER).toMatch(/href="\/practices"/);
    expect(HEADER).not.toMatch(/href="#practices"/);
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
