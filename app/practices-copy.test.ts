import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /practices page copy pass ─────────────────────────────────────────
//
// The /practices page describes the LAUNCH model for practitioners /
// practices. It carries the provider-side content that was on the
// landing page pre-restructure — the copy was carefully built to the
// current business model and this file enforces that it did not
// silently regress during the move.
//
// Pins:
//   1. Same forbidden strings as the landing page (card holds /
//      preauth / DebiCheck / debit-order / no-credit-check claims).
//   2. Hero copy + single practice-signup CTA.
//   3. The 3 practice steps (Record the bill / Patient pays in 2 or
//      3 / Get paid upfront).
//   4. The R3,600 shortfall stats strip.
//   5. Exactly 3 benefit cards (Paid upfront / Collection is on us /
//      More patients say yes).
//   6. The specialties strip (moved here from landing).
//   7. Practice FAQ: fee question present + fold-ins from trimmed
//      cards.
//   8. Metadata title + description exist and are practice-focused.

const ROOT = resolve(process.cwd());
const PRACTICES = readFileSync(resolve(ROOT, 'app/practices/PracticesPage.tsx'), 'utf8');
const PRACTICES_PAGE = readFileSync(resolve(ROOT, 'app/practices/page.tsx'), 'utf8');

// ─── Forbidden strings — same discipline as the landing page ──────────

describe('/practices — forbidden strings absent', () => {
  const FORBIDDEN = [
    'on your credit card',
    'on their credit card',
    'reserve the bill amount',
    'a hold, not a charge',
    'the reserve simply sets the funds aside',
    "'pending' or 'uncleared'",
    'available credit',
    'the hold shrinks',
    'reserved amount',
    'available limit',
    'existing credit card',
    'No new debt',
    'no new debt',
    'no applications and no credit checks',
    'no credit checks',
    'How does it work on my card',
    'Have I been charged the full amount',
    'Will I see the hold on my statement',
    'Your own credit, used smarter',
    'If your card has the available limit',
    'Approved on the spot',
    'debit order',
    'DebiCheck',
    'A South African bank account',
    'no card required',
    'a bank account (so we can collect',
    'Pay in 4',
    'once-off',
    // Reserved slogans (also absent here — they aren't for /practices).
    'First aid for big bills',
    'Split the bill, not your priorities',
    // Rate + plan-length copy we do NOT offer — extended from the
    // landing pass.
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
      expect(PRACTICES).not.toContain(bad);
    });
  }
});

// ─── Hero ─────────────────────────────────────────────────────────────

describe('/practices hero', () => {
  it('renders the "Turn shortfalls into treatments that go ahead." tagline', () => {
    expect(PRACTICES).toMatch(/<p className="tagline">\s*Turn shortfalls into treatments that go ahead\./);
  });

  it('sub-line describes get-paid-upfront + zero admin', () => {
    expect(PRACTICES).toMatch(/Get paid upfront and add zero risk or admin/);
  });

  it('hero CTA points to /signup/practice and reads "Offer betternow at your practice"', () => {
    expect(PRACTICES).toMatch(/href="\/signup\/practice"[^>]*>\s*Offer betternow at your practice/);
  });

  it('hero uses the compact stage variant', () => {
    expect(PRACTICES).toMatch(/className="stage stage-compact"/);
  });

  it('there is NO patient-signup CTA on /practices', () => {
    expect(PRACTICES).not.toMatch(/href="\/signup\/patient"/);
    expect(PRACTICES).not.toContain('I&apos;m a patient');
  });
});

// ─── Three practice steps — Cherry-style vertical timeline ────────────

describe('/practices — three-step "how it works" as a vertical timeline', () => {
  it('uses the two-column how-two-col layout', () => {
    expect(PRACTICES).toMatch(/className="how-two-col"/);
  });

  it('renders the ordered timeline with numbered circles 1 → 2 → 3', () => {
    const idx1 = PRACTICES.indexOf('<div className="tl-num">1</div>');
    const idx2 = PRACTICES.indexOf('<div className="tl-num">2</div>');
    const idx3 = PRACTICES.indexOf('<div className="tl-num">3</div>');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it('Step 1: "Record the bill" — inside tl-body', () => {
    expect(PRACTICES).toMatch(/<div className="tl-body">[\s\S]*?<h3>Record the bill<\/h3>/);
    expect(PRACTICES).toMatch(/Capture the patient&apos;s shortfall in seconds/);
  });

  it('Step 2: "Patient pays in 2 or 3" — card charges timed to salary dates (no debit order)', () => {
    expect(PRACTICES).toMatch(/<div className="tl-body">[\s\S]*?<h3>Patient pays in 2 or 3<\/h3>/);
    expect(PRACTICES).toMatch(/interest-free instalments charged automatically to their card, timed to their salary dates/);
  });

  it('Step 3: "Get paid upfront" — paid within days, collection is our job', () => {
    expect(PRACTICES).toMatch(/<div className="tl-body">[\s\S]*?<h3>Get paid upfront<\/h3>/);
    expect(PRACTICES).toMatch(/paid within days/);
    expect(PRACTICES).toMatch(/collect every instalment/);
  });

  it('the old horizontal .steps grid is GONE (guard against regression)', () => {
    expect(PRACTICES).not.toMatch(/<div className="steps">/);
    expect(PRACTICES).not.toMatch(/<div className="num">STEP 1<\/div>/);
  });
});

// ─── R3,600 shortfall stats strip — now in the right column ───────────

describe('/practices — R3,600 shortfall stats panel (right column of the timeline)', () => {
  it('lives inside the .how-visual right column, not a full-width example strip', () => {
    // The stats panel takes the phone-mockup slot; it's a
    // .stats-panel inside .how-visual, not the old full-width
    // .example block that used to sit below the horizontal steps.
    expect(PRACTICES).toMatch(/className="how-visual reveal"[\s\S]*?className="stats-panel"/);
  });

  it('lead line names the shortfall amount', () => {
    expect(PRACTICES).toMatch(/On a R3,600 shortfall/);
  });

  it('three stats chips: Days / R0 / 0 min admin', () => {
    expect(PRACTICES).toMatch(/<div className="lbl">to get paid<\/div>/);
    expect(PRACTICES).toMatch(/<div className="lbl">to chase<\/div>/);
    expect(PRACTICES).toMatch(/<div className="lbl">admin<\/div>/);
    expect(PRACTICES).toMatch(/<div className="amt">Days<\/div>/);
    expect(PRACTICES).toMatch(/<div className="amt">R0<\/div>/);
    expect(PRACTICES).toMatch(/<div className="amt">0 min<\/div>/);
  });

  it('the "collection is on us" note is retained', () => {
    expect(PRACTICES).toMatch(/collection is on us/);
  });
});

// ─── Device mockup — NOT on /practices ────────────────────────────────

describe('/practices — no marketing mockups (both are the landing\'s assets)', () => {
  it('does NOT reference /marketing/device-approved.png', () => {
    expect(PRACTICES).not.toMatch(/device-approved\.png/);
  });

  it('does NOT reference /marketing/plan-chooser.png', () => {
    expect(PRACTICES).not.toMatch(/plan-chooser\.png/);
  });

  it('does NOT import next/image (the /practices page has no image assets)', () => {
    expect(PRACTICES).not.toMatch(/from 'next\/image'/);
  });

  it('carries no "Illustration" caption (only the landing mockup uses one)', () => {
    expect(PRACTICES).not.toMatch(/className="illustration-note"/);
  });
});

// ─── EXACTLY 3 benefit cards ──────────────────────────────────────────

describe('/practices — exactly 3 benefit cards (Payflex pattern)', () => {
  function benefitScope(): string {
    const start = PRACTICES.indexOf('{/* ── 3 benefit cards');
    const end   = PRACTICES.indexOf('{/* ── Specialties');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return PRACTICES.slice(start, end);
  }

  it('card (a): "Paid upfront"', () => {
    expect(benefitScope()).toMatch(/<h4>Paid upfront<\/h4>/);
    expect(benefitScope()).toMatch(/hits your account within days/);
  });

  it('card (b): "Collection is on us"', () => {
    expect(benefitScope()).toMatch(/<h4>Collection is on us<\/h4>/);
    expect(benefitScope()).toMatch(/entire collection process is ours/);
  });

  it('card (c): "More patients say yes"', () => {
    expect(benefitScope()).toMatch(/<h4>More patients say yes<\/h4>/);
    expect(benefitScope()).toMatch(/more recommended treatments go ahead/);
  });

  it('the trimmed cards (Zero paperwork / Onboard in 30 seconds / Built for SA) are NOT in the benefits grid — they are folded into the FAQ / specialties section', () => {
    // Their content still exists on the page (checked below) but
    // NOT as h4 feature cards inside the benefits grid.
    expect(benefitScope()).not.toMatch(/<h4>Zero paperwork<\/h4>/);
    expect(benefitScope()).not.toMatch(/<h4>Onboard in 30 seconds<\/h4>/);
    expect(benefitScope()).not.toMatch(/<h4>Built for SA practices<\/h4>/);
  });
});

// ─── Specialties strip (moved here from landing) ──────────────────────

describe('/practices — specialties strip', () => {
  it('the "Built for South African healthcare." heading lives here', () => {
    expect(PRACTICES).toMatch(/<h2>Built for South African healthcare\.<\/h2>/);
  });

  it('the 8 specialty pills are present', () => {
    expect(PRACTICES).toMatch(/className="specialty-pills/);
    for (const s of ['Dental', 'Optometry', 'Audiology', 'Physiotherapy', 'GP &amp; Family', 'Specialists', 'Dermatology', 'Fertility']) {
      expect(PRACTICES).toContain(`<span className="pill">${s}</span>`);
    }
  });

  it('the mailto for "Get in touch" is intact', () => {
    expect(PRACTICES).toContain('mailto:hello@betternow.co.za');
  });
});

// ─── FAQ ──────────────────────────────────────────────────────────────

describe('/practices — FAQ (fee present + fold-ins from trimmed cards)', () => {
  it('the practice-fee FAQ is present with the honest fee copy', () => {
    expect(PRACTICES).toMatch(/What does it cost my practice\?/);
    expect(PRACTICES).toMatch(/less a small percentage we keep as our fee/);
  });

  it('fold-in from "Zero paperwork" card', () => {
    expect(PRACTICES).toMatch(/Is there any paperwork or portals to manage\?/);
  });

  it('fold-in from "Onboard in 30 seconds" card', () => {
    expect(PRACTICES).toMatch(/How long does onboarding take\?/);
    expect(PRACTICES).toMatch(/Under 30 seconds/);
  });

  it('fold-in from "Built for SA practices" card', () => {
    expect(PRACTICES).toMatch(/Is betternow built for South African practices\?/);
  });
});

// ─── Final CTA ────────────────────────────────────────────────────────

describe('/practices — final CTA', () => {
  it('final CTA links to /signup/practice', () => {
    // Two hero-CTA occurrences (top + bottom) both point at signup.
    const matches = PRACTICES.match(/href="\/signup\/practice"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Header + footer wiring ───────────────────────────────────────────

describe('/practices — shared header + footer', () => {
  it('imports the shared SiteHeader + SiteFooter', () => {
    expect(PRACTICES).toMatch(/from '\.\.\/_landing\/SiteHeader'/);
    expect(PRACTICES).toMatch(/from '\.\.\/_landing\/SiteFooter'/);
  });
});

// ─── Metadata ─────────────────────────────────────────────────────────

describe('/practices — page metadata (SEO)', () => {
  it('exports a Metadata object with practice-focused title + description', () => {
    expect(PRACTICES_PAGE).toMatch(/export const metadata:\s*Metadata\s*=/);
    expect(PRACTICES_PAGE).toMatch(/title:.*[Ff]or practices/);
    // The description is a multi-line template — use [\s\S]* so the
    // newline between the `description:` key and the string literal
    // doesn't break the match.
    expect(PRACTICES_PAGE).toMatch(/description:[\s\S]*?shortfalls/i);
  });
});
