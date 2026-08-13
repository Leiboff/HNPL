import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NextPayoutHero from './NextPayoutHero';
import { formatRand } from './billHelpers';
import { payoutWindowEndingOn } from '@/lib/payments/payoutWindow';
import { payoutDateFor, windowDates, openPayoutWindow } from '@/lib/payments/payoutSchedule';
import { stripComments } from '@/lib/testing/stripComments';
import type { NextPayoutResult, PayoutPlanLine } from '@/lib/practice/nextPayout';

// ─── The hero a practice owner reads first ──────────────────────────────
//
// Two failure modes matter more than layout: showing a number that isn't real,
// and showing a projection with the confidence of a commitment. Most of what
// follows is about those.

const THU_13 = '2026-08-13';
const CLOSED = payoutWindowEndingOn(THU_13);            // Thu 6 – Wed 12, paid Fri 14
const OPEN   = openPayoutWindow(new Date('2026-08-14T07:00:00.000Z'));  // Thu 13 – Wed 19

const datesFor = (w: typeof CLOSED) => ({
  payoutDate:  payoutDateFor(w),
  windowFirst: windowDates(w).firstDate,
  windowLast:  windowDates(w).lastDate,
});

function plan(n: number, net: number, name = 'Thabo M.'): PayoutPlanLine {
  return {
    payoutId: `p${n}`, planId: `pl${n}`, netAmount: net,
    patientLabel: name, invoiceNumber: `INV-${n}`,
    activatedAt: '2026-08-10T08:00:00.000Z',
  };
}

const base = {
  paidRecentlyNet: 0, paidRecentlyCount: 0,
  otherPendingCount: 0, otherPendingNet: 0, strandedCount: 0,
};

const committed = (over: Partial<NextPayoutResult> = {}): NextPayoutResult => ({
  ...base,
  next: {
    kind: 'committed', batchId: 'b1', window: CLOSED,
    totalNet: 15240.50, planCount: 2,
    plans: [plan(1, 5000), plan(2, 10240.50, 'Sarah N.')],
    plansHidden: false,
  },
  ...over,
});

const projected = (over: Partial<NextPayoutResult> = {}): NextPayoutResult => ({
  ...base,
  next: {
    kind: 'projected', window: OPEN,
    totalNet: 650, planCount: 2,
    plans: [plan(1, 400), plan(2, 250, 'Sarah N.')],
    plansHidden: false,
  },
  ...over,
});

const none = (over: Partial<NextPayoutResult> = {}): NextPayoutResult =>
  ({ ...base, next: { kind: 'none' }, ...over });

// ── (a) committed ───────────────────────────────────────────────────────

describe('a closed batch — a commitment', () => {
  it('shows the real total, the plan count, the window and the payout DAY', () => {
    render(<NextPayoutHero data={committed()} dates={datesFor(CLOSED)} />);

    expect(screen.getByTestId('payout-amount').textContent).toBe('R15,240.50');
    expect(screen.getByTestId('payout-plans-toggle').textContent).toMatch(/From 2 plans/);

    // The day of week is NAMED, and it comes from the shared date logic.
    expect(screen.getByTestId('payout-when').textContent).toMatch(/Lands\s*Friday 14 Aug/);

    // Window in plain language, with the INCLUSIVE last day.
    const window = screen.getByTestId('payout-window').textContent ?? '';
    expect(window).toMatch(/Covers plans activated/);
    expect(window).toMatch(/Thursday 6 Aug/);
    expect(window).toMatch(/Wednesday 12 Aug/);
    // Never the exclusive Thursday boundary.
    expect(window).not.toMatch(/13 Aug/);
  });

  it('is NOT marked as an estimate', () => {
    render(<NextPayoutHero data={committed()} dates={datesFor(CLOSED)} />);
    expect(screen.queryByTestId('payout-estimate-badge')).toBeNull();
    expect(screen.queryByTestId('payout-estimate-note')).toBeNull();
  });
});

// ── (b) projected ───────────────────────────────────────────────────────

describe('an open week — a projection, and it must say so', () => {
  it('carries an Estimate badge and honest copy about not being final', () => {
    render(<NextPayoutHero data={projected()} dates={datesFor(OPEN)} />);

    expect(screen.getByTestId('payout-amount').textContent).toBe('R650.00');
    expect(screen.getByTestId('payout-estimate-badge').textContent).toMatch(/Estimate/);

    const note = screen.getByTestId('payout-estimate-note').textContent ?? '';
    expect(note).toMatch(/isn't final|isn’t final/);
    expect(note).toMatch(/still open/);
  });

  it('says "Expected", not "Lands" — the verb carries the uncertainty too', () => {
    render(<NextPayoutHero data={projected()} dates={datesFor(OPEN)} />);
    const when = screen.getByTestId('payout-when').textContent ?? '';
    expect(when).toMatch(/Expected\s*Friday 21 Aug/);
    expect(when).not.toMatch(/Lands/);
  });

  it('uses the CURRENT in-progress window, not last week\'s', () => {
    render(<NextPayoutHero data={projected()} dates={datesFor(OPEN)} />);
    const window = screen.getByTestId('payout-window').textContent ?? '';
    expect(window).toMatch(/Thursday 13 Aug/);
    expect(window).toMatch(/Wednesday 19 Aug/);
  });

  it('the label itself differs from the committed case, before the number is read', () => {
    const { unmount } = render(<NextPayoutHero data={projected()} dates={datesFor(OPEN)} />);
    expect(screen.getByText('Building this week')).toBeTruthy();
    unmount();
    render(<NextPayoutHero data={committed()} dates={datesFor(CLOSED)} />);
    expect(screen.getByText('Next payout')).toBeTruthy();
  });
});

// ── (c) empty ───────────────────────────────────────────────────────────

describe('nothing owed — a clean empty state', () => {
  it('shows no fabricated figure', () => {
    render(<NextPayoutHero data={none()} dates={{ payoutDate: null, windowFirst: null, windowLast: null }} />);

    expect(screen.getByTestId('payout-empty')).toBeTruthy();
    expect(screen.queryByTestId('payout-amount')).toBeNull();
    expect(screen.queryByTestId('payout-when')).toBeNull();
    expect(screen.queryByTestId('payout-window')).toBeNull();
    expect(screen.queryByTestId('payout-plans-toggle')).toBeNull();
  });

  it('does not assert that the practice is owed nothing — only that nothing is scheduled', () => {
    // "No batch and no unbatched payouts" is not the same statement as "you
    // are owed nothing", so the copy must not make a claim about the world.
    // (Before 0092 an ordinary member also landed here because the payouts read
    // was refused; that cause is gone, the reasoning is not.)
    render(<NextPayoutHero data={none()} dates={{ payoutDate: null, windowFirst: null, windowLast: null }} />);
    const text = screen.getByTestId('payout-empty').textContent ?? '';
    expect(text).toMatch(/Nothing scheduled yet/);
    expect(text).not.toMatch(/R0/);
    expect(text).not.toMatch(/owed nothing|no payouts due/i);
  });

  it('the "Paid out" figure still renders — past payouts are unrelated to what is next', () => {
    render(
      <NextPayoutHero
        data={none({ paidRecentlyNet: 8000, paidRecentlyCount: 2 })}
        dates={{ payoutDate: null, windowFirst: null, windowLast: null }}
      />,
    );
    const paid = screen.getByTestId('payout-paid-recently').textContent ?? '';
    expect(paid).toMatch(/R8,000\.00/);
    expect(paid).toMatch(/Last 30 days/);
    expect(paid).toMatch(/2 payouts/);
  });
});

// ── "From N plans" is a real control ────────────────────────────────────

describe('the plan list', () => {
  it('is collapsed until asked for, then lists exactly the plans behind the figure', async () => {
    const user = userEvent.setup();
    render(<NextPayoutHero data={committed()} dates={datesFor(CLOSED)} />);

    expect(screen.queryByTestId('payout-plan-list')).toBeNull();
    const toggle = screen.getByTestId('payout-plans-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await user.click(toggle);

    const list = screen.getByTestId('payout-plan-list');
    expect(list.textContent).toMatch(/Thabo M\./);
    expect(list.textContent).toMatch(/Sarah N\./);
    expect(list.textContent).toMatch(/INV-1/);
    expect(screen.getByTestId('payout-plans-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('the listed nets add up to the headline figure', async () => {
    const user = userEvent.setup();
    render(<NextPayoutHero data={committed()} dates={datesFor(CLOSED)} />);
    await user.click(screen.getByTestId('payout-plans-toggle'));

    // 5000 + 10240.50 = the headline. A list that doesn't reconcile to the
    // number above it is worse than no list.
    expect(screen.getByTestId('payout-plan-list-total').textContent).toBe('R15,240.50');
    expect(screen.getByTestId('payout-amount').textContent).toBe('R15,240.50');
  });

  it('works for the projection too, with that case\'s plans', async () => {
    const user = userEvent.setup();
    render(<NextPayoutHero data={projected()} dates={datesFor(OPEN)} />);
    await user.click(screen.getByTestId('payout-plans-toggle'));
    expect(screen.getByTestId('payout-plan-list-total').textContent).toBe('R650.00');
  });

  it('collapses again on a second click', async () => {
    const user = userEvent.setup();
    render(<NextPayoutHero data={committed()} dates={datesFor(CLOSED)} />);
    await user.click(screen.getByTestId('payout-plans-toggle'));
    await user.click(screen.getByTestId('payout-plans-toggle'));
    expect(screen.queryByTestId('payout-plan-list')).toBeNull();
  });

  it('carries a surname INITIAL only, never a full surname', async () => {
    const user = userEvent.setup();
    render(
      <NextPayoutHero
        data={committed({
          next: {
            kind: 'committed', batchId: 'b1', window: CLOSED, totalNet: 100, planCount: 1,
            plans: [plan(1, 100, 'Thabo M.')], plansHidden: false,
          },
        })}
        dates={datesFor(CLOSED)}
      />,
    );
    await user.click(screen.getByTestId('payout-plans-toggle'));
    expect(screen.getByTestId('payout-plan-list').textContent).toMatch(/Thabo M\./);
  });

  it('when the breakdown is missing, it EXPLAINS rather than offering an empty list', () => {
    render(
      <NextPayoutHero
        data={committed({
          next: {
            kind: 'committed', batchId: 'b1', window: CLOSED, totalNet: 900, planCount: 3,
            plans: [], plansHidden: true,
          },
        })}
        dates={datesFor(CLOSED)}
      />,
    );
    expect(screen.queryByTestId('payout-plans-toggle')).toBeNull();
    const note = screen.getByTestId('payout-plans-hidden').textContent ?? '';
    expect(note).toMatch(/From 3 plans/);
    expect(note).toMatch(/breakdown isn't available|breakdown isn’t available/);
    // Protects the one thing the reader cares about…
    expect(note).toMatch(/total above is still what gets paid/);
    // …and routes it to someone who can act, since they cannot.
    expect(note).toMatch(/contact support/i);
    // The total is still shown — the batch figure is what will be paid.
    expect(screen.getByTestId('payout-amount').textContent).toBe('R900.00');
  });

  it('the copy does NOT blame permissions — 0092 made that explanation false', () => {
    // Before 0092 payouts was manager-only while payout_batches was not, so
    // this state really did mean "you are not a manager". Both are now
    // is_practice_member, so the only remaining cause is an inconsistent batch.
    // Misattributing a data problem to a permission one sends the reader to
    // their practice admin, who can do nothing about it.
    render(
      <NextPayoutHero
        data={committed({
          next: {
            kind: 'committed', batchId: 'b1', window: CLOSED, totalNet: 900, planCount: 3,
            plans: [], plansHidden: true,
          },
        })}
        dates={datesFor(CLOSED)}
      />,
    );
    const note = screen.getByTestId('payout-plans-hidden').textContent ?? '';
    expect(note).not.toMatch(/admin/i);
    expect(note).not.toMatch(/permission/i);
    expect(note).not.toMatch(/manager/i);
    expect(note).not.toMatch(/only .* can see/i);
  });

  it('the OLD copy is gone from the entire codebase, not just this component', () => {
    // A string that outlived its own truth is worth hunting repo-wide: it could
    // equally have been copied into a test fixture, a doc, or another surface.
    const offenders: string[] = [];
    const skip = new Set(['node_modules', '.next', '.git', 'dist', 'coverage']);
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|md|sql|json)$/.test(entry.name)) continue;
        // This test names the old string in order to forbid it.
        if (entry.name === 'NextPayoutHero.test.tsx') continue;
        if (readFileSync(full, 'utf8').includes('Only practice admins')) {
          offenders.push(full.replace(process.cwd(), '').replace(/\\/g, '/'));
        }
      }
    };
    walk(resolve(process.cwd(), 'app'));
    walk(resolve(process.cwd(), 'lib'));
    walk(resolve(process.cwd(), 'supabase'));

    expect(offenders, `stale copy still present in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('singular/plural is right for one plan', () => {
    render(
      <NextPayoutHero
        data={committed({
          next: {
            kind: 'committed', batchId: 'b1', window: CLOSED, totalNet: 100, planCount: 1,
            plans: [plan(1, 100)], plansHidden: false,
          },
        })}
        dates={datesFor(CLOSED)}
      />,
    );
    expect(screen.getByTestId('payout-plans-toggle').textContent).toMatch(/From 1 plan —/);
    expect(screen.getByTestId('payout-plans-toggle').textContent).not.toMatch(/1 plans/);
  });
});

// ── The two things that should never happen ─────────────────────────────

describe('footnotes', () => {
  it('are absent when there is nothing to report', () => {
    render(<NextPayoutHero data={committed()} dates={datesFor(CLOSED)} />);
    expect(screen.queryByTestId('payout-other-pending')).toBeNull();
    expect(screen.queryByTestId('payout-stranded')).toBeNull();
  });

  it('name an unsettled earlier batch as a SEPARATE deposit', () => {
    render(
      <NextPayoutHero
        data={committed({ otherPendingCount: 1, otherPendingNet: 500 })}
        dates={datesFor(CLOSED)}
      />,
    );
    const note = screen.getByTestId('payout-other-pending').textContent ?? '';
    expect(note).toMatch(/R500\.00/);
    expect(note).toMatch(/own deposit/);
    // And the headline was NOT inflated by it.
    expect(screen.getByTestId('payout-amount').textContent).toBe('R15,240.50');
  });

  it('mention stranded plans without attaching a date to them', () => {
    render(
      <NextPayoutHero data={committed({ strandedCount: 2 })} dates={datesFor(CLOSED)} />,
    );
    const note = screen.getByTestId('payout-stranded').textContent ?? '';
    expect(note).toMatch(/2 plans/);
    expect(note).toMatch(/not in a payout yet/);
    expect(note).not.toMatch(/Friday|Aug/);
  });
});

// ── ADVERSARIAL: no new date or money logic in this component ───────────

describe('ADVERSARIAL — the component owns no date or money logic', () => {
  const SRC = readFileSync(resolve(process.cwd(), 'app/practice/NextPayoutHero.tsx'), 'utf8')
    .replace(/\r\n/g, '\n');
  /** Comments legitimately DISCUSS dates; code must not compute them. */
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

  it('hardcodes no weekday or month name — the payout day is DERIVED', () => {
    // The whole point: if the Thursday boundary moves, this file is not edited.
    for (const day of ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']) {
      expect(code, `must not hardcode "${day}"`).not.toMatch(new RegExp(`['"\`][^'"\`]*${day}`));
    }
    for (const month of ['Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Oct','Nov','Dec']) {
      expect(code, `must not hardcode "${month}"`).not.toMatch(new RegExp(`['"\`]${month}`));
    }
  });

  it('every date string it renders comes from the shared formatters', () => {
    expect(SRC).toMatch(/from '@\/app\/patient\/_format'/);
    expect(SRC).toMatch(/formatWeekdayDayMonth/);
    // …and the values themselves arrive pre-resolved as props.
    expect(SRC).toMatch(/payoutDate/);
    expect(SRC).toMatch(/windowFirst/);
  });

  it('formats money with the existing app helper, not a second implementation', () => {
    expect(SRC).toMatch(/import \{ formatRand \} from '\.\/billHelpers'/);
    // No local currency formatting of any kind.
    expect(code).not.toMatch(/toFixed/);
    expect(code).not.toMatch(/R\$\{/);
    expect(code).not.toMatch(/toLocaleString/);
    // And it really is the shared one.
    expect(formatRand(15240.5)).toBe('R15,240.50');
  });

  it('the SERVER resolves the dates — the page passes strings, not instants', () => {
    const PAGE = readFileSync(resolve(process.cwd(), 'app/practice/page.tsx'), 'utf8');
    expect(PAGE).toMatch(/payoutDateFor/);
    expect(PAGE).toMatch(/windowDates/);
    expect(PAGE).toMatch(/from '@\/lib\/payments\/payoutSchedule'/);
  });
});
