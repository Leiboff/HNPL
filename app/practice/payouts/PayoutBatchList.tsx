'use client';

import { useState } from 'react';
import { formatRand } from '../billHelpers';
import { formatWeekdayDayMonth, formatDayMonth } from '@/app/patient/_format';
import {
  PAYOUT_BUILDING_LABEL,
  PAYOUT_DATE_CAPTION,
  PAYOUT_STATUS_CHIP,
  PAYOUT_WEEK_CLOSES_FALLBACK,
  PAYOUT_WINDOW_PREFIX,
  payoutEstimateNote,
  payoutPlanCountLabel,
  payoutSettlementNote,
} from '../payoutCopy';
import type { PayoutHistory, PayoutHistoryEntry } from '@/lib/practice/payoutHistory';

// ─── The batch list — one row per weekly deposit ───────────────────────────
//
// This screen exists so a practice can hold a bank statement next to it and
// tick off a deposit. Everything else is subordinate to that: the amount is
// the batch's stored total, the breakdown's nets add up to that total in
// public, and every date says which of three things it is.
//
// NO DATE OR MONEY LOGIC LIVES HERE, at all. Amounts arrive as numbers and go
// through ../billHelpers formatRand; dates arrive as pre-resolved YYYY-MM-DD
// SAST strings from lib/practice/payoutHistory and go through
// @/app/patient/_format. There is no Date construction, no toISOString, no
// weekday or month literal, and no fee arithmetic — the fee is a stored
// column. The same discipline NextPayoutHero holds, for the same reason: a
// component that formats a SAST-midnight instant reports the wrong DAY, and a
// practice cannot tell that apart from a money bug. Pinned by this
// component's own adversarial test.
//
// THE STATUS DISTINCTION IS THE POINT
// ───────────────────────────────────
// A closed batch and a paid batch look completely different, and the words
// come from ../payoutCopy so this surface and the dashboard hero cannot
// develop two vocabularies for the same state. Three independent channels
// separate them, because colour alone excludes some readers and a chip alone
// is easy to skim past:
//
//   1. the chip WORD — "Awaiting transfer" vs "Paid"
//   2. the date CAPTION — "Due" vs "Transferred" (never a bare date)
//   3. a full settlement SENTENCE under every row, which is the one that
//      cannot be misread: "This amount is final. It's due to be transferred
//      on Friday 21 Aug."
//
// Nothing on an awaiting row says paid, transferred, received, deposited or
// landed. That is asserted directly against the rendered strings.

type Props = {
  history: PayoutHistory;
};

const NAVY = 'var(--portal-ink)';

export default function PayoutBatchList({ history }: Props) {
  if (history.entries.length === 0) return <EmptyState />;

  return (
    <div className="space-y-3" data-testid="payout-batch-list">
      {history.entries.map((entry) => (
        <BatchRow key={entry.key} entry={entry} />
      ))}

      {/* Said out loud rather than left as a list that just stops. */}
      {history.truncated && (
        <p className="px-1 text-xs text-gray-400" data-testid="payout-history-truncated">
          Showing your most recent {history.batchCount} weeks. Older payouts aren’t on this page
          yet — contact support if you need them.
        </p>
      )}
    </div>
  );
}

// ── One weekly batch ────────────────────────────────────────────────────

function BatchRow({ entry }: { entry: PayoutHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const chip    = PAYOUT_STATUS_CHIP[entry.kind];
  const caption = PAYOUT_DATE_CAPTION[entry.kind];

  // 'paid' shows the day the transfer went out; the other two show the day it
  // is due. Both are pre-resolved SAST dates — this picks between them, it
  // does not compute either.
  const shownDate = entry.kind === 'paid' ? entry.dates.paidDate : entry.dates.payoutDate;

  const settlement = payoutSettlementNote(
    entry.kind,
    shownDate ? formatWeekdayDayMonth(shownDate) : null,
    entry.overdue,
  );

  return (
    <section
      data-testid={`payout-batch:${entry.key}`}
      data-kind={entry.kind}
      className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden"
    >
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          {/* WHEN — captioned, never bare. */}
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {entry.kind === 'open' ? PAYOUT_BUILDING_LABEL : caption}
            </p>
            <p
              className="mt-0.5 text-sm font-semibold text-gray-900"
              data-testid={`payout-batch-date:${entry.key}`}
            >
              {entry.kind === 'open' && `${caption} `}
              {shownDate ? formatWeekdayDayMonth(shownDate) : '—'}
            </p>
          </div>

          {/* HOW MUCH, and how certain. */}
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p
                className="text-2xl font-semibold tabular-nums"
                style={{ color: NAVY }}
                data-testid={`payout-batch-total:${entry.key}`}
              >
                {formatRand(entry.totalNet)}
              </p>
              <p className="text-xs text-gray-500" data-testid={`payout-batch-count:${entry.key}`}>
                {payoutPlanCountLabel(entry.planCount)}
              </p>
            </div>
            <span
              data-testid={`payout-batch-status:${entry.key}`}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${chip.cls}`}
            >
              {chip.label}
            </span>
          </div>
        </div>

        {/* WHAT IT COVERS — the shared window sentence, from the batch's own
            stored boundaries. Never inferred by the reader. */}
        <p className="mt-3 text-xs text-gray-500" data-testid={`payout-batch-window:${entry.key}`}>
          {PAYOUT_WINDOW_PREFIX} {formatWeekdayDayMonth(entry.dates.windowFirst)}
          {' – '}
          {formatWeekdayDayMonth(entry.dates.windowLast)}
        </p>

        {/* WHERE THE MONEY ACTUALLY IS. The sentence that cannot be misread. */}
        {entry.kind === 'open' ? (
          <p className="mt-1 text-xs text-amber-800" data-testid={`payout-batch-note:${entry.key}`}>
            {payoutEstimateNote(
              entry.dates.windowLast
                ? formatDayMonth(entry.dates.windowLast)
                : PAYOUT_WEEK_CLOSES_FALLBACK,
            )}
          </p>
        ) : (
          <p
            className={`mt-1 text-xs ${entry.kind === 'paid' ? 'text-gray-600' : 'text-amber-800'}`}
            data-testid={`payout-batch-note:${entry.key}`}
          >
            {settlement}
          </p>
        )}

        {/* THE BREAKDOWN. plansHidden means the batch claims N plans and none
            came back — post-0092 that is a real inconsistency and not a
            permission gap, so the copy protects the total and routes it to
            someone who can fix it, exactly as the hero's does. */}
        <div className="mt-3">
          {entry.plansHidden ? (
            <p className="text-xs text-gray-500" data-testid={`payout-batch-plans-hidden:${entry.key}`}>
              {payoutPlanCountLabel(entry.planCount)} went into this payout, but the breakdown
              isn’t available. The total above is still what gets paid — contact support and
              we’ll reconcile it.
            </p>
          ) : entry.plans.length === 0 ? null : (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={`payout-plans-${entry.key}`}
              data-testid={`payout-batch-toggle:${entry.key}`}
              className="text-xs font-semibold underline underline-offset-2 hover:opacity-70 transition-opacity"
              style={{ color: NAVY }}
            >
              {open ? 'Hide the plans' : `Show the ${payoutPlanCountLabel(entry.plans.length)}`}
            </button>
          )}
        </div>
      </div>

      {open && !entry.plansHidden && <PlanTable entry={entry} />}
    </section>
  );
}

// ── The plans behind a deposit ──────────────────────────────────────────
//
// Gross, BetterNow fee, net — all three read straight off the payouts row as
// captured at activation, never recomputed from today's commission. "BetterNow
// fee" is the practice-facing name; "MDR" is not a word that appears on any
// practice surface.
//
// The tfoot is the promise of this screen: the nets it sums are the individual
// plan nets, and the number it prints is the one on the row above. When they
// disagree the row says so rather than quietly showing two totals.

function PlanTable({ entry }: { entry: PayoutHistoryEntry }) {
  return (
    <div
      id={`payout-plans-${entry.key}`}
      data-testid={`payout-plan-table:${entry.key}`}
      className="border-t border-gray-100 bg-gray-50/60 px-4 sm:px-5 py-4 overflow-x-auto"
    >
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="py-1.5 pr-3 font-medium">Patient</th>
            <th className="py-1.5 pr-3 font-medium">Invoice / Ref</th>
            <th className="py-1.5 pr-3 font-medium text-right">Bill</th>
            <th className="py-1.5 pr-3 font-medium text-right">BetterNow fee</th>
            <th className="py-1.5 font-medium text-right">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {entry.plans.map((p) => (
            <tr key={p.payoutId} data-testid={`payout-plan-row:${p.payoutId}`}>
              <td className="py-1.5 pr-3 text-gray-900 whitespace-nowrap">{p.patientLabel}</td>
              <td className="py-1.5 pr-3 font-mono text-gray-500 whitespace-nowrap">
                {p.invoiceNumber ?? '—'}
                {p.practiceReference && (
                  <span className="block text-gray-400">{p.practiceReference}</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-700 whitespace-nowrap">
                {formatRand(p.grossAmount)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-500 whitespace-nowrap">
                −{formatRand(p.feeAmount)}
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium text-gray-900 whitespace-nowrap">
                {formatRand(p.netAmount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-300 font-semibold">
            <td className="py-1.5 pr-3" colSpan={4}>
              Total paid to you
            </td>
            <td
              className="py-1.5 text-right tabular-nums"
              data-testid={`payout-plan-total:${entry.key}`}
            >
              {formatRand(entry.plansNetSum)}
            </td>
          </tr>
        </tfoot>
      </table>

      {!entry.sumMatchesTotal && (
        <p className="mt-2 text-xs text-amber-800" data-testid={`payout-sum-mismatch:${entry.key}`}>
          These plans don’t add up to the payout total above. Contact support and we’ll
          reconcile it — the total is what gets paid.
        </p>
      )}
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────
//
// Words, not R0.00 — the same rule the hero's empty state follows. Zero would
// read as a measured figure ("we checked, you are owed nothing") when the
// truth is that no plan has activated yet, and there is a real difference
// between those for a practice that has just started billing.

function EmptyState() {
  return (
    <div
      data-testid="payout-history-empty"
      className="rounded-2xl border border-gray-200 bg-white shadow-sm py-16 text-center"
    >
      <p className="font-medium text-gray-500">No payouts yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-gray-400">
        When a patient accepts a plan, its payout is grouped into that week’s deposit and
        appears here — with the plans that make it up.
      </p>
    </div>
  );
}
