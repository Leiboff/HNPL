import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Landing page copy + structure pins (patient-only, v4) ─────────────
//
// The landing page describes the LAUNCH model for patients:
//   • credit + affordability check at signup → interest-free healthcare
//     allowance (a spending limit).
//   • bills split into 2 or 3 interest-free instalments.
//   • instalments collected by tokenised card charges on chosen salary
//     dates. NEVER card holds, NEVER card preauth, NEVER DebiCheck /
//     debit orders.
//
// v4 (Sep 2026) rebuilt the page from the "betternow landing concept":
// mint hero + photo, proof card, colour-blocked reason cards, the real app
// screenshot beside a one-open accordion of steps, a "What you'll need"
// grid, a navy slider calculator, a two-column FAQ and a navy close. The
// layout-only pins of v3 (timeline, gs-band, fixed R3,000, no slider)
// were retired with that layout; every CLAIM pin carried over.
//
// Pins:
//   1. Forbidden strings absent (card-hold / card-limit / no-check /
//      debit-order / unconditional-fee claims).
//   2. Fee promises are ALWAYS conditional on paying on time — the T&Cs
//      carry a capped default fee. Interest promises stay unconditional
//      (no interest is ever charged, default included).
//   3. Five approved slogans present exactly once, in their section.
//   4. Two reserved slogans absent.
//   5. Honest claims preserved (credit check = yes, card-charge
//      collection, 18+/good credit, POPIA).
//   6. WHY = exactly 3 reason cards, in order.
//   7. Calculator uses checkout's own split (splitInstalments) and says
//      it is an illustration bounded by the approved allowance.
//   8. Practice content is GONE from the landing (lives on /practices).
//   9. Shared header/footer wiring + #practices redirect.

const ROOT = resolve(process.cwd());
// Normalise CRLF→LF at read: these are source-text assertions, and git
// (core.autocrlf) checks the files out with CRLF on Windows.
const LANDING = readFileSync(resolve(ROOT, 'app/LandingPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
const HEADER  = readFileSync(resolve(ROOT, 'app/_landing/SiteHeader.tsx'), 'utf8').replace(/\r\n/g, '\n');

// Slice between two markers. Called INSIDE it() blocks only — an expect()
// at describe-collection time fails the whole file with "no tests".
function slice(startMarker: string, endMarker: string): string {
  const startIdx = LANDING.indexOf(startMarker);
  const endIdx   = LANDING.indexOf(endMarker, startIdx + 1);
  expect(startIdx, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  expect(endIdx,   `end marker not found: ${endMarker}`  ).toBeGreaterThan(startIdx);
  return LANDING.slice(startIdx, endIdx);
}

function count(needle: string): number {
  return LANDING.split(needle).length - 1;
}

const HERO  = () => slice('{/* ── Hero', '{/* ── Proof card');
const WHY   = () => slice('<section id="why"', '</section>');
const HOW   = () => slice('<section id="how"', '</section>');
const REQS  = () => slice('<section id="requirements"', '</section>');
const CALC  = () => slice('{/* ── Calculator', '{/* ── FAQ');
const FAQ   = () => slice('<section id="faq"', '</section>');
const FINAL = () => slice('{/* ── Final CTA', '<SiteFooter />');

// ─── 1. Forbidden strings ─────────────────────────────────────────────

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
    // v4: an unconditional fee promise contradicts the T&Cs' capped default
    // fee. "No fees" may only ever appear qualified by paying on time
    // (see the dedicated describe below) — these bare forms are banned.
    'No interest, no fees on your plan',
    'no fees added to your plan',
    'the total never grows beyond your original bill',
  ];

  for (const bad of FORBIDDEN) {
    it(`does NOT contain: "${bad}"`, () => {
      expect(LANDING).not.toContain(bad);
    });
  }
});


// ─── 2. Fee claims are conditional; interest claims are not ────────────

describe('Fee promises — always qualified by paying on time', () => {
  it('every sentence that promises "no fees" also says "on time"', () => {
    // Split rendered copy into sentences and check each one that mentions
    // "no fees" (or "with no fees") carries the on-time condition.
    const sentences = LANDING.split(/(?<=[.!?])\s+/);
    const feeClaims = sentences.filter((s) => /\bno fees\b/i.test(s));
    expect(feeClaims.length).toBeGreaterThan(0);
    for (const s of feeClaims) {
      expect(s, `unqualified fee promise: ${s}`).toMatch(/on (its due date|time)/i);
    }
  });

  it('the interest FAQ discloses the capped default fee and points at the Terms', () => {
    expect(FAQ()).toMatch(/Is it really interest-free\?/);
    expect(FAQ()).toMatch(/no interest is ever added/);
    expect(FAQ()).toMatch(/a capped default fee applies, as set out in our Terms/);
  });

  it('the WHY interest card keeps "never a cent more" tied to paying on the due date', () => {
    expect(WHY()).toMatch(/Pay each instalment on its due date and you repay exactly your bill — never a cent more, and no fees\./);
  });
});

// ─── Hero ─────────────────────────────────────────────────────────────

describe('Hero — offer-first, one patient CTA', () => {
  it('the H1 states the offer and names payday, not a single plan length', () => {
    // "Pay over payday" rather than "Pay in 3": entry-tier patients are
    // offered Pay in 2 only, so a Pay-in-3-only headline over-promises.
    expect(HERO()).toMatch(/<h1>\s*Get treated today\.\{' '\}\s*<em>Pay over payday\.<\/em>\s*<\/h1>/);
  });

  it('the subline names the specialties and the payday schedule', () => {
    expect(HERO()).toMatch(/Dentist, optometrist, specialist, vet, pharmacy/);
    expect(HERO()).toMatch(/the rest on your next paydays/);
  });

  it('primary CTA → /signup, secondary is a plain <a> to /#how (Link hash nav is a no-op)', () => {
    expect(HERO()).toMatch(/<Link className="l4-btn l4-btn-navy" href="\/signup">See what I qualify for/);
    expect(HERO()).toMatch(/<a className="l4-play" href="\/#how">/);
  });

  it('no practice CTA in the hero', () => {
    expect(HERO()).not.toContain('I run a practice');
    expect(HERO()).not.toMatch(/href="\/signup\/practice"/);
  });

  it('the hero photo is the optimised WebP, preloaded, with descriptive alt', () => {
    expect(HERO()).toMatch(/src="\/marketing\/hero-consultation\.webp"/);
    expect(HERO()).toMatch(/alt="A patient smiling[^"]+"/);
    // Next 16 deprecated `priority` in favour of `preload`.
    expect(HERO()).toMatch(/\bpreload\b/);
    expect(HERO()).not.toMatch(/\bpriority\b/);
  });

  it('the retired rotating-verb wordmark does not come back', () => {
    expect(LANDING).not.toContain('verb-slot');
    expect(LANDING).not.toContain('verb-marquee');
    expect(LANDING).not.toContain('const WORDS');
  });
});

// ─── 3. Approved slogans — present once, in their section ─────────────

describe('Approved slogans — each exactly once, in the right section', () => {
  it('S2 "Health can\'t wait. Payments can." is the How-it-works h2', () => {
    expect(HOW()).toMatch(/<h2>Health can&apos;t wait\. <span>Payments can\.<\/span><\/h2>/);
    expect(count('Health can&apos;t wait.')).toBe(1);
  });

  it('S3 "Take your bill in smaller doses." sits under the How h2', () => {
    expect(HOW()).toMatch(/<\/h2>\s*<p className="l4-how-sub">Take your bill in smaller doses\.<\/p>/);
    expect(count('Take your bill in smaller doses.')).toBe(1);
  });

  it('S4 "Give your health some credit — it\'s due." leads the requirements intro', () => {
    expect(REQS()).toMatch(/<p>Give your health some credit — it&apos;s due\./);
    expect(count('Give your health some credit')).toBe(1);
  });

  it('S7 "Full recovery. Zero interest." is the final band h2', () => {
    expect(FINAL()).toMatch(/<h2>Full recovery\. <em>Zero interest\.<\/em><\/h2>/);
    expect(count('Full recovery.')).toBe(1);
  });

  it('S6 "The best bill of health is one you can actually afford." sits in the final band', () => {
    expect(FINAL()).toMatch(/<p>The best bill of health is one you can actually afford\.<\/p>/);
    expect(count('The best bill of health')).toBe(1);
  });

  it('the final CTA is a SINGLE patient CTA → /signup', () => {
    expect(FINAL()).toMatch(/href="\/signup"/);
    expect(FINAL()).not.toContain('I run a practice');
    expect(FINAL()).not.toMatch(/href="\/signup\/practice"/);
  });
});

describe('Reserved slogans — absent from the landing page', () => {
  it('does NOT contain "First aid for big bills"', () => {
    expect(LANDING).not.toContain('First aid for big bills');
  });
  it('does NOT contain "Split the bill, not your priorities"', () => {
    expect(LANDING).not.toContain('Split the bill, not your priorities');
  });
});

// ─── 6. Why betternow — exactly 3 reason cards ────────────────────────

describe('Why betternow — EXACTLY 3 reason cards, in order', () => {
  it('three <h3> cards: Always interest-free → Flexible payment options → 1-minute approval', () => {
    const titles = [...WHY().matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Always interest-free', 'Flexible payment options', '1-minute approval']);
  });

  it('Flexible payment options names Pay in 2, Pay in 3 and salary dates', () => {
    expect(WHY()).toMatch(/Choose Pay in 2 or Pay in 3 — equal instalments timed to your salary dates/);
  });

  it('1-minute approval: in 1 minute, no paperwork, no branch visits', () => {
    expect(WHY()).toMatch(/Get approved online in 1 minute\. No paperwork, no branch visits\./);
  });
});

// ─── How it works ─────────────────────────────────────────────────────

describe('How it works — real app screenshot + one-open accordion', () => {
  it('uses the real device-approved.png screenshot (not a hand-drawn phone)', () => {
    expect(HOW()).toMatch(/src="\/marketing\/device-approved\.png"/);
    expect(HOW()).toMatch(/alt="betternow app showing an approved interest-free healthcare allowance"/);
  });

  it('three steps in order, each a button with aria-expanded/aria-controls', () => {
    const titles = [...LANDING.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
    expect(titles).toEqual(['Apply online', 'Choose Pay in 2 or Pay in 3', 'Pay over your paydays']);
    expect(HOW()).toMatch(/aria-expanded=\{openStep === i\}/);
    expect(HOW()).toMatch(/aria-controls=\{`l4-step-\$\{i\}`\}/);
    expect(HOW()).toMatch(/hidden=\{openStep !== i\}/);
  });

  it('step 3 describes card-charge collection on the chosen date', () => {
    expect(LANDING).toMatch(/Each instalment is charged to your saved card automatically on the date you chose/);
  });
});

// ─── What you'll need ─────────────────────────────────────────────────

describe("What you'll need — eligibility stated honestly", () => {
  it('four requirements: 18+, SA ID, debit or credit card, 1 minute', () => {
    const titles = [...REQS().matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    expect(titles).toEqual(['Be 18 or older', 'Your South African ID', 'A debit or credit card', '1 minute']);
  });

  it('names the good-credit requirement and the credit + affordability check', () => {
    expect(REQS()).toMatch(/With a good credit record/);
    expect(REQS()).toMatch(/credit and affordability check/);
  });

  it('POPIA line present', () => {
    expect(REQS()).toMatch(/handled in line with POPIA/);
  });
});

// ─── 7. Calculator ────────────────────────────────────────────────────

describe('Calculator — checkout\'s own maths, labelled as an illustration', () => {
  it('splits with lib/finance splitInstalments (the function checkout uses)', () => {
    expect(LANDING).toMatch(/import \{ splitInstalments \} from '@\/lib\/finance';/);
    expect(LANDING).toMatch(/const instalments = splitInstalments\(bill, plan\);/);
  });

  it('has a labelled range input and a Pay in 2 / Pay in 3 toggle with aria-pressed', () => {
    expect(CALC()).toMatch(/<label className="l4-bill" htmlFor="l4-bill-range">/);
    expect(CALC()).toMatch(/id="l4-bill-range"\s+type="range"/);
    expect(CALC()).toMatch(/aria-pressed=\{plan === 2\} onClick=\{\(\) => setPlan\(2\)\}>Pay in 2</);
    expect(CALC()).toMatch(/aria-pressed=\{plan === 3\} onClick=\{\(\) => setPlan\(3\)\}>Pay in 3</);
  });

  it('formats money deterministically (no toLocaleString → no hydration mismatch)', () => {
    expect(LANDING).not.toMatch(/\.toLocaleString\(/);
    expect(LANDING).toMatch(/from '\.\/patient\/_format'/);
  });

  it('says it is an illustration bounded by the approved allowance', () => {
    expect(CALC()).toMatch(/Illustration only\. What you can spend depends on your approved allowance/);
  });

  it('shows relative timing labels, never real dates', () => {
    expect(LANDING).toMatch(/const WHEN = \['Today', 'Next payday', 'The payday after'\];/);
  });
});

// ─── 5. Honest FAQ ────────────────────────────────────────────────────

describe('FAQ — honest allowance, credit-check and collection answers', () => {
  it('credit check answered YES', () => {
    expect(FAQ()).toMatch(/Is there a credit check\?/);
    expect(FAQ()).toMatch(/Yes — a quick credit and affordability check/);
    expect(FAQ()).toMatch(/you never take on more than you can manage/);
  });

  it('allowance described as a spending limit', () => {
    expect(FAQ()).toMatch(/interest-free healthcare allowance — a spending limit/);
  });

  it('collection = automatic card charges on chosen salary dates', () => {
    expect(FAQ()).toMatch(/Automatically charged to your saved card on the salary dates you choose/);
  });

  it('eligibility FAQ names 18+, good credit, card, ID', () => {
    expect(FAQ()).toMatch(/18 or older with a good credit record/);
    expect(FAQ()).toMatch(/debit or credit card \(Visa or Mastercard\)/);
    expect(FAQ()).toMatch(/your ID for a quick verification/);
  });

  it('security FAQ: encrypted, audited rails, POPIA', () => {
    expect(FAQ()).toMatch(/encrypted end-to-end and processed over secure, audited rails, and handled in line with POPIA/);
  });

  it('contact link routes to /contact', () => {
    expect(FAQ()).toMatch(/href="\/contact">Contact us/);
  });
});

// ─── 8. Practice content — absent ─────────────────────────────────────

describe('Practice content — lives on /practices, absent from landing', () => {
  it('no practice-signup CTA or practice-fee copy', () => {
    expect(LANDING).not.toMatch(/href="\/signup\/practice"/);
    expect(LANDING).not.toMatch(/What does it cost my practice\?/);
    expect(LANDING).not.toMatch(/less a small percentage we keep as our fee/);
    expect(LANDING).not.toMatch(/Paid upfront|Collection is on us|Get paid upfront/);
  });
});

// ─── 9. Header / footer wiring + section order ────────────────────────

describe('Shared chrome + redirect', () => {
  it('landing imports the shared SiteHeader + SiteFooter', () => {
    expect(LANDING).toMatch(/from '\.\/_landing\/SiteHeader'/);
    expect(LANDING).toMatch(/from '\.\/_landing\/SiteFooter'/);
  });

  it('client-side redirect from the legacy #practices anchor to /practices', () => {
    expect(LANDING).toMatch(/window\.location\.hash === '#practices'/);
    expect(LANDING).toMatch(/window\.location\.replace\('\/practices'\)/);
  });

  it('v4 styles are scoped under .lp-v4 on the root (shared .lp-root pages untouched)', () => {
    expect(LANDING).toMatch(/<div className="lp-root lp-v4">/);
    expect(LANDING).not.toMatch(/lp-v3/);
  });
});

describe('Landing section order — Hero → Why → How → Needs → Calculator → FAQ → Final', () => {
  it('sections appear in order', () => {
    const order = [
      '{/* ── Hero',
      'id="why"',
      'id="how"',
      'id="requirements"',
      '{/* ── Calculator',
      'id="faq"',
      '{/* ── Final CTA',
    ].map((m) => LANDING.indexOf(m));
    order.forEach((idx) => expect(idx).toBeGreaterThan(-1));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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

  it('the persistent header pill is Sign in, not Get started — the hero already has that CTA', () => {
    // Scoped to the <div className="nav-cta"> cluster specifically —
    // the mobile dropdown further down legitimately still offers BOTH
    // Get started and Sign in as separate links once opened.
    const navCta = HEADER.slice(HEADER.indexOf('<div className="nav-cta">'), HEADER.indexOf('</div>', HEADER.indexOf('<div className="nav-cta">')));
    expect(navCta).toMatch(/<Link className="nav-signin" href="\/login">Sign in<\/Link>/);
    expect(navCta).not.toMatch(/className="nav-get"/);
    expect(navCta).not.toMatch(/>Get started</);
    expect(navCta).toMatch(/data-testid="site-header-burger"/);
  });

  it('has "For practices" pointing at /practices (not a legacy hash anchor)', () => {
    expect(HEADER).toMatch(/href="\/practices"/);
    expect(HEADER).not.toMatch(/href="#practices"/);
  });
});

// ─── Diff scope — landing page only ───────────────────────────────────

describe('Diff scope — no payment / auth / webhook modules on the landing', () => {
  it('imports nothing from payment, webhook, lifecycle or auth code', () => {
    const FORBIDDEN = [
      '@/lib/payments/',
      '@/lib/paystack/',
      '@/lib/bills/lifecycle',
      'app/api/webhooks/paystack',
      '@/lib/auth/',
    ];
    for (const mod of FORBIDDEN) {
      expect(LANDING).not.toContain(`from '${mod}`);
      expect(LANDING).not.toContain(`from "${mod}`);
    }
  });

  it('from @/lib/finance it takes ONLY the pure splitInstalments', () => {
    // The calculator must show checkout's real split, so this one pure
    // function is allowed; anything else from finance stays off the page.
    const financeImports = [...LANDING.matchAll(/import \{([^}]+)\} from '@\/lib\/finance'/g)]
      .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    expect(financeImports).toEqual(['splitInstalments']);
  });
});
