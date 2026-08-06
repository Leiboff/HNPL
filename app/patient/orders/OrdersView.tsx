'use client';

import Link from 'next/link';
import HomeBillCard from '@/app/patient/HomeBillCard';
import InstalmentLadder, { ladderFromCounts } from '@/app/patient/InstalmentLadder';
import { computePlanProgress } from '@/lib/planProgress';
import { planCompletionDate } from '@/lib/planAnchor';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import { formatRand, formatDate, formatDayMonth } from '@/app/patient/_format';
import type { PlanRow } from './page';

// ─── OrdersView — v4 "Plans" screen ──────────────────────────────────────
//
// The Pending / Current / Historic segmented control is gone. One scroll,
// three headings, most-urgent first: Waiting on you, Paying off, Finished.
// Each plan carries its own instalment ladder and next-due line, and every
// plan card taps through to the Plan-detail screen (/patient/orders/[id])
// where the pay actions live.
//
// The resume affordance for an abandoned saved-card first charge
// (pending_first_payment + no registration) is preserved verbatim — the
// money-path resume contract is pinned by resume-payment.test.ts.

function getPracticeName(plan: PlanRow): string {
  if (!plan.practice) return 'Unknown Practice';
  if (Array.isArray(plan.practice)) return plan.practice[0]?.name ?? 'Unknown Practice';
  return (plan.practice as { name: string }).name;
}

// A plan sits here when the saved-card first-instalment one-click was
// started but abandoned (widget closed / 3DS dropped): status
// pending_first_payment, no stored registration yet, no money taken.
function ResumePaymentCard({ plan }: { plan: PlanRow }) {
  return (
    <div
      className="rounded-[22px] bg-white p-[18px] flex flex-col gap-[13px]"
      style={{ border: '1px solid #F5D49A', boxShadow: '0 2px 6px -2px rgba(15,31,58,.08)' }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15.5px] font-semibold truncate" style={{ color: '#13294B' }}>{getPracticeName(plan)}</h3>
          {plan.invoice_number && (
            <p className="font-mono text-[12px] mt-0.5 truncate" style={{ color: '#8496AA' }}>{plan.invoice_number}</p>
          )}
        </div>
        <span className="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: '#FBE5C8', color: '#B45309' }}>
          Payment not finished
        </span>
      </div>
      <p className="text-[13.5px]" style={{ color: '#8496AA' }}>
        Your first instalment wasn&apos;t completed and no money was taken. Pick up where you left off — it only takes a tap.
      </p>
      <Link
        href={`/patient/orders/${plan.id}/confirm`}
        data-testid="resume-payment-link"
        className="inline-flex items-center justify-center rounded-[14px] px-5 py-[14px] text-[14.5px] font-semibold text-white"
        style={{ background: '#15A89E' }}
      >
        Resume payment →
      </Link>
    </div>
  );
}

function ProcessingCard({ plan }: { plan: PlanRow }) {
  return (
    <div
      className="rounded-[22px] bg-white p-[18px] flex items-center justify-between gap-3"
      style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
    >
      <div className="min-w-0">
        <p className="text-[15.5px] font-semibold truncate" style={{ color: '#13294B' }}>{getPracticeName(plan)}</p>
        <p className="mt-0.5 text-[12.5px]" style={{ color: '#8496AA' }}>Setting up your first payment…</p>
      </div>
      <span className="shrink-0 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold" style={{ background: '#EAF1FB', color: '#2B5FA8' }}>
        Processing
      </span>
    </div>
  );
}

function SectionHeading({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'amber' }) {
  return (
    <p
      className="text-[11px] font-semibold uppercase"
      style={{ letterSpacing: '.14em', color: tone === 'amber' ? '#B45309' : '#8496AA' }}
    >
      {label}
    </p>
  );
}

function nextOutstanding(plan: PlanRow, today: string) {
  const out = [...plan.payments]
    .filter((p) => p.status !== 'collected' && p.status !== 'written_off')
    .sort((a, b) => a.instalment_number - b.instalment_number)[0];
  if (!out) return null;
  return {
    amount:  Number(out.amount) + Number(out.dunning_fees_cents ?? 0) / 100,
    date:    out.next_attempt_date ?? out.due_date,
    // Overdue is derived (due date vs today), not read from the stored
    // status — so a past-due `scheduled` row reads red here too.
    overdue: deriveInstalmentStatus(out, today) === 'overdue',
  };
}

// ── Active "Paying off" card — taps through to the detail screen ───────
function PayingOffCard({ plan, today }: { plan: PlanRow; today: string }) {
  const prog  = computePlanProgress({ status: plan.status, payments: plan.payments });
  const total = prog.totalPayments || (plan.plan_type ?? 0);
  const next  = nextOutstanding(plan, today);
  return (
    <Link
      href={`/patient/orders/${plan.id}`}
      className="block rounded-[22px] bg-white p-[18px]"
      style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15.5px] font-semibold truncate" style={{ color: '#13294B' }}>{getPracticeName(plan)}</p>
          <p className="mt-1 text-[12.5px]" style={{ color: '#8496AA' }}>Started {formatDate(plan.created_at.slice(0, 10))}</p>
        </div>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#B6C1CD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none mt-0.5" aria-hidden>
          <path d="m9 6 6 6-6 6" />
        </svg>
      </div>
      <div className="mt-[13px]">
        <InstalmentLadder segments={ladderFromCounts(total, prog.paidCount)} />
      </div>
      <div className="mt-[13px] flex items-center justify-between gap-3 tabular-nums">
        <span className="text-[12.5px]" style={{ color: next?.overdue ? '#B42318' : '#8496AA' }}>
          {next
            ? next.overdue
              ? `${formatRand(next.amount)} overdue since ${formatDayMonth(next.date)}`
              : `${formatRand(next.amount)} on ${formatDayMonth(next.date)}`
            : `${prog.paidCount} of ${total} paid`}
        </span>
        <span className="text-[13.5px] font-semibold" style={{ color: '#13294B' }}>
          {prog.isPaidInFull ? 'Paid in full' : `${formatRand(prog.remainingAmount)} left`}
        </span>
      </div>
    </Link>
  );
}

function FinishedRow({ plan }: { plan: PlanRow }) {
  const completion = planCompletionDate(plan);
  const settledLabel =
    plan.status === 'completed' && completion ? `settled ${formatDate(completion.slice(0, 10))}` :
    plan.status === 'declined'                ? 'declined' :
    plan.status === 'cancelled'               ? 'cancelled' :
                                                'closed';
  return (
    <Link
      href={`/patient/orders/${plan.id}`}
      className="flex items-center gap-3 rounded-[22px] bg-white px-[18px] py-[16px]"
      style={{ border: '1px solid rgba(19,41,75,.06)' }}
    >
      <span className="flex-none w-7 h-7 rounded-full flex items-center justify-center" style={{ background: '#F0FDF4' }}>
        <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 10.5l3 3 7-7" />
        </svg>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[14.5px] font-semibold" style={{ color: '#13294B' }}>{getPracticeName(plan)}</p>
        <p className="mt-0.5 text-[12.5px] tabular-nums" style={{ color: '#8496AA' }}>
          {formatRand(Number(plan.total_amount))} · {settledLabel}
        </p>
      </div>
      <span className="flex-none text-[13px] font-semibold" style={{ color: '#0F766E' }}>Receipt</span>
    </Link>
  );
}

type Props = {
  pendingPlans:   PlanRow[];
  currentPlans:   PlanRow[];
  historicPlans:  PlanRow[];
  declinePlan:    (planId: string) => Promise<{ error: string | null }>;
  patientBlocked: boolean;
  /** Server-computed SAST date (YYYY-MM-DD) so overdue derivation matches
      the other surfaces and doesn't drift on client hydration. */
  today:          string;
};

export default function OrdersView({
  pendingPlans,
  currentPlans,
  historicPlans,
  declinePlan,
  patientBlocked,
  today,
}: Props) {
  const nothing = pendingPlans.length === 0 && currentPlans.length === 0 && historicPlans.length === 0;

  if (nothing) {
    return (
      <div
        className="rounded-[22px] bg-white p-[18px] text-center"
        style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
      >
        <p className="text-[14px]" style={{ color: '#41556F' }}>You don&rsquo;t have any plans yet.</p>
        <Link
          href="/patient/explore"
          className="mt-3 inline-flex items-center rounded-[14px] px-4 py-2.5 text-[13.5px] font-semibold text-white"
          style={{ background: '#15A89E' }}
        >
          Find care →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">

      {pendingPlans.length > 0 && (
        <div className="flex flex-col gap-[10px]">
          <SectionHeading label="Waiting on you" tone="amber" />
          {pendingPlans.map((plan) =>
            plan.status === 'pending_first_payment' && !plan.peach_registration_id ? (
              <ResumePaymentCard key={plan.id} plan={plan} />
            ) : plan.status === 'pending_acceptance' ? (
              <HomeBillCard
                key={plan.id}
                planId={plan.id}
                practiceName={getPracticeName(plan)}
                total={Number(plan.total_amount)}
                planType={plan.plan_type}
                declinePlan={declinePlan}
                ladder
                blocked={patientBlocked}
              />
            ) : (
              <ProcessingCard key={plan.id} plan={plan} />
            ),
          )}
        </div>
      )}

      {currentPlans.length > 0 && (
        <div className="flex flex-col gap-[10px]">
          <SectionHeading label="Paying off" />
          {currentPlans.map((plan) => <PayingOffCard key={plan.id} plan={plan} today={today} />)}
        </div>
      )}

      {historicPlans.length > 0 && (
        <div className="flex flex-col gap-[10px]">
          <SectionHeading label="Finished" />
          {historicPlans.map((plan) => <FinishedRow key={plan.id} plan={plan} />)}
        </div>
      )}

    </div>
  );
}
