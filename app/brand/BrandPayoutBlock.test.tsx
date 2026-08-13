import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import BrandPayoutBlock from './BrandPayoutBlock';
import { formatRand } from '@/app/practice/billHelpers';
import { PAYOUT_STATUS_CHIP, PAYOUT_ESTIMATE_BADGE } from '@/app/practice/payoutCopy';
import type { BrandPayoutRollup, BrandPracticePayout } from '@/lib/brand/brandPayouts';

// ─── Overview's money block ────────────────────────────────────────────────
//
// Two failures would matter here, and everything below is aimed at one of them:
//
//   A. The group total is presented as a single transfer. A brand admin goes
//      looking for R41,180.00, finds three smaller deposits, and cannot tell
//      whether that is three deposits or a shortfall.
//
//   B. A closed-but-unpaid batch reads as money that has arrived. Settlement is
//      a manual EFT an admin runs, so this state is normal and can last days.
//
// (B) is asserted the way the practice payouts tab asserts it: on the ACTUAL
// RENDERED STRINGS, against a vocabulary of completed-arrival constructions,
// plus a complement test proving every "transfer" word on an unpaid row sits in
// a future or negative construction. Colour is never accepted as a signal.

afterEach(cleanup);

const NAV = '2026-08-21';   // a Friday

function row(over: Partial<BrandPracticePayout> & { practiceId: string }): BrandPracticePayout {
  return {
    practiceName: over.practiceId,
    state: 'awaiting',
    totalNet: 1000,
    planCount: 2,
    dates: { payoutDate: NAV, windowFirst: '2026-08-13', windowLast: '2026-08-19' },
    paidRecentlyNet: 0,
    paidRecentlyCount: 0,
    otherPendingCount: 0,
    otherPendingNet: 0,
    strandedCount: 0,
    ...over,
  };
}

function rollup(over: Partial<BrandPayoutRollup> & { perPractice: BrandPracticePayout[] }): BrandPayoutRollup {
  const contributing = over.perPractice.filter((p) => p.state !== 'none');
  return {
    depositCount:  contributing.length,
    totalNet:      contributing.reduce((s, p) => s + p.totalNet, 0),
    planCount:     contributing.reduce((s, p) => s + p.planCount, 0),
    awaitingCount: contributing.filter((p) => p.state === 'awaiting').length,
    openCount:     contributing.filter((p) => p.state === 'open').length,
    payoutDates:   [...new Set(contributing.map((p) => p.dates.payoutDate).filter((d): d is string => !!d))].sort(),
    paidRecentlyNet:   0,
    paidRecentlyCount: 0,
    otherPendingCount: 0,
    otherPendingNet:   0,
    strandedCount:     0,
    ...over,
  };
}

const THREE = [
  row({ practiceId: 'p-a', practiceName: 'Rosebank', totalNet: 12400,    planCount: 5 }),
  row({ practiceId: 'p-b', practiceName: 'Sandton',  totalNet: 14600,    planCount: 6 }),
  row({ practiceId: 'p-c', practiceName: 'Midrand',  totalNet: 14180.55, planCount: 4 }),
];

const COUNTS = { 'p-a': 41, 'p-b': 52, 'p-c': 18 };

function mount(r: BrandPayoutRollup, counts: Record<string, number> = COUNTS) {
  return render(<BrandPayoutBlock rollup={r} activePlanCounts={counts} />);
}

// ─── The deposit count, explicitly ─────────────────────────────────────────

describe('the hero states how many separate deposits the total is', () => {
  it('names the practice count AND the deposit count, in the same breath as the total', () => {
    mount(rollup({ perPractice: THREE }));
    expect(screen.getByTestId('brand-deposit-summary').textContent)
      .toBe('Across 3 practices · 3 separate deposits');
  });

  it('says the total is NEVER one transfer, naming the figure it would have been', () => {
    mount(rollup({ perPractice: THREE }));
    const note = screen.getByTestId('brand-separate-deposits').textContent ?? '';
    expect(note).toContain('3 separate deposits');
    expect(note).toContain('never one transfer of');
    expect(note).toContain(formatRand(12400 + 14600 + 14180.55));
    expect(note).toContain('Reconcile each practice below against its own deposit.');
  });

  it('the total equals the sum of the rendered per-practice amounts, to the cent', () => {
    const r = rollup({ perPractice: THREE });
    mount(r);
    const shown = THREE.map((p) => screen.getByTestId(`brand-practice-amount-${p.practiceId}`).textContent);
    expect(shown).toEqual(THREE.map((p) => formatRand(p.totalNet)));
    expect(screen.getByTestId('brand-payout-total').textContent).toBe(formatRand(r.totalNet));
    // And the arithmetic itself, not just that both render.
    expect(r.totalNet).toBe(41180.55);
  });

  it('a single-practice payout says so in the singular, without pretending to be plural', () => {
    mount(rollup({ perPractice: [THREE[0], row({ practiceId: 'p-b', state: 'none', totalNet: 0, planCount: 0 })] }));
    expect(screen.getByTestId('brand-deposit-summary').textContent)
      .toBe('Across 1 practice · 1 separate deposit');
    expect(screen.getByTestId('brand-separate-deposits').textContent)
      .toContain('single deposit into that practice’s own account');
  });

  it('the deposit count follows practices with money, not practices in the group', () => {
    const withIdle = [...THREE, row({ practiceId: 'p-d', practiceName: 'Fourways', state: 'none', totalNet: 0, planCount: 0 })];
    mount(rollup({ perPractice: withIdle }));
    expect(screen.getByTestId('brand-deposit-summary').textContent).toContain('3 separate deposits');
    // But all four are still listed — an idle practice is useful information.
    expect(screen.getByTestId('brand-practice-row-p-d')).toBeTruthy();
    expect(screen.getByTestId('brand-practice-none-p-d').textContent).toBe('None scheduled');
  });
});

// ─── Honesty: nothing unpaid may read as arrived ───────────────────────────

describe('closed-but-unpaid never claims the money has landed', () => {
  /**
   * Completed-arrival constructions only. Deliberately NOT a bare /transferred/:
   * the CORRECT copy "It's due to be transferred on Friday" contains that word,
   * so banning it outright would fail against honest text. The complement test
   * below covers the tense question directly.
   */
  const ARRIVAL_CLAIMS = [
    /\bpaid\b/i, /\breceived\b/i, /\bdeposited\b/i, /\blanded\b/i,
    /\bsettled\b/i, /\bcleared\b/i, /in your account/i,
    /\b(?:has been|was|we) transferred\b/i, /\barrived\b/i,
  ];

  function unpaidText(): string {
    // Everything on the block except the "Paid out — last 30 days" figure,
    // which is the ONE place a completed claim is true.
    const block = screen.getByTestId('brand-payout-block');
    const paid  = screen.getByTestId('brand-paid-recently');
    const clone = block.cloneNode(true) as HTMLElement;
    clone.querySelector(`[data-testid="${paid.getAttribute('data-testid')}"]`)?.remove();
    return clone.textContent ?? '';
  }

  it('an all-awaiting group makes no completed-arrival claim anywhere', () => {
    mount(rollup({ perPractice: THREE }));
    const text = unpaidText();
    for (const claim of ARRIVAL_CLAIMS) {
      expect(text, `matched ${claim}`).not.toMatch(claim);
    }
  });

  it('every "transfer" word in the PROSE sits in a future or negative construction', () => {
    // The complement of the list above: rather than banning the word, prove each
    // occurrence is placed in time honestly.
    //
    // Scoped to the sentences, not to the whole block, because the chip label
    // ("Awaiting transfer") is a NOUN PHRASE naming a state rather than a claim
    // about time — it has no verb to place, and it is asserted exactly, against
    // the shared constant, in its own test below. Running the tense check over
    // concatenated textContent would also splice unrelated elements into one
    // pseudo-sentence and prove nothing either way.
    mount(rollup({ perPractice: THREE, otherPendingCount: 2, otherPendingNet: 900 }));
    const prose = [
      'brand-separate-deposits', 'brand-payout-mixed', 'brand-payout-multi-date',
      'brand-payout-other-pending', 'brand-payout-stranded', 'brand-payout-when',
    ]
      .map((id) => screen.queryByTestId(id)?.textContent ?? '')
      .join(' ');

    const sentences = prose.split(/(?<=[.!])\s+/).filter((s) => /transfer/i.test(s));
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      expect(
        /to be transferred|hasn’t|has not|never one transfer/i.test(sentence),
        `unplaced: "${sentence.trim()}"`,
      ).toBe(true);
    }
  });

  it('the chip on an awaiting row says "Awaiting transfer", the shared word', () => {
    mount(rollup({ perPractice: THREE }));
    for (const p of THREE) {
      expect(screen.getByTestId(`brand-practice-chip-${p.practiceId}`).textContent)
        .toBe(PAYOUT_STATUS_CHIP.awaiting.label);
    }
  });

  it('the date on an awaiting row is captioned "Due", never left bare', () => {
    // A bare date beside an amount is read as the day it was paid.
    mount(rollup({ perPractice: [THREE[0]] }));
    const line = screen.getByTestId('brand-practice-row-p-a').textContent ?? '';
    expect(line).toContain('Due');
    expect(line).toMatch(/Friday 21 Aug/);
  });

  it('the word "Paid" appears ONLY in the 30-day figure, nowhere on an unpaid row', () => {
    mount(rollup({ perPractice: THREE, paidRecentlyNet: 5000, paidRecentlyCount: 2 }));
    expect(screen.getByTestId('brand-paid-recently').textContent).toContain('Paid out');
    for (const p of THREE) {
      expect(screen.getByTestId(`brand-practice-row-${p.practiceId}`).textContent)
        .not.toMatch(/\bPaid\b/);
    }
  });
});

// ─── Estimates ────────────────────────────────────────────────────────────

describe('an open week is marked as an estimate, in the hero\'s own vocabulary', () => {
  const MIXED = [
    row({ practiceId: 'p-a', practiceName: 'Rosebank', state: 'awaiting', totalNet: 1000 }),
    row({ practiceId: 'p-b', practiceName: 'Sandton',  state: 'open',     totalNet: 500 }),
  ];

  it('reuses the badge word the practice hero coined — not a second vocabulary', () => {
    mount(rollup({ perPractice: MIXED }));
    expect(screen.getByTestId('brand-payout-estimate-badge').textContent).toBe(PAYOUT_ESTIMATE_BADGE);
    expect(screen.getByTestId('brand-practice-chip-p-b').textContent).toBe(PAYOUT_STATUS_CHIP.open.label);
  });

  it('a mixed total says part of it is still an estimate', () => {
    mount(rollup({ perPractice: MIXED }));
    expect(screen.getByTestId('brand-payout-mixed').textContent)
      .toContain('Part of this total is still an estimate');
  });

  it('an all-final total carries NO estimate badge and no mixed note', () => {
    mount(rollup({ perPractice: THREE }));
    expect(screen.queryByTestId('brand-payout-estimate-badge')).toBeNull();
    expect(screen.queryByTestId('brand-payout-mixed')).toBeNull();
  });

  it('a group holding ANY open week takes the less certain state — never stamps "final" on a moving figure', () => {
    mount(rollup({ perPractice: MIXED }));
    expect(screen.getByTestId('brand-payout-estimate-badge')).toBeTruthy();
    // And the group date caption is the open one.
    expect(screen.getByTestId('brand-payout-when').textContent).toMatch(/^Expected/);
  });

  it('an all-awaiting group captions its date "Due"', () => {
    mount(rollup({ perPractice: THREE }));
    expect(screen.getByTestId('brand-payout-when').textContent).toMatch(/^Due/);
  });
});

// ─── Dates ────────────────────────────────────────────────────────────────

describe('the hero names a date only when there IS one', () => {
  it('names it when every deposit lands the same day', () => {
    mount(rollup({ perPractice: THREE }));
    expect(screen.getByTestId('brand-payout-when').textContent).toContain('Friday 21 Aug');
    expect(screen.queryByTestId('brand-payout-multi-date')).toBeNull();
  });

  it('names NO date when the deposits land on different days', () => {
    // Naming the earliest would read as the day the whole total arrives.
    const split = [
      row({ practiceId: 'p-a', dates: { payoutDate: '2026-08-14', windowFirst: '2026-08-06', windowLast: '2026-08-12' } }),
      row({ practiceId: 'p-b', dates: { payoutDate: '2026-08-21', windowFirst: '2026-08-13', windowLast: '2026-08-19' } }),
    ];
    mount(rollup({ perPractice: split }));
    expect(screen.queryByTestId('brand-payout-when')).toBeNull();
    expect(screen.getByTestId('brand-payout-multi-date').textContent)
      .toContain('don’t all arrive on the same day');
    // Each row still carries its own.
    expect(screen.getByTestId('brand-practice-row-p-a').textContent).toMatch(/Friday 14 Aug/);
    expect(screen.getByTestId('brand-practice-row-p-b').textContent).toMatch(/Friday 21 Aug/);
  });
});

// ─── Practice rows as doorways ─────────────────────────────────────────────

describe('each row is a doorway into that practice, and states its own numbers', () => {
  it('links through the existing pivot, which carries the scope', () => {
    mount(rollup({ perPractice: THREE }));
    for (const p of THREE) {
      const link = screen.getByTestId(`brand-practice-link-${p.practiceId}`);
      expect(link.getAttribute('href')).toBe(`/brand/branch/${p.practiceId}`);
      expect(link.textContent).toBe(p.practiceName);
    }
  });

  it('shows that practice\'s own active plan count, not the group\'s', () => {
    mount(rollup({ perPractice: THREE }));
    expect(screen.getByTestId('brand-practice-plans-p-a').textContent).toBe('41 active plans');
    expect(screen.getByTestId('brand-practice-plans-p-b').textContent).toBe('52 active plans');
  });

  it('singularises a count of one', () => {
    mount(rollup({ perPractice: [THREE[0]] }), { 'p-a': 1 });
    expect(screen.getByTestId('brand-practice-plans-p-a').textContent).toBe('1 active plan');
  });

  it('shows zero rather than nothing for a practice with no active plans', () => {
    mount(rollup({ perPractice: [THREE[0]] }), {});
    expect(screen.getByTestId('brand-practice-plans-p-a').textContent).toBe('0 active plans');
  });

  it('a practice with nothing scheduled gets no chip, no amount and no date', () => {
    mount(rollup({ perPractice: [row({ practiceId: 'p-z', practiceName: 'Idle', state: 'none', totalNet: 0, planCount: 0, dates: { payoutDate: null, windowFirst: null, windowLast: null } })] }));
    expect(screen.queryByTestId('brand-practice-chip-p-z')).toBeNull();
    expect(screen.queryByTestId('brand-practice-amount-p-z')).toBeNull();
    expect(screen.getByTestId('brand-practice-none-p-z').textContent).toBe('None scheduled');
    // And emphatically not R0.00, which reads as a measured figure.
    expect(screen.getByTestId('brand-practice-row-p-z').textContent).not.toContain('R0.00');
  });

  it('carries the state on the row itself, so a test cannot be fooled by colour alone', () => {
    mount(rollup({ perPractice: [
      row({ practiceId: 'p-a', state: 'awaiting' }),
      row({ practiceId: 'p-b', state: 'open' }),
      row({ practiceId: 'p-c', state: 'none', totalNet: 0 }),
    ] }));
    expect(screen.getByTestId('brand-practice-row-p-a').getAttribute('data-state')).toBe('awaiting');
    expect(screen.getByTestId('brand-practice-row-p-b').getAttribute('data-state')).toBe('open');
    expect(screen.getByTestId('brand-practice-row-p-c').getAttribute('data-state')).toBe('none');
  });
});

// ─── Empty state ──────────────────────────────────────────────────────────

describe('no payouts anywhere in the brand', () => {
  const IDLE = rollup({
    perPractice: [
      row({ practiceId: 'p-a', practiceName: 'Rosebank', state: 'none', totalNet: 0, planCount: 0, dates: { payoutDate: null, windowFirst: null, windowLast: null } }),
      row({ practiceId: 'p-b', practiceName: 'Sandton',  state: 'none', totalNet: 0, planCount: 0, dates: { payoutDate: null, windowFirst: null, windowLast: null } }),
    ],
  });

  it('says nothing is scheduled — and does NOT render a fabricated R0.00 total', () => {
    mount(IDLE);
    expect(screen.getByTestId('brand-payout-empty').textContent).toContain('Nothing scheduled yet');
    expect(screen.queryByTestId('brand-payout-total')).toBeNull();
    expect(screen.queryByTestId('brand-deposit-summary')).toBeNull();
  });

  it('claims nothing about what the brand is owed', () => {
    mount(IDLE);
    const text = screen.getByTestId('brand-payout-empty').textContent ?? '';
    expect(text).not.toMatch(/owed nothing|no payouts due|R0/i);
  });

  it('still lists the practices, so the reader knows the list was not empty', () => {
    mount(IDLE);
    expect(screen.getByTestId('brand-practice-row-p-a')).toBeTruthy();
    expect(screen.getByTestId('brand-practice-row-p-b')).toBeTruthy();
  });

  it('the paid-out-30-days figure still renders — it is a different question', () => {
    mount(rollup({ ...IDLE, perPractice: IDLE.perPractice, paidRecentlyNet: 8000, paidRecentlyCount: 3 }));
    expect(screen.getByTestId('brand-paid-recently').textContent).toContain(formatRand(8000));
    expect(screen.getByTestId('brand-paid-recently').textContent).toContain('3 payouts');
  });
});

// ─── Footnotes ────────────────────────────────────────────────────────────

describe('earlier unsettled batches are reported as EXTRA deposits', () => {
  it('says they are on top of the total, each its own deposit', () => {
    mount(rollup({ perPractice: THREE, otherPendingCount: 2, otherPendingNet: 3300.25 }));
    const note = screen.getByTestId('brand-payout-other-pending').textContent ?? '';
    expect(note).toContain('2 earlier payouts');
    expect(note).toContain(formatRand(3300.25));
    expect(note).toContain('on top of the total above');
    expect(note).toContain('each arrives as its own deposit');
  });

  it('stranded plans are surfaced with no date attached', () => {
    mount(rollup({ perPractice: THREE, strandedCount: 3 }));
    const note = screen.getByTestId('brand-payout-stranded').textContent ?? '';
    expect(note).toContain('3 plans');
    expect(note).toContain('not in a payout yet');
    expect(note).not.toMatch(/Fri|Aug|\d{4}-\d{2}-\d{2}/);
  });

  it('renders no footnote strip when there is nothing to footnote', () => {
    mount(rollup({ perPractice: THREE }));
    expect(screen.queryByTestId('brand-payout-other-pending')).toBeNull();
    expect(screen.queryByTestId('brand-payout-stranded')).toBeNull();
  });
});

// ─── Source pins ─────────────────────────────────────────────────────────

describe('source pins — shared helpers only, no formatting of its own', () => {
  const SRC   = readFileSync(resolve(process.cwd(), 'app/brand/BrandPayoutBlock.tsx'), 'utf8');
  const code  = stripComments(SRC);
  const COPY  = readFileSync(resolve(process.cwd(), 'app/brand/brandPayoutCopy.ts'), 'utf8');
  const ccode = stripComments(COPY);

  it('formats money through the shared formatRand and nothing else', () => {
    expect(code).toMatch(/import \{ formatRand \} from '@\/app\/practice\/billHelpers'/);
    expect(code).not.toMatch(/toFixed|toLocaleString|replace\(\/\\B/);
    expect(code).not.toMatch(/`R\$\{/);
  });

  it('formats dates through the shared formatter and does no date maths', () => {
    expect(code).toMatch(/formatWeekdayDayMonth/);
    expect(code).not.toMatch(/new Date\(|toISOString|getDay\(|getMonth\(|toLocaleDateString/);
    // No weekday or month literal — if the payout boundary moves, this follows.
    expect(code).not.toMatch(/\bFriday\b|\bThursday\b|\bAug\b/);
  });

  it('takes its three certainties from the practice-side copy module', () => {
    expect(code).toMatch(/from '@\/app\/practice\/payoutCopy'/);
    expect(ccode).toMatch(/from '@\/app\/practice\/payoutCopy'/);
    expect(ccode).toMatch(/PAYOUT_STATUS_CHIP/);
    expect(ccode).toMatch(/PAYOUT_DATE_CAPTION/);
  });

  it('the copy module re-declares none of the three chips or captions', () => {
    // It re-exports them. A local Record would be the second vocabulary.
    expect(ccode).not.toMatch(/const PAYOUT_STATUS_CHIP[^=]*=/);
    expect(ccode).not.toMatch(/awaiting:\s*\{ label/);
  });

  it('the copy module formats nothing — pure strings and interpolation', () => {
    expect(ccode).not.toMatch(/new Date\(|toFixed|toLocaleString|Intl\./);
  });

  it('never says MDR — practice-facing copy says BetterNow fee', () => {
    expect(code).not.toMatch(/\bMDR\b/);
    expect(ccode).not.toMatch(/\bMDR\b/);
  });

  it('sums nothing itself — the loader hands it a total', () => {
    // A component that re-adds the rows is a second arithmetic, and the two can
    // disagree by a cent.
    expect(code).not.toMatch(/\.reduce\(/);
  });
});
