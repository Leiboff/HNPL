'use client';

import { useState } from 'react';
import PendingPlanCard from '@/app/patient/PendingPlanCard';
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

function getProviderName(plan: PlanRow): string | null {
  const ref = Array.isArray(plan.provider) ? plan.provider[0] : plan.provider;
  if (!ref) return null;
  return `${ref.first_name} ${ref.last_name}`;
}

// ─── Status configs ───────────────────────────────────────────────────────────

const PLAN_STATUS: Record<string, { label: string; cls: string }> = {
  pending_first_payment: { label: 'Payment processing', cls: 'bg-blue-100 text-blue-700'   },
  active:                { label: 'Active',              cls: 'bg-green-100 text-green-700' },
  completed:             { label: 'Completed',           cls: 'bg-gray-100 text-gray-600'  },
  defaulted:             { label: 'Overdue',             cls: 'bg-red-100 text-red-700'    },
  cancelled:             { label: 'Cancelled',           cls: 'bg-gray-100 text-gray-400'  },
  declined:              { label: 'Declined',            cls: 'bg-gray-100 text-gray-400'  },
};

const PAYMENT_STATUS: Record<string, { label: string; cls: string }> = {
  scheduled:   { label: 'Scheduled',   cls: 'bg-blue-50 text-blue-700'      },
  processing:  { label: 'Processing',  cls: 'bg-blue-100 text-blue-800'     },
  collected:   { label: 'Collected',   cls: 'bg-green-100 text-green-700'   },
  failed:      { label: 'Failed',      cls: 'bg-red-100 text-red-700'       },
  retried:     { label: 'Retried',     cls: 'bg-orange-100 text-orange-700' },
  written_off: { label: 'Written off', cls: 'bg-gray-100 text-gray-400'     },
};

// ─── Badge components ─────────────────────────────────────────────────────────

function PlanStatusBadge({ status }: { status: string }) {
  const cfg = PLAN_STATUS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function PaymentStatusBadge({ status }: { status: string }) {
  const cfg = PAYMENT_STATUS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ─── Plan card (non-pending) ──────────────────────────────────────────────────

function PlanCard({ plan, specialty }: { plan: PlanRow; specialty: string | null }) {
  const practiceName   = getPracticeName(plan);
  const providerNameStr = getProviderName(plan);
  const planTypeLabel =
    plan.plan_type != null
      ? `${plan.plan_type} monthly payment${plan.plan_type !== 1 ? 's' : ''}`
      : 'Not yet split';

  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-semibold text-gray-900">{practiceName}</p>
            {plan.invoice_number && (
              <p className="font-mono text-xs text-gray-500 mt-0.5">{plan.invoice_number}</p>
            )}
            {plan.practice_reference && (
              <p className="text-xs text-gray-400">Practice ref: {plan.practice_reference}</p>
            )}
            <p className="text-xs text-gray-400 mt-1">{planTypeLabel}</p>
            {providerNameStr && (
              <p className="text-xs text-gray-600 mt-1">Healthcare provider: {providerNameStr}</p>
            )}
            {specialty && (
              <p className="text-xs text-gray-500">Specialty: {specialty}</p>
            )}
            {plan.practice && (
              <p className="text-xs text-gray-500">Practice: {practiceName}</p>
            )}
          </div>
          <div className="text-right shrink-0 space-y-1">
            <p className="text-base font-semibold text-gray-900 tabular-nums">
              {formatRand(Number(plan.total_amount))}
            </p>
            <PlanStatusBadge status={plan.status} />
          </div>
        </div>
      </div>

      {/* Payment schedule */}
      {plan.payments.length > 0 ? (
        <div className="divide-y divide-gray-50">
          {plan.payments.map((payment: PaymentRow) => (
            <div
              key={payment.id}
              className="flex items-center justify-between px-5 py-2.5"
            >
              <div className="flex items-baseline gap-3 text-sm">
                <span className="text-gray-600 whitespace-nowrap">
                  Instalment {payment.instalment_number}
                </span>
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {formatDate(payment.due_date)}
                </span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-sm font-medium text-gray-900 tabular-nums">
                  {formatRand(Number(payment.amount))}
                </span>
                <PaymentStatusBadge status={payment.status} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-5 py-3 text-xs text-gray-400">No payment schedule yet.</p>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: 'current' | 'historic' }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
      <p className="font-medium text-gray-500">
        {tab === 'current' ? 'No current plans' : 'No historic plans'}
      </p>
      <p className="mt-1 text-sm text-gray-400">
        {tab === 'current'
          ? 'Active and processing plans will appear here.'
          : 'Completed and past plans will appear here.'}
      </p>
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

type Props = {
  currentPlans:  PlanRow[];
  historicPlans: PlanRow[];
  declinePlan: (planId: string) => Promise<{ error: string | null }>;
  specialtyMap:  Record<string, string>;
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function OrdersView({
  currentPlans,
  historicPlans,
  declinePlan,
  specialtyMap,
}: Props) {
  const [tab, setTab] = useState<'current' | 'historic'>('current');

  const plans = tab === 'current' ? currentPlans : historicPlans;

  function tabCls(t: 'current' | 'historic') {
    return [
      'px-4 py-2 text-sm font-medium rounded-lg transition-colors',
      tab === t
        ? 'bg-white text-gray-900 shadow-sm'
        : 'text-gray-500 hover:text-gray-700',
    ].join(' ');
  }

  return (
    <div className="space-y-5">
      {/* Tab bar */}
      <div className="inline-flex items-center bg-gray-100 rounded-xl p-1 gap-1">
        <button type="button" onClick={() => setTab('current')} className={tabCls('current')}>
          Current ({currentPlans.length})
        </button>
        <button type="button" onClick={() => setTab('historic')} className={tabCls('historic')}>
          Historic ({historicPlans.length})
        </button>
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
              />
            ) : (
              <PlanCard
                key={plan.id}
                plan={plan}
                specialty={
                  plan.provider_id && plan.practice_id
                    ? (specialtyMap[`${plan.provider_id}:${plan.practice_id}`] ?? null)
                    : null
                }
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
