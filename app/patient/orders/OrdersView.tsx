'use client';

import { useState } from 'react';
import PendingPlanCard from '@/app/patient/PendingPlanCard';
import StatusChip from '@/components/StatusChip';
import { computePlanProgress } from '@/lib/planProgress';
import { planCompletionDate, sortPlansByAnchorDesc, type OrdersTab } from '@/lib/planAnchor';
import PlanSettleAffordance from './PlanSettleAffordance';
import type { SelfSettleResult, SettleAllOutcome } from './settle-actions';
import type { PlanRow, PaymentRow } from './page';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function getPracticeName(plan: PlanRow): string {
  if (!plan.practice) return 'Unknown Practice';
  if (Array.isArray(plan.practice)) return plan.practice[0]?.name ?? 'Unknown Practice';
  return (plan.practice as { name: string }).name;
}

// ─── Status configs ───────────────────────────────────────────────────────────

const PLAN_STATUS: Record<string, { label: string; cls: string }> = {
  pending_first_payment: { label: 'Payment processing', cls: 'bg-blue-100 text-blue-700'   },
  active:                { label: 'Active',              cls: 'bg-green-100 text-green-700' },
  completed:             { label: 'Completed',           cls: 'bg-gray-100 text-gray-600'  },
  defaulted:             { label: 'Overdue',             cls: 'bg-red-100 text-red-700'    },
  cancelled:             { label: 'Cancelled',           cls: 'bg-gray-100 text-gray-500'  },
  declined:              { label: 'Declined',            cls: 'bg-gray-100 text-gray-500'  },
};

const PAYMENT_STATUS: Record<string, { label: string; cls: string }> = {
  scheduled:   { label: 'Scheduled',   cls: 'bg-blue-50 text-blue-700'      },
  processing:  { label: 'Processing',  cls: 'bg-blue-100 text-blue-800'     },
  collected:   { label: 'Collected',   cls: 'bg-green-100 text-green-700'   },
  failed:      { label: 'Failed',      cls: 'bg-red-100 text-red-700'       },
  retried:     { label: 'Retried',     cls: 'bg-amber-100 text-amber-800'   },
  written_off: { label: 'Written off', cls: 'bg-gray-100 text-gray-500'     },
  defaulted:   { label: 'Defaulted',   cls: 'bg-red-100 text-red-700'       },
};

// Per-payment row date label. The original due_date is misleading once
// the ladder has rescheduled a row, so failed shows the next attempt
// and defaulted shows the terminal state. Collected anchors to the
// actual collected_at. processing / retried / written_off render with
// a sensible fallback so an unexpected status doesn't crash the view.
function paymentDateLabel(p: PaymentRow): string {
  switch (p.status) {
    case 'failed':
      return p.next_attempt_date
        ? `Retrying ${formatDate(p.next_attempt_date)}`
        : 'Payment failed';
    case 'defaulted':
      return 'In default';
    case 'collected':
      return p.collected_at
        ? `Paid ${formatDate(p.collected_at.slice(0, 10))}`
        : 'Paid';
    case 'processing':
      return `Charging — was due ${formatDate(p.due_date)}`;
    case 'retried':
      return `Retried — was due ${formatDate(p.due_date)}`;
    case 'written_off':
      return 'Written off';
    default:
      return `Due ${formatDate(p.due_date)}`;
  }
}

// ─── Badge components ─────────────────────────────────────────────────────────
// Both badges now delegate chip chrome to <StatusChip /> so every status
// indicator (plan-level + payment-level) is dimensionally identical.

const UNKNOWN_STATUS = { label: '', cls: 'bg-gray-100 text-gray-600' } as const;

function PlanStatusBadge({ status }: { status: string }) {
  const cfg = PLAN_STATUS[status] ?? { label: status, cls: UNKNOWN_STATUS.cls };
  return <StatusChip label={cfg.label} cls={cfg.cls} />;
}

function PaymentStatusBadge({ status }: { status: string }) {
  const cfg = PAYMENT_STATUS[status] ?? { label: status, cls: UNKNOWN_STATUS.cls };
  return <StatusChip label={cfg.label} cls={cfg.cls} />;
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="w-3.5 h-3.5 shrink-0 text-green-600"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 10.5l3 3 7-7" />
    </svg>
  );
}

// ─── Progress bar + caption ──────────────────────────────────────────────────

function PlanProgress({ plan }: { plan: PlanRow }) {
  const { totalPayments, paidCount, remainingAmount, percent, isPaidInFull } =
    computePlanProgress({
      status:   plan.status,
      payments: plan.payments,
    });

  if (totalPayments === 0) return null;

  const caption = isPaidInFull
    ? `Paid in full · ${totalPayments} payment${totalPayments === 1 ? '' : 's'}`
    : `${paidCount} of ${totalPayments} paid · ${formatRand(remainingAmount)} remaining`;

  return (
    <div className="px-4 sm:px-6 pt-4">
      <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${percent}%`, background: '#15A89E' }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Plan progress"
        />
      </div>
      <p className="mt-2 text-xs text-gray-500 truncate tabular-nums">
        {caption}
      </p>
    </div>
  );
}

// ─── Plan card (non-pending) ──────────────────────────────────────────────────

function PlanCard({
  plan,
  tab,
  settleInstalment,
  settleEntirePlan,
}: {
  plan: PlanRow;
  tab: OrdersTab;
  settleInstalment: (paymentId: string) => Promise<SelfSettleResult>;
  settleEntirePlan: (planId: string) => Promise<SettleAllOutcome>;
}) {
  const practiceName = getPracticeName(plan);

  // Header date anchor — "Started …" everywhere except a Historic plan
  // that has at least one collected payment, where we show
  // "Completed {latest collected_at}". Both Historic with no completion
  // date (cancelled / declined) and Pending / Current fall back to
  // "Started {created_at}".
  const completion = tab === 'historic' ? planCompletionDate(plan) : null;
  const anchorIso  = completion ?? plan.created_at;
  const anchorLabel = `${completion ? 'Completed' : 'Started'} ${formatDate(anchorIso.slice(0, 10))}`;

  // Footer reference line (smallest text). Omit Practice ref when the
  // practice didn't supply one. If neither field is present the whole
  // footer is suppressed.
  const refSegments: string[] = [];
  if (plan.invoice_number)     refSegments.push(`Ref ${plan.invoice_number}`);
  if (plan.practice_reference) refSegments.push(`Practice ref ${plan.practice_reference}`);
  const footerRef = refSegments.join(' · ');

  // The "next due" instalment — the earliest non-collected row. Highlights
  // the row the eye should land on; everything before it is muted (paid),
  // everything after it is also muted (further out).
  const nextDueNumber = plan.payments.find((p) => p.status !== 'collected')?.instalment_number ?? null;

  return (
    <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm overflow-hidden">

      {/* Header */}
      <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-gray-100 space-y-2">
        {/* Line 1: practice name · amount */}
        <div className="flex items-start justify-between gap-4">
          <p className="font-semibold text-gray-900 min-w-0 truncate">{practiceName}</p>
          <p className="text-base font-semibold tabular-nums shrink-0" style={{ color: '#13294B' }}>
            {formatRand(Number(plan.total_amount))}
          </p>
        </div>

        {/* Line 2: status chip · date anchor — wraps below on narrow screens */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <PlanStatusBadge status={plan.status} />
          <p className="text-xs text-gray-400 truncate min-w-0">{anchorLabel}</p>
        </div>
      </div>

      {/* Progress */}
      <PlanProgress plan={plan} />

      {/* Payment schedule */}
      {plan.payments.length > 0 ? (
        <div className="divide-y divide-gray-50 mt-3">
          {plan.payments.map((payment: PaymentRow) => {
            const isCollected = payment.status === 'collected';
            const isNextDue   = !isCollected && payment.instalment_number === nextDueNumber;
            // Three weight tiers: collected (muted + check), next-due (normal),
            // later scheduled (muted) — directs the eye to what's next.
            const rowMuted = isCollected || !isNextDue;
            // Per-row Pay-now buttons are gone post-consolidation. All
            // settle paths route through the plan-level "Manage payments"
            // CTA so the card has ONE calm entry point. The schedule list
            // here is read-only: status + amount + accrued fees.
            const feesCents = Number(payment.dunning_fees_cents ?? 0);
            return (
              <div
                key={payment.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 sm:px-6 py-3"
              >
                <div className={`flex items-center gap-2 text-sm min-w-0 ${rowMuted ? 'text-gray-500' : 'text-gray-900'}`}>
                  {isCollected ? <CheckIcon /> : <span className="w-3.5 shrink-0" aria-hidden />}
                  <span className="whitespace-nowrap">
                    Instalment {payment.instalment_number}
                  </span>
                  <span
                    className={`text-xs whitespace-nowrap ${
                      payment.status === 'failed' || payment.status === 'defaulted'
                        ? 'text-red-600 font-medium'
                        : 'text-gray-400'
                    }`}
                  >
                    {paymentDateLabel(payment)}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <PaymentStatusBadge status={payment.status} />
                    <span className={`text-sm tabular-nums ${rowMuted ? 'text-gray-500' : 'font-medium text-gray-900'}`}>
                      {formatRand(Number(payment.amount))}
                    </span>
                  </div>
                  {feesCents > 0 && (
                    <p className="text-[11px] text-red-600 tabular-nums">
                      + {formatRand(feesCents / 100)} fees
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-4 sm:px-6 py-4 mt-3 text-xs text-gray-400">No payment schedule yet.</p>
      )}

      {/* Plan-level settle affordance — single "Pay now" CTA when
          exactly one instalment is outstanding (both buttons would be
          the same action for the same amount), expandable choice
          ("Pay next instalment" vs "Settle entire bill") when 2+ are
          outstanding (the amounts now differ, the choice is meaningful).
          The amounts displayed come from the same sources the per-row
          PayNowButton and SettleEntireBillButton already use; the
          authoritative settle-all sum is still computed by the RPC at
          claim time. */}
      {tab === 'current' && (() => {
        const outstanding = plan.payments.filter((p) =>
          p.status === 'scheduled' || p.status === 'failed' || p.status === 'defaulted',
        );
        if (outstanding.length === 0) return null;
        const totalCents = outstanding.reduce(
          (sum, p) =>
            sum + Math.round(Number(p.amount) * 100) + Number(p.dunning_fees_cents ?? 0),
          0,
        );
        // "Next outstanding" — the first non-collected instalment in
        // instalment_number order. Already aligns with nextDueNumber
        // used to mute the row UI.
        const next = outstanding[0];
        const nextCents = Math.round(Number(next.amount) * 100) + Number(next.dunning_fees_cents ?? 0);
        return (
          <div className="px-4 sm:px-6 py-3 border-t border-gray-100">
            <PlanSettleAffordance
              planId={plan.id}
              outstandingCount={outstanding.length}
              outstandingTotalCents={totalCents}
              nextOutstanding={{
                paymentId:         next.id,
                chargeAmountCents: nextCents,
                instalmentNumber:  next.instalment_number,
              }}
              settleInstalment={settleInstalment}
              settleEntirePlan={settleEntirePlan}
            />
          </div>
        );
      })()}

      {/* Footer: muted reference line, smallest text. Hidden when the
          practice supplied no invoice number AND no practice ref. */}
      {footerRef && (
        <p className="px-4 sm:px-6 py-2.5 text-[11px] text-gray-400 border-t border-gray-100 truncate">
          {footerRef}
        </p>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

const EMPTY_COPY: Record<'pending' | 'current' | 'historic', string> = {
  pending:  'No pending orders',
  current:  'No active orders',
  historic: 'No past orders',
};

function EmptyState({ tab }: { tab: 'pending' | 'current' | 'historic' }) {
  return (
    <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-5 py-8 text-center">
      <p className="text-sm text-gray-500">{EMPTY_COPY[tab]}</p>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  pendingPlans:   PlanRow[];
  currentPlans:   PlanRow[];
  historicPlans:  PlanRow[];
  declinePlan:      (planId: string)    => Promise<{ error: string | null }>;
  settleInstalment: (paymentId: string) => Promise<SelfSettleResult>;
  settleEntirePlan: (planId: string)    => Promise<SettleAllOutcome>;
  specialtyMap:   Record<string, string>;
  patientBlocked: boolean;
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function OrdersView({
  pendingPlans,
  currentPlans,
  historicPlans,
  declinePlan,
  settleInstalment,
  settleEntirePlan,
  patientBlocked,
}: Props) {
  const [tab, setTab] = useState<'pending' | 'current' | 'historic'>(
    pendingPlans.length > 0 ? 'pending' : 'current'
  );

  const rawPlans =
    tab === 'pending'  ? pendingPlans  :
    tab === 'current'  ? currentPlans  :
                         historicPlans;

  // Newest-first within each tab. Pending / Current sort by created_at;
  // Historic sorts by latest collected_at, falling back to created_at.
  const plans = sortPlansByAnchorDesc(rawPlans, tab);

  function tabCls(t: 'pending' | 'current' | 'historic') {
    return [
      'px-4 py-2 text-sm font-medium rounded-lg transition-colors',
      tab === t
        ? 'bg-white text-[#13294B] shadow-sm'
        : 'text-gray-500 hover:text-gray-700',
    ].join(' ');
  }

  return (
    <div className="space-y-5">
      {/* Tab bar — scrollable on small screens */}
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="inline-flex items-center bg-gray-100 rounded-xl p-1 gap-1 min-w-max">
          <button type="button" onClick={() => setTab('pending')} className={tabCls('pending')}>
            Pending ({pendingPlans.length})
          </button>
          <button type="button" onClick={() => setTab('current')} className={tabCls('current')}>
            Current ({currentPlans.length})
          </button>
          <button type="button" onClick={() => setTab('historic')} className={tabCls('historic')}>
            Historic ({historicPlans.length})
          </button>
        </div>
      </div>

      {/* Plan list */}
      {plans.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div className="space-y-4">
          {plans.map((plan) =>
            plan.status === 'pending_acceptance' ? (
              <PendingPlanCard
                key={plan.id}
                planId={plan.id}
                totalAmount={Number(plan.total_amount)}
                practiceName={getPracticeName(plan)}
                invoiceNumber={plan.invoice_number}
                practiceReference={plan.practice_reference}
                declinePlan={declinePlan}
                blocked={patientBlocked}
              />
            ) : (
              <PlanCard
                key={plan.id}
                plan={plan}
                tab={tab}
                settleInstalment={settleInstalment}
                settleEntirePlan={settleEntirePlan}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
