'use client';

import { useState } from 'react';
import { formatRand } from './billHelpers';
import { formatWeekdayDayMonth, formatDayMonth } from '@/app/patient/_format';
import type { NextPayoutResult, PayoutPlanLine } from '@/lib/practice/nextPayout';

// ─── "Next payout" hero ─────────────────────────────────────────────────
//
// The first thing a practice owner sees. It answers one question — how much
// is coming and when — so the two things it must never do are invent a
// figure and overstate a certainty.
//
// NO DATE MATH LIVES HERE. Every date string arrives pre-resolved from
// lib/payments/payoutSchedule.ts (which derives it from payoutWindow.ts) and
// is only ever rendered through the shared formatters. There is no Date
// construction, no toISOString, no getDay, and no "Friday" literal anywhere
// in this file — if the payout boundary moves, this component follows it
// without being touched. See payoutSchedule.ts for why that matters: a
// component that formats a SAST-midnight instant in UTC silently reports the
// wrong DAY, which a practice cannot tell apart from a money bug.
//
// Money is formatted by ./billHelpers formatRand — the same helper the bills
// table and the bill form use. Weekday/day/month come from @/app/patient
// /_format, the codebase's only weekday formatter; it is pure string maths on
// YYYY-MM-DD, so it cannot drift by timezone.

export type NextPayoutHeroProps = {
  data: NextPayoutResult;
  /** Pre-resolved SAST date strings — see the note above on why. */
  dates: {
    /** YYYY-MM-DD the shown figure is paid on. Null in the empty state. */
    payoutDate: string | null;
    /** First and last SAST calendar dates the window covers. */
    windowFirst: string | null;
    windowLast:  string | null;
  };
};

const NAVY = '#13294B';

export default function NextPayoutHero({ data, dates }: NextPayoutHeroProps) {
  const { next } = data;

  return (
    <section
      data-testid="next-payout-hero"
      className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden"
    >
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-6 p-5 sm:p-6">
        <div className="min-w-0">
          {next.kind === 'none'
            ? <EmptyState />
            : <Figure next={next} dates={dates} />}
        </div>

        <PaidRecently
          net={data.paidRecentlyNet}
          count={data.paidRecentlyCount}
        />
      </div>

      <Footnotes data={data} />
    </section>
  );
}

// ── The figure itself ───────────────────────────────────────────────────

function Figure({
  next,
  dates,
}: {
  next: Extract<NextPayoutResult['next'], { kind: 'committed' | 'projected' }>;
  dates: NextPayoutHeroProps['dates'];
}) {
  const [open, setOpen] = useState(false);
  const committed = next.kind === 'committed';

  return (
    <div>
      {/* The label carries the certainty, before the number is even read. */}
      <div className="flex items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {committed ? 'Next payout' : 'Building this week'}
        </p>
        {!committed && (
          <span
            data-testid="payout-estimate-badge"
            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
          >
            Estimate
          </span>
        )}
      </div>

      <p
        data-testid="payout-amount"
        className="mt-1 text-3xl sm:text-4xl font-semibold tabular-nums"
        style={{ color: NAVY }}
      >
        {formatRand(next.totalNet)}
      </p>

      {/* When. A committed batch is a date; a projection is a date the
          figure is EXPECTED to be paid on, and says so. */}
      {dates.payoutDate && (
        <p className="mt-1 text-sm text-gray-700" data-testid="payout-when">
          {committed ? 'Lands ' : 'Expected '}
          <span className="font-semibold">{formatWeekdayDayMonth(dates.payoutDate)}</span>
        </p>
      )}

      {/* What it covers, in plain language. */}
      {dates.windowFirst && dates.windowLast && (
        <p className="mt-1 text-xs text-gray-500" data-testid="payout-window">
          Covers plans activated {formatWeekdayDayMonth(dates.windowFirst)}
          {' – '}
          {formatWeekdayDayMonth(dates.windowLast)}
        </p>
      )}

      {!committed && (
        <p className="mt-2 text-xs text-amber-800" data-testid="payout-estimate-note">
          This week is still open, so it isn&apos;t final — any plan a patient accepts before{' '}
          {dates.windowLast ? formatDayMonth(dates.windowLast) : 'the week closes'} is added to it.
        </p>
      )}

      {/* "from N plans" — a real control, not decoration. */}
      <div className="mt-3">
        {/* plansHidden means the batch says it holds N plans and none came
            back. It used to be a permission gap — payouts was readable only by
            a member with can_manage_practice while payout_batches was readable
            by any member, so an ordinary member saw a count above an empty
            list. Migration 0092 aligned the two, so that is no longer the
            reason and the copy no longer claims it is.
            What remains is a genuine inconsistency: a batch whose plan_count
            disagrees with its members. Rare, not the viewer's fault, and not
            something they can act on — so the copy protects the one thing they
            care about (the total is still good) and routes it to someone who
            can fix it. */}
        {next.plansHidden ? (
          <p className="text-xs text-gray-500" data-testid="payout-plans-hidden">
            From {next.planCount} plan{next.planCount === 1 ? '' : 's'}, but the breakdown
            isn&apos;t available. The total above is still what gets paid &mdash; contact
            support and we&apos;ll reconcile it.
          </p>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="payout-plan-list"
            data-testid="payout-plans-toggle"
            className="text-xs font-semibold underline underline-offset-2 hover:opacity-70 transition-opacity"
            style={{ color: NAVY }}
          >
            From {next.planCount} plan{next.planCount === 1 ? '' : 's'}
            {open ? ' — hide' : ' — show'}
          </button>
        )}
      </div>

      {open && !next.plansHidden && <PlanList plans={next.plans} total={next.totalNet} />}
    </div>
  );
}

function PlanList({ plans, total }: { plans: PayoutPlanLine[]; total: number }) {
  return (
    <div id="payout-plan-list" data-testid="payout-plan-list" className="mt-3 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100 text-left text-gray-500">
            <th className="py-1.5 pr-3 font-medium">Patient</th>
            <th className="py-1.5 pr-3 font-medium">Invoice</th>
            <th className="py-1.5 font-medium text-right">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {plans.map((p) => (
            <tr key={p.payoutId}>
              <td className="py-1.5 pr-3 text-gray-900 whitespace-nowrap">{p.patientLabel}</td>
              <td className="py-1.5 pr-3 font-mono text-gray-500 whitespace-nowrap">
                {p.invoiceNumber ?? '—'}
              </td>
              <td className="py-1.5 text-right tabular-nums text-gray-900 whitespace-nowrap">
                {formatRand(p.netAmount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-200 font-semibold">
            <td className="py-1.5 pr-3" colSpan={2}>Total</td>
            <td className="py-1.5 text-right tabular-nums" data-testid="payout-plan-list-total">
              {formatRand(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────
//
// Deliberately NOT "R0.00". Zero would read as a measured figure — "we
// checked, you are owed nothing" — when the truth is that nothing has been
// scheduled yet. It is also the state a member without can_manage_practice
// lands on when RLS hides the payouts rows a projection would need (see
// nextPayout.ts), so the copy must not assert anything about the world.

function EmptyState() {
  return (
    <div data-testid="payout-empty">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Next payout</p>
      <p className="mt-1 text-lg font-semibold text-gray-400">Nothing scheduled yet</p>
      <p className="mt-1 text-xs text-gray-500">
        Once a patient accepts a plan, its payout appears here with the date it lands.
      </p>
    </div>
  );
}

// ── Secondary figure ────────────────────────────────────────────────────

function PaidRecently({ net, count }: { net: number; count: number }) {
  return (
    <div
      data-testid="payout-paid-recently"
      className="sm:min-w-45 sm:border-l sm:border-gray-100 sm:pl-6"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
        Paid out
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-green-700">
        {formatRand(net)}
      </p>
      <p className="mt-0.5 text-xs text-gray-500">
        Last 30 days
        {count > 0 && ` · ${count} payout${count === 1 ? '' : 's'}`}
      </p>
    </div>
  );
}

// ── The two things that should never happen, said out loud ──────────────

function Footnotes({ data }: { data: NextPayoutResult }) {
  const { otherPendingCount, otherPendingNet, strandedCount } = data;
  if (otherPendingCount === 0 && strandedCount === 0) return null;

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-5 sm:px-6 py-3 space-y-1">
      {otherPendingCount > 0 && (
        <p className="text-xs text-gray-600" data-testid="payout-other-pending">
          {otherPendingCount} earlier payout{otherPendingCount === 1 ? '' : 's'} totalling{' '}
          <span className="font-semibold tabular-nums">{formatRand(otherPendingNet)}</span>{' '}
          {otherPendingCount === 1 ? 'is' : 'are'} also still to be transferred — each arrives
          as its own deposit.
        </p>
      )}
      {strandedCount > 0 && (
        <p className="text-xs text-gray-600" data-testid="payout-stranded">
          {strandedCount} plan{strandedCount === 1 ? '' : 's'} activated in an earlier week
          {strandedCount === 1 ? ' is' : ' are'} not in a payout yet. We&apos;re on it — no
          action needed from you.
        </p>
      )}
    </div>
  );
}
