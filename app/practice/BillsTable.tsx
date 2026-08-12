'use client';

import { Fragment, useState } from 'react';
import { calculateFee } from '@/lib/finance';
import {
  PlanSummary,
  formatRand,
  formatDate,
  patientDisplay,
  providerName,
  getPayout,
  getInvitation,
} from './billHelpers';
import {
  deriveBillLifecycleStatus,
  billLifecycleChip,
  type BillLifecycleStatus,
} from '@/lib/bills/lifecycle';

// ─── Recent bills / Bills list — the shared four-column table ─────────────
//
// Collapsed from TEN columns (Reference, Patient, Provider, Specialty, Bill,
// Fee, Net payout, Status, Payout, Created) to FOUR:
//
//   WHO (patient) · HOW MUCH (bill) · STATUS (dominant) · WHEN (date)
//
// The other six move into a per-row detail disclosure. Nothing is removed
// from the product — Reference, Provider, Specialty, Fee, Net payout and
// Payout are all one click away, and the CSV/PDF exports still carry the
// full field set. What changed is what you have to READ to scan the list.
//
// WHY STATUS IS THE DOMINANT ELEMENT
// ──────────────────────────────────
// A practice scanning this list is answering one question: "did I get paid?"
// Ten columns of similarly-weighted small grey text makes that question take
// as long to answer as any other. So status gets a genuinely different visual
// tier from every other cell:
//
//   • the largest type WEIGHT in the row (font-semibold; amount and patient
//     are font-medium, date is normal)
//   • the only cell with a filled chip — background, padding, rounded-full,
//     and a ring that lifts it off the row
//   • the only cell with an ICON, which is also the non-colour channel: a
//     reader who cannot separate the greens from the greys still gets a
//     check / eye / arrow / cross. Colour is never the only signal.
//
// WHY THE COLOURS COME FROM billLifecycleChip AND NOT FROM HERE
// ─────────────────────────────────────────────────────────────
// lib/bills/lifecycle.ts owns label + colour + hint for all four states and
// is shared with BillWaitingPanel. Inventing a second, louder palette here
// would be exactly the drift that helper exists to prevent, and the two
// surfaces would diverge the first time one was edited. So this component
// composes its own LAYOUT (size, chip, ring, icon) — which the helper's own
// docstring explicitly leaves to the surface — and takes colour from the
// helper unchanged. Dominance is achieved without forking the vocabulary.
//
// The palette already does the right thing semantically once it is given
// this much room: Paid reads green, Viewed reads blue, and Sent/Expired sit
// back in grey. The state a practice is hunting for is the one that pops.

type Props = {
  plans:        PlanSummary[];
  feePercent:   number;
  specialtyMap: Record<string, string>;
};

/** The four data columns. A fifth cell carries the disclosure affordance. */
const COLUMNS = ['Patient', 'Amount', 'Status', 'Date'] as const;

// Per-status glyph. Layout/affordance only — the label, colour and hint all
// still come from billLifecycleChip, so this map cannot cause label drift.
function StatusIcon({ status }: { status: BillLifecycleStatus }) {
  const common = {
    width: 14, height: 14, viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (status) {
    case 'paid':    return <svg {...common}><path d="M2.5 8.5l3.5 3.5 7.5-8" /></svg>;
    case 'viewed':  return <svg {...common}><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" /><circle cx="8" cy="8" r="1.75" /></svg>;
    case 'sent':    return <svg {...common}><path d="M14 2L7 9" /><path d="M14 2l-4.5 12-2.5-5-5-2.5L14 2z" /></svg>;
    case 'expired': return <svg {...common}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
  }
}

/**
 * The dominant status element. Deliberately a different visual TIER from
 * every other cell — see the header note. Size/chip/ring/icon are this
 * component's; label + colour + hint are the shared helper's.
 */
function StatusBadge({ status }: { status: BillLifecycleStatus }) {
  const cfg = billLifecycleChip(status);
  // ring-black/5 rather than a per-status ring colour: the hairline exists to
  // lift the chip off the row, and giving it a status colour would fork the
  // palette that billLifecycleChip owns.
  //
  // This is Tailwind v4, where `ring-inset` no longer exists — it would
  // compile to nothing, which is exactly the kind of silently-dead class that
  // leaves a "dominant" element quietly not dominant.
  return (
    <span
      title={cfg.hint}
      aria-label={cfg.hint}
      data-testid={`bill-status:${status}`}
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ring-1 ring-black/5 ${cfg.cls}`}
    >
      <StatusIcon status={status} />
      {cfg.label}
    </span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true"
      className={`transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function lifecycleOf(plan: PlanSummary): BillLifecycleStatus {
  const inv = getInvitation(plan);
  return deriveBillLifecycleStatus({
    planStatus:           plan.status,
    invitationViewedAt:   inv?.viewed_at   ?? null,
    invitationAcceptedAt: inv?.accepted_at ?? null,
    invitationExpiresAt:  inv?.expires_at  ?? null,
  });
}

/**
 * The payout leg, as words. Kept in the detail view rather than the scan
 * columns: it answers "has betternow settled this to my bank yet", which is
 * a reconciliation question, not the question the list is scanned for.
 *
 * Note the label distinguishes processing and failed, which the old Payout
 * column did not — it coloured them differently but printed "Pending" for
 * both, so a FAILED payout was indistinguishable from a queued one unless
 * you could see the colour.
 */
function payoutDetail(plan: PlanSummary): { label: string; cls: string } {
  if (plan.status === 'pending_acceptance') {
    return { label: 'Not yet accepted', cls: 'text-gray-400' };
  }
  const payout = getPayout(plan);
  if (!payout) return { label: '—', cls: 'text-gray-400' };
  switch (payout.status) {
    case 'paid':       return { label: 'Paid out',   cls: 'text-green-700' };
    case 'processing': return { label: 'Processing', cls: 'text-blue-700'  };
    case 'failed':     return { label: 'Failed',     cls: 'text-red-600'   };
    default:           return { label: 'Pending',    cls: 'text-amber-700' };
  }
}

/** The six fields that moved out of the scan columns. */
function DetailFields({
  plan, feePercent, specialtyMap,
}: { plan: PlanSummary; feePercent: number; specialtyMap: Record<string, string> }) {
  const { fee, net } = calculateFee(Number(plan.total_amount), feePercent);
  const payout = payoutDetail(plan);
  const specialty = plan.provider_member_id ? (specialtyMap[plan.provider_member_id] ?? '—') : '—';

  const fields: { label: string; value: React.ReactNode; testid: string }[] = [
    {
      label: 'Reference', testid: 'reference',
      value: (
        <>
          <span className="font-mono text-xs text-gray-700">{plan.invoice_number ?? '—'}</span>
          {plan.practice_reference && (
            <span className="block text-xs text-gray-400 mt-0.5">Ref: {plan.practice_reference}</span>
          )}
        </>
      ),
    },
    { label: 'Provider',    testid: 'provider',   value: providerName(plan) },
    { label: 'Specialty',   testid: 'specialty',  value: specialty },
    { label: 'Fee',         testid: 'fee',        value: <span className="tabular-nums">−{formatRand(fee)}</span> },
    { label: 'Net payout',  testid: 'net',        value: <span className="tabular-nums font-medium text-gray-900">{formatRand(net)}</span> },
    { label: 'Payout',      testid: 'payout',     value: <span className={payout.cls}>{payout.label}</span> },
  ];

  return (
    <dl
      data-testid={`bill-detail:${plan.id}`}
      className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3"
    >
      {fields.map((f) => (
        <div key={f.label} data-testid={`bill-detail-${f.testid}:${plan.id}`}>
          <dt className="text-xs font-medium text-gray-400 uppercase tracking-wide">{f.label}</dt>
          <dd className="mt-0.5 text-sm text-gray-700">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function BillsTable({ plans, feePercent, specialtyMap }: Props) {
  // A set, not a single id: expanding one row must not collapse another the
  // reader was comparing it against.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <>
      {/* ── Mobile cards (< md) ─────────────────────────────────────── */}
      <div className="md:hidden divide-y divide-gray-100" data-testid="bills-mobile">
        {plans.map((plan) => {
          const open = openIds.has(plan.id);
          return (
            <div key={plan.id} className="px-5 py-4">
              <button
                type="button"
                onClick={() => toggle(plan.id)}
                aria-expanded={open}
                aria-controls={`bill-detail-panel-${plan.id}`}
                data-testid={`bill-toggle-mobile:${plan.id}`}
                className="w-full flex items-center justify-between gap-4 text-left"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{patientDisplay(plan)}</p>
                  <div className="mt-2">
                    <StatusBadge status={lifecycleOf(plan)} />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-medium tabular-nums text-gray-900">
                    {formatRand(Number(plan.total_amount))}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatDate(plan.created_at)}</p>
                  <span className="inline-flex items-center gap-1 text-xs text-gray-400 mt-1.5">
                    {open ? 'Less' : 'More'} <ChevronIcon open={open} />
                  </span>
                </div>
              </button>
              {open && (
                <div id={`bill-detail-panel-${plan.id}`} className="mt-4 pt-4 border-t border-gray-100">
                  <DetailFields plan={plan} feePercent={feePercent} specialtyMap={specialtyMap} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Desktop table (md+) ─────────────────────────────────────── */}
      <div className="hidden md:block overflow-x-auto" data-testid="bills-desktop">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left bg-gray-50">
              {COLUMNS.map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
              <th scope="col" className="px-6 py-3 w-px">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {plans.map((plan) => {
              const open = openIds.has(plan.id);
              return (
                <Fragment key={plan.id}>
                  <tr className="hover:bg-gray-50 transition-colors">
                    {/* WHO */}
                    <td className="px-6 py-4 text-sm font-medium text-gray-900 whitespace-nowrap"
                        data-testid={`bill-patient:${plan.id}`}>
                      {patientDisplay(plan)}
                    </td>
                    {/* HOW MUCH */}
                    <td className="px-6 py-4 text-sm font-medium tabular-nums text-gray-900 whitespace-nowrap"
                        data-testid={`bill-amount:${plan.id}`}>
                      {formatRand(Number(plan.total_amount))}
                    </td>
                    {/* STATUS — the dominant column */}
                    <td className="px-6 py-4 whitespace-nowrap" data-testid={`bill-status-cell:${plan.id}`}>
                      <StatusBadge status={lifecycleOf(plan)} />
                    </td>
                    {/* WHEN */}
                    <td className="px-6 py-4 text-xs text-gray-400 whitespace-nowrap"
                        data-testid={`bill-date:${plan.id}`}>
                      {formatDate(plan.created_at)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        type="button"
                        onClick={() => toggle(plan.id)}
                        aria-expanded={open}
                        aria-controls={`bill-detail-row-${plan.id}`}
                        data-testid={`bill-toggle:${plan.id}`}
                        className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 transition-colors"
                      >
                        {open ? 'Less' : 'More'} <ChevronIcon open={open} />
                      </button>
                    </td>
                  </tr>
                  {open && (
                    <tr id={`bill-detail-row-${plan.id}`} className="bg-gray-50/60">
                      <td colSpan={COLUMNS.length + 1} className="px-6 py-4">
                        <DetailFields plan={plan} feePercent={feePercent} specialtyMap={specialtyMap} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
