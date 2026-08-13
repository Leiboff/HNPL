import Link from 'next/link';
import { formatRand } from '@/app/practice/billHelpers';
import { formatWeekdayDayMonth } from '@/app/patient/_format';
import { PAYOUT_ESTIMATE_BADGE, payoutPlanCountLabel } from '@/app/practice/payoutCopy';
import {
  PAYOUT_STATUS_CHIP,
  PAYOUT_DATE_CAPTION,
  BRAND_PAYOUT_LABEL,
  BRAND_PAYOUT_EMPTY_TITLE,
  BRAND_PAYOUT_EMPTY_NOTE,
  BRAND_PAYOUT_MIXED_NOTE,
  BRAND_PAYOUT_MULTI_DATE_NOTE,
  BRAND_PRACTICE_NO_PAYOUT,
  brandDepositSummary,
  brandSeparateDepositsNote,
  brandOtherPendingNote,
} from './brandPayoutCopy';
import type { BrandPayoutRollup, BrandPracticePayout } from '@/lib/brand/brandPayouts';

// ─── Overview's money block: the group total, then the deposits it is made of ─
//
// The whole point of putting these two things in ONE component is that they
// cannot be separated. A group total is a sum of N deposits; showing the total
// without the deposits it decomposes into produces a figure that appears on no
// bank statement anywhere. So the hero and the per-practice rows are one
// section, and the deposit count sits in the same breath as the number.
//
// NO DATE MATH AND NO MONEY FORMATTING HERE. Every amount goes through
// ../practice/billHelpers formatRand and every date arrives as a pre-resolved
// SAST calendar string (lib/brand/brandPayouts → lib/payments/payoutSchedule)
// rendered by @/app/patient/_format. There is no Date construction, no
// toFixed, no toISOString and no weekday literal in this file — see
// ../practice/NextPayoutHero's header for why a component that formats a
// SAST midnight itself silently names the wrong DAY.
//
// EVERY WORD COMES FROM ./brandPayoutCopy, which in turn re-exports
// ../practice/payoutCopy's three certainties. A brand admin who reads
// "Awaiting transfer" here and something else on the practice's own payouts tab
// would have to work out whether they mean the same state; when the answer is
// money, they will assume they do not.
//
// THE ROWS LINK VIA /brand/branch/[practiceId] — the existing pivot, which
// redirects into that practice's ordinary dashboard with ?practiceId= set. Not
// /practice?practiceId= written out here: the pivot is the brand surface's one
// documented doorway, it is what the six revalidatePath calls in ./actions.ts
// target, and re-deriving its URL here would be a second entry point to
// maintain.
//
// WHAT THIS BLOCK IS NOT: it does not follow the revenue filters below it.
// Those narrow an analysis by practice, doctor and date range; this is money in
// flight, and a filtered payout figure would be a number nobody is owed.

const NAVY = '#13294B';

type Props = {
  rollup: BrandPayoutRollup;
  /**
   * Active plans per practice id, unfiltered — from the same computeRevenue
   * rollup the revenue section uses, so the count here and the count there
   * cannot disagree about what "active" means.
   */
  activePlanCounts: Record<string, number>;
};

export default function BrandPayoutBlock({ rollup, activePlanCounts }: Props) {
  return (
    <section
      aria-labelledby="brand-payout-heading"
      data-testid="brand-payout-block"
      className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden"
    >
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-6 p-5 sm:p-6">
        <div className="min-w-0">
          {rollup.depositCount === 0
            ? <EmptyState />
            : <GroupFigure rollup={rollup} />}
        </div>
        <PaidRecently net={rollup.paidRecentlyNet} count={rollup.paidRecentlyCount} />
      </div>

      <PracticeRows rows={rollup.perPractice} activePlanCounts={activePlanCounts} />
      <Footnotes rollup={rollup} />
    </section>
  );
}

// ── The group figure ────────────────────────────────────────────────────────

function GroupFigure({ rollup }: { rollup: BrandPayoutRollup }) {
  // A total holding any still-open week is not final, so the group chip takes
  // the LESS certain of the two states. Rounding the other way would stamp
  // "final" on a figure that can still move.
  const groupKind = rollup.openCount > 0 ? 'open' : 'awaiting';
  const mixed     = rollup.openCount > 0 && rollup.awaitingCount > 0;
  const oneDate   = rollup.payoutDates.length === 1;
  const totalLabel = formatRand(rollup.totalNet);

  return (
    <div>
      <div className="flex items-center gap-2">
        <p
          id="brand-payout-heading"
          className="text-xs font-semibold uppercase tracking-wide text-gray-500"
        >
          {BRAND_PAYOUT_LABEL}
        </p>
        {groupKind === 'open' && (
          <span
            data-testid="brand-payout-estimate-badge"
            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
          >
            {PAYOUT_ESTIMATE_BADGE}
          </span>
        )}
      </div>

      <p
        data-testid="brand-payout-total"
        className="mt-1 text-3xl sm:text-4xl font-semibold tabular-nums"
        style={{ color: NAVY }}
      >
        {totalLabel}
      </p>

      {/* The deposit count, in the same breath as the total. Never a footnote. */}
      <p className="mt-1 text-sm font-medium text-gray-700" data-testid="brand-deposit-summary">
        {brandDepositSummary(rollup.depositCount)}
      </p>

      {/* The date — only when there IS one date. With several, naming the
          earliest would read as the day the whole total arrives. */}
      {oneDate ? (
        <p className="mt-1 text-sm text-gray-700" data-testid="brand-payout-when">
          {PAYOUT_DATE_CAPTION[groupKind]}{' '}
          <span className="font-semibold">{formatWeekdayDayMonth(rollup.payoutDates[0])}</span>
        </p>
      ) : (
        <p className="mt-1 text-xs text-amber-800" data-testid="brand-payout-multi-date">
          {BRAND_PAYOUT_MULTI_DATE_NOTE}
        </p>
      )}

      <p className="mt-2 text-xs text-gray-600" data-testid="brand-separate-deposits">
        {brandSeparateDepositsNote(rollup.depositCount, totalLabel)}
      </p>

      {mixed && (
        <p className="mt-1 text-xs text-amber-800" data-testid="brand-payout-mixed">
          {BRAND_PAYOUT_MIXED_NOTE}
        </p>
      )}

      <p className="mt-2 text-xs text-gray-500" data-testid="brand-payout-plan-count">
        From {payoutPlanCountLabel(rollup.planCount)}
      </p>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────
//
// Deliberately not "R0.00" — zero reads as a measured figure, the same reason
// ../practice/NextPayoutHero refuses it.

function EmptyState() {
  return (
    <div data-testid="brand-payout-empty">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        {BRAND_PAYOUT_LABEL}
      </p>
      <p className="mt-1 text-lg font-semibold text-gray-400">{BRAND_PAYOUT_EMPTY_TITLE}</p>
      <p className="mt-1 text-xs text-gray-500">{BRAND_PAYOUT_EMPTY_NOTE}</p>
    </div>
  );
}

// ── Secondary figure — same shape and wording as the practice hero's ────────

function PaidRecently({ net, count }: { net: number; count: number }) {
  return (
    <div
      data-testid="brand-paid-recently"
      className="sm:min-w-45 sm:border-l sm:border-gray-100 sm:pl-6"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Paid out</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-green-700">{formatRand(net)}</p>
      <p className="mt-0.5 text-xs text-gray-500">
        Last 30 days
        {count > 0 && ` · ${count} payout${count === 1 ? '' : 's'}`}
      </p>
    </div>
  );
}

// ── The deposits themselves ─────────────────────────────────────────────────

function PracticeRows({
  rows,
  activePlanCounts,
}: {
  rows: BrandPracticePayout[];
  activePlanCounts: Record<string, number>;
}) {
  return (
    <ul className="border-t border-gray-100 divide-y divide-gray-100" data-testid="brand-practice-rows">
      {rows.map((row) => (
        <PracticeRow
          key={row.practiceId}
          row={row}
          activePlanCount={activePlanCounts[row.practiceId] ?? 0}
        />
      ))}
    </ul>
  );
}

function PracticeRow({
  row,
  activePlanCount,
}: {
  row: BrandPracticePayout;
  activePlanCount: number;
}) {
  // Narrowed to the two states that HAVE a chip and a caption, so the shared
  // lookups can never be indexed with 'none' — there is no honest chip for
  // "nothing scheduled", which is the whole reason that row renders differently.
  const kind = row.state === 'none' ? null : row.state;
  const chip = kind ? PAYOUT_STATUS_CHIP[kind] : null;

  return (
    <li
      data-testid={`brand-practice-row-${row.practiceId}`}
      data-state={row.state}
      className="px-5 sm:px-6 py-3 flex items-start justify-between gap-3"
    >
      <div className="min-w-0">
        {/* The doorway. One level down is where analysis and reconciliation
            happen — this list is for spotting which practice to open. */}
        <Link
          href={`/brand/branch/${row.practiceId}`}
          data-testid={`brand-practice-link-${row.practiceId}`}
          className="text-sm font-semibold underline underline-offset-2 hover:opacity-70 transition-opacity"
          style={{ color: NAVY }}
        >
          {row.practiceName}
        </Link>
        <p className="mt-0.5 text-[11px] text-gray-500" data-testid={`brand-practice-plans-${row.practiceId}`}>
          {activePlanCount} active {activePlanCount === 1 ? 'plan' : 'plans'}
        </p>
      </div>

      <div className="text-right shrink-0">
        {kind ? (
          <>
            <p
              className="text-sm font-semibold tabular-nums"
              style={{ color: NAVY }}
              data-testid={`brand-practice-amount-${row.practiceId}`}
            >
              {formatRand(row.totalNet)}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500">
              {/* The date always carries its caption. A bare date beside an
                  amount is read as the day it was paid. */}
              {row.dates.payoutDate && (
                <>
                  {PAYOUT_DATE_CAPTION[kind]} {formatWeekdayDayMonth(row.dates.payoutDate)}
                  {' · '}
                </>
              )}
              {payoutPlanCountLabel(row.planCount)}
            </p>
            {chip && (
              <span
                data-testid={`brand-practice-chip-${row.practiceId}`}
                className={`inline-block mt-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${chip.cls}`}
              >
                {chip.label}
              </span>
            )}
          </>
        ) : (
          <p className="text-[11px] text-gray-400" data-testid={`brand-practice-none-${row.practiceId}`}>
            {BRAND_PRACTICE_NO_PAYOUT}
          </p>
        )}
      </div>
    </li>
  );
}

// ── The two things that should never happen, said out loud ──────────────────

function Footnotes({ rollup }: { rollup: BrandPayoutRollup }) {
  const { otherPendingCount, otherPendingNet, strandedCount } = rollup;
  if (otherPendingCount === 0 && strandedCount === 0) return null;

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-5 sm:px-6 py-3 space-y-1">
      {otherPendingCount > 0 && (
        <p className="text-xs text-gray-600" data-testid="brand-payout-other-pending">
          {brandOtherPendingNote(otherPendingCount, formatRand(otherPendingNet))}
        </p>
      )}
      {strandedCount > 0 && (
        <p className="text-xs text-gray-600" data-testid="brand-payout-stranded">
          {strandedCount} plan{strandedCount === 1 ? '' : 's'} activated in an earlier week
          {strandedCount === 1 ? ' is' : ' are'} not in a payout yet. We&apos;re on it — no
          action needed from you.
        </p>
      )}
    </div>
  );
}
