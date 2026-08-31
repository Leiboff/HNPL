'use client';

import { useState } from 'react';
import Link from 'next/link';
import InstalmentLadder, { ladderFromCounts } from './InstalmentLadder';
import { formatRand } from './_format';

// ─── HomeBillCard — v4 "Waiting on you" card ─────────────────────────────
//
// Home surfaces a pending bill as the first thing needing action: an
// amber-accented card with the practice, the total, the instalment shape,
// and two actions — Review bill (into the existing accept flow) and Not
// mine (into the existing decline flow, confirm-gated). It's the home
// counterpart of the Plans-tab PendingPlanCard; same server action.
//
// Copy honesty: betternow plans are interest-free (true), so we say
// "interest-free" — but we do NOT claim "no fees", because late (dunning)
// fees can accrue on a missed collection.

export default function HomeBillCard({
  planId,
  practiceName,
  total,
  planType,
  declinePlan,
  ladder = false,
  blocked = false,
}: {
  planId:       string;
  practiceName: string;
  total:        number;
  planType:     number | null;
  declinePlan:  (planId: string) => Promise<{ error: string | null }>;
  /** Show the unaccepted-bill amber ladder (Plans list, not Home). */
  ladder?:      boolean;
  /** True when the patient can't take a new plan until their first
   *  completes — Review is locked (the accept flow enforces this too). */
  blocked?:     boolean;
}) {
  const [declining, setDeclining] = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const perInstalment = planType && planType > 0 ? total / planType : null;

  async function handleDecline() {
    if (!window.confirm(`Decline this bill from ${practiceName}? This can't be undone.`)) return;
    setError(null);
    setDeclining(true);
    const result = await declinePlan(planId);
    if (result.error) {
      setError(result.error);
      setDeclining(false);
    } else {
      window.location.reload();
    }
  }

  return (
    <div
      className="rounded-card bg-white p-[18px] flex flex-col gap-[13px]"
      style={{ border: '1px solid #F5D49A', boxShadow: '0 2px 6px -2px rgba(15,31,58,.08)' }}
      data-testid="home-bill-card"
    >
      <div className="flex items-center gap-[9px]">
        <span className="w-2 h-2 rounded-full" style={{ background: '#F59E0B' }} />
        <span className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: '#B45309' }}>
          Waiting on you
        </span>
      </div>

      <div>
        <p className="text-[16px] font-semibold leading-[1.4]" style={{ color: 'var(--portal-ink)' }}>
          {practiceName} sent a bill for{' '}
          <span className="tabular-nums">{formatRand(total)}</span>
        </p>
        <p className="mt-1.5 text-[13.5px]" style={{ color: 'var(--portal-muted)' }}>
          {perInstalment != null
            ? <>{planType} instalments of <span className="tabular-nums">{formatRand(perInstalment)}</span> · interest-free</>
            : 'Interest-free payment plan'}
        </p>
      </div>

      {ladder && planType && planType > 0 && (
        <InstalmentLadder segments={ladderFromCounts(planType, 0, 'pending')} />
      )}

      {error && (
        <p className="text-[12.5px] text-red-600" role="alert">{error}</p>
      )}

      {blocked && (
        <p className="text-[12.5px]" style={{ color: '#B45309' }}>
          You can take this on once your first plan is complete.
        </p>
      )}

      <div className="flex gap-[9px]">
        {blocked ? (
          <span
            aria-disabled="true"
            className="flex-1 text-center text-[14.5px] font-semibold rounded-tile py-[14px] cursor-not-allowed select-none"
            style={{ background: 'var(--portal-wash)', color: 'var(--portal-muted)' }}
          >
            Review bill
          </span>
        ) : (
          <Link
            href={`/patient/orders/${planId}/confirm`}
            className="flex-1 text-center text-[14.5px] font-semibold text-white rounded-tile py-[14px]"
            style={{ background: 'var(--portal-accent)' }}
          >
            Review bill
          </Link>
        )}
        <button
          type="button"
          onClick={handleDecline}
          disabled={declining}
          className="text-[14.5px] font-semibold rounded-tile px-[18px] py-[14px] disabled:opacity-50"
          style={{ background: 'var(--portal-wash)', color: 'var(--portal-ink-2)' }}
        >
          {declining ? 'Declining…' : 'Not mine'}
        </button>
      </div>
    </div>
  );
}
