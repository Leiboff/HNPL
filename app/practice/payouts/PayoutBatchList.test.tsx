import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PayoutBatchList from './PayoutBatchList';
import { formatRand } from '../billHelpers';
import { stripComments } from '@/lib/testing/stripComments';
import { payoutWindowEndingOn } from '@/lib/payments/payoutWindow';
import { payoutDateFor, windowDates, openPayoutWindow } from '@/lib/payments/payoutSchedule';
import type {
  PayoutHistory, PayoutHistoryEntry, PayoutHistoryPlanLine,
} from '@/lib/practice/payoutHistory';

// ─── The payouts tab, and the one thing it must never do ───────────────────
//
// Settlement is manual: an admin runs the EFT and clicks Mark paid. So a batch
// sits CLOSED-BUT-UNPAID — final amount, money still on our side — sometimes
// for days. Presenting that as money in the practice's account is the single
// worst thing this screen could do, and most of what follows is about it:
// there is a whole-vocabulary absence assertion against the rendered strings,
// not just a check that the chip says the right word.
//
// The other promise being tested is arithmetic in public: the per-plan nets a
// row expands to must add up to the amount printed above them, because that
// amount is what a practice ticks off against a bank deposit.

const NOW      = new Date('2026-08-14T07:00:00.000Z');
const W_AUG_13 = payoutWindowEndingOn('2026-08-13'); // Thu 6  – Wed 12, due Fri 14
const W_AUG_06 = payoutWindowEndingOn('2026-08-06'); // Thu 30 – Wed 5,  due Fri 7
const OPEN     = openPayoutWindow(NOW);              // Thu 13 – Wed 19, due Fri 21

function line(over: Partial<PayoutHistoryPlanLine> & { payoutId: string }): PayoutHistoryPlanLine {
  return {
    planId:            `pl-${over.payoutId}`,
    patientLabel:      'Thabo M.',
    invoiceNumber:     `INV-${over.payoutId}`,
    practiceReference: null,
    grossAmount:       1000,
    feeAmount:         60,
    netAmount:         940,
    activatedAt:       '2026-08-10T08:00:00.000Z',
    ...over,
  };
}

const datesFor = (w: typeof W_AUG_13, paidDate: string | null = null) => ({
  payoutDate:  payoutDateFor(w),
  windowFirst: windowDates(w).firstDate,
  windowLast:  windowDates(w).lastDate,
  paidDate,
});

function entry(over: Partial<PayoutHistoryEntry> & { key: string }): PayoutHistoryEntry {
  const plans = over.plans ?? [line({ payoutId: 'p1' })];
  const netSum = plans.reduce((s, p) => s + p.netAmount, 0);
  return {
    kind:            'awaiting',
    batchId:         over.key,
    window:          W_AUG_13,
    totalNet:        netSum,
    planCount:       plans.length,
    dates:           datesFor(W_AUG_13),
    overdue:         false,
    plansHidden:     false,
    plansNetSum:     netSum,
    sumMatchesTotal: true,
    ...over,
    plans,
  };
}

const history = (entries: PayoutHistoryEntry[], over: Partial<PayoutHistory> = {}): PayoutHistory => ({
  entries, batchCount: entries.length, truncated: false, ...over,
});

const AWAITING = entry({ key: 'b-await', kind: 'awaiting' });
const PAID = entry({
  key: 'b-paid', kind: 'paid',
  window: W_AUG_06, dates: datesFor(W_AUG_06, '2026-08-07'),
});
const OPEN_WEEK = entry({
  key: 'open', kind: 'open', batchId: null,
  window: OPEN, dates: datesFor(OPEN),
});

const renderList = (h: PayoutHistory) => render(<PayoutBatchList history={h} />);

/**
 * Claims that the money has already moved.
 *
 * Deliberately NOT the bare verb "transferred": "it's due to be transferred on
 * Friday 14 Aug" is the correct copy for an unpaid batch and contains it. What
 * must never appear is a COMPLETED construction — so the past/perfect forms are
 * listed, and the test below separately asserts that the row's one mention of
 * transferring really is in a future or negative one.
 */
const ARRIVAL_CLAIMS = [
  /\bpaid\b/i, /\breceived\b/i, /\bdeposited\b/i, /\blanded\b/i,
  /\bsettled\b/i, /\bin your account\b/i, /\bcleared\b/i,
  /\btransferred to your bank\b/i, /\b(?:has been|was|we) transferred\b/i,
  /\bhas been paid\b/i,
];

// ─── The two closed states look nothing alike ─────────────────────────────

describe('paid vs closed-but-unpaid', () => {
  it('carries visibly different status words', () => {
    renderList(history([AWAITING, PAID]));
    expect(screen.getByTestId('payout-batch-status:b-await').textContent).toBe('Awaiting transfer');
    expect(screen.getByTestId('payout-batch-status:b-paid').textContent).toBe('Paid');
  });

  it('separates them by a non-colour channel — the word, and the caption', () => {
    // A reader who cannot tell amber from green still gets two different
    // sentences and two different date captions.
    renderList(history([AWAITING, PAID]));
    expect(screen.getByTestId('payout-batch:b-await').textContent).toMatch(/Due/);
    expect(screen.getByTestId('payout-batch:b-paid').textContent).toMatch(/Transferred/);
  });

  it('marks the kind on the row itself, so styling cannot be the only signal', () => {
    renderList(history([AWAITING, PAID]));
    expect(screen.getByTestId('payout-batch:b-await').getAttribute('data-kind')).toBe('awaiting');
    expect(screen.getByTestId('payout-batch:b-paid').getAttribute('data-kind')).toBe('paid');
  });
});

// ─── THE honesty assertion ────────────────────────────────────────────────

describe('a closed-but-unpaid batch never claims the money arrived', () => {
  it('says the amount is final AND that the transfer has not gone out', () => {
    renderList(history([AWAITING]));
    const note = screen.getByTestId('payout-batch-note:b-await').textContent ?? '';
    expect(note).toMatch(/This amount is final/);
    expect(note).toMatch(/due to be transferred/);
  });

  it('contains NO completed-transfer claim, anywhere on the row', () => {
    // Asserted over the whole rendered row rather than the one sentence: the
    // chip, the caption, the window line and the toggle are all on it, and any
    // of them saying "Paid" would be the bug.
    renderList(history([AWAITING]));
    const row = screen.getByTestId('payout-batch:b-await').textContent ?? '';
    for (const claim of ARRIVAL_CLAIMS) {
      expect(row, `awaiting row must not match ${claim}`).not.toMatch(claim);
    }
  });

  it('mentions transferring ONLY in a future or negative construction', () => {
    // The complement of the list above, which cannot forbid the bare verb
    // because the honest copy uses it. Every occurrence on an unpaid row must
    // be preceded by "due to be" or sit inside "hasn't gone out yet".
    for (const e of [
      AWAITING,
      entry({ key: 'b-late', overdue: true, window: W_AUG_06, dates: datesFor(W_AUG_06) }),
    ]) {
      const { unmount } = renderList(history([e]));
      const row = screen.getByTestId(`payout-batch:${e.key}`).textContent ?? '';
      const mentions = row.match(/\btransfer\w*/gi) ?? [];
      for (const m of mentions) {
        expect(
          new RegExp(`(?:due to be|Awaiting) ${m}`).test(row) || /hasn’t gone out yet/.test(row),
          `"${m}" on ${e.key} is not in a future or negative construction: ${row}`,
        ).toBe(true);
      }
      unmount();
    }
  });

  it('names its due date in the FUTURE tense, never as a bare date', () => {
    renderList(history([AWAITING]));
    const row = screen.getByTestId('payout-batch:b-await').textContent ?? '';
    // The caption above the date, and the verb in the sentence below it.
    expect(row).toMatch(/Due/);
    expect(row).toMatch(/It’s due to be transferred on Friday 14 Aug/);
  });

  it('stops naming a date once the due day has passed', () => {
    // "Due to be transferred on Friday 7 Aug", read on the 14th, reads as a
    // claim that it happened. So an overdue batch drops the date entirely.
    renderList(history([entry({
      key: 'b-late', kind: 'awaiting', overdue: true,
      window: W_AUG_06, dates: datesFor(W_AUG_06),
    })]));
    const note = screen.getByTestId('payout-batch-note:b-late').textContent ?? '';
    expect(note).toMatch(/This amount is final/);
    expect(note).toMatch(/hasn’t gone out yet/);
    expect(note).not.toMatch(/due to be transferred on/);
    expect(note).not.toMatch(/Aug/);
  });

  it('does not call itself an estimate either — the amount IS final', () => {
    // The opposite failure: hedging a closed batch would understate a promise
    // the practice can rely on.
    renderList(history([AWAITING]));
    const row = screen.getByTestId('payout-batch:b-await').textContent ?? '';
    expect(row).not.toMatch(/Estimate/);
    expect(row).not.toMatch(/isn’t final/);
  });
});

// ─── A paid batch says what actually happened ─────────────────────────────

describe('a paid batch', () => {
  it('names the day the transfer left, from paid_at', () => {
    renderList(history([PAID]));
    expect(screen.getByTestId('payout-batch-date:b-paid').textContent)
      .toBe('Friday 7 Aug');
    expect(screen.getByTestId('payout-batch-note:b-paid').textContent)
      .toBe('Transferred to your bank on Friday 7 Aug.');
  });

  it('claims the transfer left our side, not that it has cleared theirs', () => {
    // An EFT is not instant. "Arrived" would be the same overclaim one step
    // further along.
    renderList(history([PAID]));
    const note = screen.getByTestId('payout-batch-note:b-paid').textContent ?? '';
    expect(note).not.toMatch(/arrived|in your account|cleared/i);
  });
});

// ─── The open week is the hero's estimate, in the hero's words ─────────────

describe('the in-progress window', () => {
  it('is badged Estimate, with the same word the dashboard hero uses', () => {
    renderList(history([OPEN_WEEK]));
    expect(screen.getByTestId('payout-batch-status:open').textContent).toBe('Estimate');
  });

  it('carries the hero\'s "Building this week" label and its not-final note', () => {
    renderList(history([OPEN_WEEK]));
    const row = screen.getByTestId('payout-batch:open').textContent ?? '';
    expect(row).toMatch(/Building this week/);
    const note = screen.getByTestId('payout-batch-note:open').textContent ?? '';
    expect(note).toMatch(/still open/);
    expect(note).toMatch(/isn’t final/);
    expect(note).toMatch(/19 Aug/);
  });

  it('says Expected, not Due — the verb carries the uncertainty', () => {
    renderList(history([OPEN_WEEK]));
    const date = screen.getByTestId('payout-batch-date:open').textContent ?? '';
    expect(date).toMatch(/Expected Friday 21 Aug/);
    expect(screen.getByTestId('payout-batch:open').textContent).not.toMatch(/\bDue\b/);
  });

  it('is word-for-word the vocabulary the hero renders, not a paraphrase', async () => {
    // Both surfaces import ../payoutCopy. This proves the shared strings are
    // actually what reaches the screen on this one.
    const copy = await import('../payoutCopy');
    renderList(history([OPEN_WEEK]));
    expect(screen.getByTestId('payout-batch-status:open').textContent)
      .toBe(copy.PAYOUT_ESTIMATE_BADGE);
    expect(screen.getByTestId('payout-batch:open').textContent)
      .toContain(copy.PAYOUT_BUILDING_LABEL);
    expect(screen.getByTestId('payout-batch-note:open').textContent)
      .toBe(copy.payoutEstimateNote('19 Aug'));
  });
});

// ─── The window sentence ──────────────────────────────────────────────────

describe('every row states its window in plain language', () => {
  it('matches the shared helper for that batch, inclusive last day', () => {
    renderList(history([AWAITING]));
    const w = screen.getByTestId('payout-batch-window:b-await').textContent ?? '';
    expect(w).toMatch(/Covers plans activated/);
    expect(w).toMatch(/Thursday 6 Aug/);
    expect(w).toMatch(/Wednesday 12 Aug/);
    // Never the exclusive Thursday boundary.
    expect(w).not.toMatch(/13 Aug/);
  });

  it('an older batch keeps its OWN week, not one recomputed from today', () => {
    renderList(history([PAID]));
    const w = screen.getByTestId('payout-batch-window:b-paid').textContent ?? '';
    expect(w).toMatch(/Thursday 30 Jul/);
    expect(w).toMatch(/Wednesday 5 Aug/);
  });

  it('uses the shared prefix rather than its own wording', async () => {
    const copy = await import('../payoutCopy');
    renderList(history([AWAITING]));
    expect(screen.getByTestId('payout-batch-window:b-await').textContent)
      .toContain(copy.PAYOUT_WINDOW_PREFIX);
  });
});

// ─── Reconciliation: the parts add up, in public ──────────────────────────

describe('expanding a batch', () => {
  const THREE = entry({
    key: 'b-3', kind: 'paid', dates: datesFor(W_AUG_13, '2026-08-14'),
    plans: [
      line({ payoutId: 'a', netAmount: 940,    grossAmount: 1000, feeAmount: 60,   invoiceNumber: 'INV-A' }),
      line({ payoutId: 'b', netAmount: 470,    grossAmount: 500,  feeAmount: 30,   invoiceNumber: 'INV-B' }),
      line({ payoutId: 'c', netAmount: 2350.5, grossAmount: 2500, feeAmount: 149.5, invoiceNumber: 'INV-C' }),
    ],
  });

  it('is collapsed until asked for', () => {
    renderList(history([THREE]));
    expect(screen.queryByTestId('payout-plan-table:b-3')).toBeNull();
    expect(screen.getByTestId('payout-batch-toggle:b-3').getAttribute('aria-expanded')).toBe('false');
  });

  it('lists every component plan with patient, invoice, gross, fee and net', async () => {
    const user = userEvent.setup();
    renderList(history([THREE]));
    await user.click(screen.getByTestId('payout-batch-toggle:b-3'));

    const table = screen.getByTestId('payout-plan-table:b-3');
    expect(screen.getAllByTestId(/^payout-plan-row:/)).toHaveLength(3);
    for (const inv of ['INV-A', 'INV-B', 'INV-C']) {
      expect(table.textContent).toContain(inv);
    }
    expect(table.textContent).toContain('Thabo M.');
    expect(table.textContent).toContain(formatRand(2500));    // gross
    expect(table.textContent).toContain(formatRand(149.5));   // fee
    expect(table.textContent).toContain(formatRand(2350.5));  // net
  });

  it('THE PROMISE: the per-plan nets sum exactly to the batch total on screen', async () => {
    // 940 + 470 + 2350.50 = 3760.50, and that is the number printed above the
    // breakdown. A reconciliation screen whose parts do not add up is worse
    // than no screen.
    const user = userEvent.setup();
    renderList(history([THREE]));
    await user.click(screen.getByTestId('payout-batch-toggle:b-3'));

    expect(screen.getByTestId('payout-plan-total:b-3').textContent).toBe('R3,760.50');
    expect(screen.getByTestId('payout-batch-total:b-3').textContent).toBe('R3,760.50');
  });

  it('names the fee "BetterNow fee" and never MDR', () => {
    renderList(history([THREE]));
    // Rendered on expansion; the header row is what carries the name.
    expect(screen.getByTestId('payout-batch:b-3')).toBeTruthy();
    return userEvent.setup().click(screen.getByTestId('payout-batch-toggle:b-3')).then(() => {
      const table = screen.getByTestId('payout-plan-table:b-3').textContent ?? '';
      expect(table).toContain('BetterNow fee');
      expect(table).not.toMatch(/\bMDR\b/);
    });
  });

  it('shows the practice\'s own reference under the invoice when there is one', async () => {
    const user = userEvent.setup();
    renderList(history([entry({
      key: 'b-ref',
      plans: [line({ payoutId: 'r', invoiceNumber: 'INV-9', practiceReference: 'FILE-42' })],
    })]));
    await user.click(screen.getByTestId('payout-batch-toggle:b-ref'));
    expect(screen.getByTestId('payout-plan-row:r').textContent).toContain('FILE-42');
  });

  it('collapses again on a second click', async () => {
    const user = userEvent.setup();
    renderList(history([THREE]));
    await user.click(screen.getByTestId('payout-batch-toggle:b-3'));
    await user.click(screen.getByTestId('payout-batch-toggle:b-3'));
    expect(screen.queryByTestId('payout-plan-table:b-3')).toBeNull();
  });

  it('expands ONE row without expanding its neighbours', async () => {
    const user = userEvent.setup();
    renderList(history([AWAITING, PAID]));
    await user.click(screen.getByTestId('payout-batch-toggle:b-await'));
    expect(screen.getByTestId('payout-plan-table:b-await')).toBeTruthy();
    expect(screen.queryByTestId('payout-plan-table:b-paid')).toBeNull();
  });

  it('says so when the parts do NOT add up, rather than showing two totals silently', async () => {
    const user = userEvent.setup();
    renderList(history([entry({
      key: 'b-bad', totalNet: 5000, plansNetSum: 940, sumMatchesTotal: false,
      plans: [line({ payoutId: 'x', netAmount: 940 })],
    })]));
    await user.click(screen.getByTestId('payout-batch-toggle:b-bad'));
    const warn = screen.getByTestId('payout-sum-mismatch:b-bad').textContent ?? '';
    expect(warn).toMatch(/don’t add up/);
    expect(warn).toMatch(/contact support/i);
    // And it protects the figure that actually gets paid.
    expect(warn).toMatch(/the total is what gets paid/);
  });

  it('explains a missing breakdown instead of offering an empty table', () => {
    renderList(history([entry({
      key: 'b-hidden', planCount: 3, totalNet: 900, plans: [], plansHidden: true,
    })]));
    expect(screen.queryByTestId('payout-batch-toggle:b-hidden')).toBeNull();
    const note = screen.getByTestId('payout-batch-plans-hidden:b-hidden').textContent ?? '';
    expect(note).toMatch(/3 plans/);
    expect(note).toMatch(/breakdown isn’t available/);
    expect(note).toMatch(/total above is still what gets paid/);
    expect(note).toMatch(/contact support/i);
    // The count is still honest, and the total still shows.
    expect(screen.getByTestId('payout-batch-total:b-hidden').textContent).toBe('R900.00');
  });

  it('does not blame permissions — 0092 made that explanation false', () => {
    renderList(history([entry({
      key: 'b-hidden', planCount: 3, totalNet: 900, plans: [], plansHidden: true,
    })]));
    const note = screen.getByTestId('payout-batch-plans-hidden:b-hidden').textContent ?? '';
    expect(note).not.toMatch(/permission/i);
    expect(note).not.toMatch(/manager/i);
  });
});

// ─── Counts ───────────────────────────────────────────────────────────────

describe('plan counts', () => {
  it('are plural-safe', () => {
    renderList(history([
      entry({ key: 'b-one', plans: [line({ payoutId: 'a' })] }),
      entry({ key: 'b-two', plans: [line({ payoutId: 'b' }), line({ payoutId: 'c' })] }),
    ]));
    expect(screen.getByTestId('payout-batch-count:b-one').textContent).toBe('1 plan');
    expect(screen.getByTestId('payout-batch-count:b-two').textContent).toBe('2 plans');
  });

  it('report the BATCH\'s stored count, not the rows that came back', () => {
    // A count derived from the list would agree with itself and hide exactly
    // the inconsistency plansHidden exists to surface.
    renderList(history([entry({ key: 'b-x', planCount: 5, plans: [line({ payoutId: 'a' })] })]));
    expect(screen.getByTestId('payout-batch-count:b-x').textContent).toBe('5 plans');
  });
});

// ─── Empty and bounded ────────────────────────────────────────────────────

describe('nothing yet', () => {
  it('shows words, never a fabricated R0', () => {
    renderList(history([]));
    const empty = screen.getByTestId('payout-history-empty').textContent ?? '';
    expect(empty).toMatch(/No payouts yet/);
    expect(empty).not.toMatch(/R0/);
    expect(screen.queryByTestId('payout-batch-list')).toBeNull();
  });

  it('does not claim the practice is owed nothing', () => {
    renderList(history([]));
    const empty = screen.getByTestId('payout-history-empty').textContent ?? '';
    expect(empty).not.toMatch(/owed nothing|no money due/i);
  });
});

describe('the bounded history', () => {
  it('says when older weeks are not on the page', () => {
    renderList(history([AWAITING], { truncated: true, batchCount: 26 }));
    const note = screen.getByTestId('payout-history-truncated').textContent ?? '';
    expect(note).toMatch(/most recent 26 weeks/);
  });

  it('stays quiet when the whole history fits', () => {
    renderList(history([AWAITING]));
    expect(screen.queryByTestId('payout-history-truncated')).toBeNull();
  });
});

// ─── ADVERSARIAL: no date or money logic in the component ─────────────────

describe('ADVERSARIAL — the component owns no date or money logic', () => {
  const SRC = readFileSync(
    resolve(process.cwd(), 'app/practice/payouts/PayoutBatchList.tsx'), 'utf8',
  ).replace(/\r\n/g, '\n');
  /** Comments legitimately DISCUSS dates and amounts; code must not compute them. */
  const code = stripComments(SRC);

  it('constructs no Date and reads no clock', () => {
    expect(code).not.toMatch(/new Date\b/);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/Date\.UTC/);
  });

  it('does no timezone or calendar arithmetic', () => {
    for (const forbidden of [
      /toISOString/, /toLocaleDateString/, /getUTCDay/, /getDay\b/,
      /getMonth/, /getFullYear/, /setHours/, /Intl\.DateTimeFormat/,
      /86_?400_?000/, /24 \* 60 \* 60/,
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('hardcodes no weekday or month name — every date is DERIVED', () => {
    for (const day of ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']) {
      expect(code, `must not hardcode "${day}"`).not.toMatch(new RegExp(`['"\`][^'"\`]*${day}`));
    }
    for (const month of ['Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Oct','Nov','Dec']) {
      expect(code, `must not hardcode "${month}"`).not.toMatch(new RegExp(`['"\`]${month}`));
    }
  });

  it('formats every date through the shared formatters', () => {
    expect(SRC).toMatch(/from '@\/app\/patient\/_format'/);
    expect(SRC).toMatch(/formatWeekdayDayMonth/);
  });

  it('formats money with the existing app helper, not a second implementation', () => {
    expect(SRC).toMatch(/import \{ formatRand \} from '\.\.\/billHelpers'/);
    expect(code).not.toMatch(/toFixed/);
    expect(code).not.toMatch(/toLocaleString/);
    expect(code).not.toMatch(/R\$\{/);
  });

  it('computes no fee and sums nothing — both arrive resolved', () => {
    expect(code).not.toMatch(/calculateFee/);
    expect(code).not.toMatch(/@\/lib\/finance/);
    expect(code).not.toMatch(/feePercent/);
    // The breakdown total is the loader's plansNetSum, not a .reduce() here —
    // otherwise the "parts add up" check would be the component agreeing with
    // itself.
    expect(code).not.toMatch(/\.reduce\(/);
    expect(code).toMatch(/plansNetSum/);
  });

  it('takes its words from the shared copy module, not its own literals', () => {
    expect(SRC).toMatch(/from '\.\.\/payoutCopy'/);
    expect(code).toMatch(/PAYOUT_STATUS_CHIP\[/);
    expect(code).toMatch(/PAYOUT_DATE_CAPTION\[/);
    expect(code).toMatch(/payoutSettlementNote\(/);
    expect(code).toMatch(/payoutEstimateNote\(/);
    // No local copy of the status words.
    expect(code).not.toMatch(/'Awaiting transfer'/);
    expect(code).not.toMatch(/'Paid'/);
  });
});
