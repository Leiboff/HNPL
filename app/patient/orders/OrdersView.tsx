'use client';

import Link from 'next/link';
import HomeBillCard from '@/app/patient/HomeBillCard';
import InstalmentLadder, { ladderFromCounts } from '@/app/patient/InstalmentLadder';
import { computePlanProgress } from '@/lib/planProgress';
import { planCompletionDate } from '@/lib/planAnchor';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import { formatRand, formatDate, formatDayMonth } from '@/app/patient/_format';
import CollectionStatusBadge, { classifyCollection, type CollectionBucket } from '@/app/admin/_components/CollectionStatusBadge';
import type { PlanRow } from './page';

/** The v5 card surface — one shadow and one border across the portal. */
const CARD_SHADOW = '0 2px 8px -3px rgba(15,31,58,.09)';
const CARD_BORDER = '1px solid rgba(19,41,75,.06)';

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
      className="rounded-card bg-white p-[18px] flex flex-col gap-[13px]"
      style={{ border: '1px solid #F2DCB2', boxShadow: CARD_SHADOW }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15.5px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{getPracticeName(plan)}</h3>
          {plan.invoice_number && (
            <p className="font-mono text-[12px] mt-0.5 truncate" style={{ color: 'var(--portal-muted)' }}>{plan.invoice_number}</p>
          )}
        </div>
        <span className="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: '#FBE5C8', color: '#B45309' }}>
          Payment not finished
        </span>
      </div>
      <p className="text-[13.5px]" style={{ color: 'var(--portal-muted)' }}>
        Your first instalment wasn&apos;t completed and no money was taken. Pick up where you left off — it only takes a tap.
      </p>
      <Link
        href={`/patient/orders/${plan.id}/confirm`}
        data-testid="resume-payment-link"
        className="bn-btn-teal inline-flex items-center justify-center rounded-tile px-5 py-[15px] text-[14.5px] font-semibold text-white"
      >
        Resume payment →
      </Link>
    </div>
  );
}

function ProcessingCard({ plan }: { plan: PlanRow }) {
  return (
    <div
      className="rounded-card bg-white p-[18px] flex items-center justify-between gap-3"
      style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
    >
      <div className="min-w-0">
        <p className="text-[15.5px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{getPracticeName(plan)}</p>
        <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--portal-muted)' }}>Setting up your first payment…</p>
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
      style={{ letterSpacing: '.14em', color: tone === 'amber' ? '#B45309' : 'var(--portal-muted)' }}
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
    status:  out.status,
    amount:  Number(out.amount) + Number(out.dunning_fees_cents ?? 0) / 100,
    date:    out.next_attempt_date ?? out.due_date,
    // Overdue is derived (due date vs today), not read from the stored
    // status — so a past-due `scheduled` row reads red here too.
    overdue: deriveInstalmentStatus(out, today) === 'overdue',
  };
}

// ── Active "Paying off" card — taps through to the detail screen ───────
//
// The chevron is gone and a CollectionStatusBadge takes its place. The
// chevron said "this opens" — which the whole card being tappable already
// says — while the top-right corner is the first place the eye lands on a
// card, so it was spending the most valuable spot on the least information.
// The badge puts the plan's state there instead, in the SAME vocabulary the
// schedule rows and the admin collections list use (classifyCollection), so
// a patient reading "Overdue" here and an agent reading "Overdue" on the
// same row are looking at one verdict.
function PayingOffCard({ plan, today }: { plan: PlanRow; today: string }) {
  const prog  = computePlanProgress({ status: plan.status, payments: plan.payments });
  const total = prog.totalPayments || (plan.plan_type ?? 0);
  const next  = nextOutstanding(plan, today);

  // The plan's bucket is its next outstanding instalment's bucket — that
  // row is the one thing about the plan that can currently go wrong. A plan
  // with nothing outstanding is collected, whatever its rows say.
  const bucket: CollectionBucket = next
    ? classifyCollection({ status: next.status, due_date: next.date }, today)
    : 'collected';

  const sub = [
    plan.invoice_number,
    `Started ${formatDate(plan.created_at.slice(0, 10))}`,
  ].filter(Boolean).join(' · ');

  return (
    <Link
      href={`/patient/orders/${plan.id}`}
      className="bn-card-hover block rounded-card bg-white p-[18px]"
      style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{getPracticeName(plan)}</p>
          <p className="mt-[5px] text-[12.5px] truncate" style={{ color: 'var(--portal-faint)' }}>{sub}</p>
        </div>
        <span className="flex-none"><CollectionStatusBadge bucket={bucket} /></span>
      </div>
      <div className="mt-[13px]">
        <InstalmentLadder segments={ladderFromCounts(total, prog.paidCount)} />
      </div>
      <div className="mt-[13px] flex items-baseline justify-between gap-3 tabular-nums">
        <span className="text-[12.5px]" style={{ color: next?.overdue ? '#B42318' : 'var(--portal-muted)' }}>
          {next
            ? next.overdue
              ? `${formatRand(next.amount)} overdue since ${formatDayMonth(next.date)}`
              : `${formatRand(next.amount)} on ${formatDayMonth(next.date)}`
            : `${prog.paidCount} of ${total} paid`}
        </span>
        <span className="text-[14.5px] font-semibold" style={{ color: 'var(--portal-ink)' }}>
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
    plan.status === 'cancelled'               ? 'cancelled' :
                                                'closed';
  return (
    <Link
      href={`/patient/orders/${plan.id}`}
      className="bn-card-hover flex items-center gap-3 rounded-card bg-white px-[18px] py-[16px]"
      style={{ border: CARD_BORDER }}
    >
      <span className="flex-none w-7 h-7 rounded-full flex items-center justify-center" style={{ background: '#F0FDF4' }}>
        <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 10.5l3 3 7-7" />
        </svg>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[14.5px] font-semibold" style={{ color: 'var(--portal-ink)' }}>{getPracticeName(plan)}</p>
        <p className="mt-0.5 text-[12.5px] tabular-nums" style={{ color: 'var(--portal-muted)' }}>
          {formatRand(Number(plan.total_amount))} · {settledLabel}
        </p>
      </div>
      <span className="flex-none text-[13px] font-semibold" style={{ color: 'var(--portal-accent-ink)' }}>Receipt</span>
    </Link>
  );
}

// A declined bill: neutral indicator, NO green tick and NO "Receipt" (nothing
// was charged). Taps through to the minimal "what happened" detail screen.
function DeclinedRow({ plan }: { plan: PlanRow }) {
  return (
    <Link
      href={`/patient/orders/${plan.id}`}
      className="bn-card-hover flex items-center gap-3 rounded-card bg-white px-[18px] py-[16px]"
      style={{ border: CARD_BORDER }}
    >
      <span className="flex-none w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'var(--portal-wash)' }}>
        <svg viewBox="0 0 20 20" width="12" height="12" fill="none" style={{ stroke: 'var(--portal-faint)' }} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 6l8 8M14 6l-8 8" />
        </svg>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[14.5px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{getPracticeName(plan)}</p>
        <p className="mt-0.5 text-[12.5px] tabular-nums" style={{ color: 'var(--portal-muted)' }}>
          {formatRand(Number(plan.total_amount))} · declined
        </p>
      </div>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" style={{ stroke: 'var(--portal-faint)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
        <path d="m9 6 6 6-6 6" />
      </svg>
    </Link>
  );
}

type Props = {
  pendingPlans:   PlanRow[];
  currentPlans:   PlanRow[];
  finishedPlans:  PlanRow[];
  declinedPlans:  PlanRow[];
  declinePlan:    (planId: string) => Promise<{ error: string | null }>;
  patientBlocked: boolean;
  /** Server-computed SAST date (YYYY-MM-DD) so overdue derivation matches
      the other surfaces and doesn't drift on client hydration. */
  today:          string;
};

export default function OrdersView({
  pendingPlans,
  currentPlans,
  finishedPlans,
  declinedPlans,
  declinePlan,
  patientBlocked,
  today,
}: Props) {
  const nothing =
    pendingPlans.length === 0 &&
    currentPlans.length === 0 &&
    finishedPlans.length === 0 &&
    declinedPlans.length === 0;

  if (nothing) {
    return (
      <div
        className="bn-up rounded-card bg-white px-[20px] py-[30px] text-center"
        style={{ border: '1px dashed var(--portal-line)' }}
      >
        <p className="text-[15px] font-semibold" style={{ color: 'var(--portal-ink)' }}>No payment plans yet</p>
        <p className="mt-1.5 text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
          When a practice sends you a bill it lands here, split into interest-free instalments.
        </p>
        <Link
          href="/patient/explore"
          className="bn-btn-teal mt-4 inline-flex items-center rounded-tile px-[18px] py-[13px] text-[13.5px] font-semibold text-white"
        >
          Find care near you
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

      {finishedPlans.length > 0 && (
        <div className="flex flex-col gap-[10px]">
          <SectionHeading label="Finished" />
          {finishedPlans.map((plan) => <FinishedRow key={plan.id} plan={plan} />)}
        </div>
      )}

      {declinedPlans.length > 0 && (
        <div className="flex flex-col gap-[10px]">
          <SectionHeading label="Declined" />
          {declinedPlans.map((plan) => <DeclinedRow key={plan.id} plan={plan} />)}
        </div>
      )}

    </div>
  );
}
