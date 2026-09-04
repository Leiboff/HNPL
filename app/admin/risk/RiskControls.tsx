'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePendingAction } from '@/components/loading/usePendingAction';
import { decideReview, toggleKillSwitch } from './actions';
import type { RiskKillSwitch } from '@/lib/risk/vocabulary';

// ─── The two interactive pieces of /admin/risk ──────────────────────────────
//
// Client components because both are buttons that call a server action and
// need to show what happened. Everything they can do is re-authorised on the
// server (admin role + AAL2 in ./actions.ts) — these are triggers, never
// decisions, which is the same posture every other admin surface here takes.
//
// Both drive their controls through `usePendingAction` rather than a raw
// isPending. The ref-backed immediate guard is the part that matters here:
// double-clicking "Reject" would fire a second decision on a review the first
// click already decided, and double-clicking a kill switch would flip it and
// flip it back. `showLabel` handles the other half — an admin action that
// completes in 80ms should not flash a spinner at anyone.

// ─── Reasons, rendered as sentences ─────────────────────────────────────────
//
// A reviewer decides faster from "the same device has been used by 4 accounts
// in the last 7 days (limit 3)" than from a JSON blob, and the whole value of
// a review state is the speed of the human decision at the end of it.
//
// No token is rendered, here or anywhere on this page. See the page header.

function windowLabel(seconds: unknown): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 'the window';
  if (s % 86_400 === 0) {
    const days = s / 86_400;
    return days === 1 ? 'the last day' : `the last ${days} days`;
  }
  if (s % 3_600 === 0) {
    const hours = s / 3_600;
    return hours === 1 ? 'the last hour' : `the last ${hours} hours`;
  }
  return `the last ${Math.round(s / 60)} minutes`;
}

const DIMENSION_NOUN: Record<string, string> = {
  identity:          'SA ID',
  kyc_session:       'verification session',
  card:              'payment card',
  device:            'device',
  phone:             'phone number',
  email:             'email address',
  email_domain:      'email domain',
  ip:                'IP address',
  subnet:            'network block',
  asn:               'network operator',
  network_class:     'network type',
  bank_account:      'payout account',
  practice:          'practice',
  practice_group:    'brand',
  provider:          'provider',
  customer_merchant: 'customer/practice pair',
  account:           'account',
};

export function describeReason(reason: Record<string, unknown>): string {
  const rule = String(reason.rule ?? '');

  if (rule === 'kill_switch') return `The "${reason.switch}" kill switch is engaged.`;
  if (rule === 'budget')      return `The daily "${reason.budget}" budget is exhausted (${reason.observed} of ${reason.threshold}).`;
  if (rule === 'block')       return `A standing block applies: ${reason.reason ?? 'no reason recorded'}.`;
  if (rule === 'dependency_unavailable') return 'The risk controls could not be reached, so the request was refused.';
  if (rule === 'circuit_breaker') return `The practice circuit breaker tripped: ${reason.reason ?? 'no reason recorded'}.`;

  const noun = DIMENSION_NOUN[rule] ?? rule;
  const when = windowLabel(reason.window_secs);

  if (reason.metric === 'accounts') {
    return `The same ${noun} has been used by ${reason.observed} accounts in ${when} (limit ${reason.threshold}).`;
  }
  return `This ${noun} was seen ${reason.observed} times in ${when} (limit ${reason.threshold}).`;
}

export function RiskReviewRow(props: {
  reviewId: string;
  event: string;
  state: string;
  score: number;
  hitCount: number;
  openedAt: string;
  lastHitAt: string;
  reasons: Array<Record<string, unknown>>;
  subjectHref: string | null;
  subjectLabel: string;
}) {
  const [isPending, start] = useTransition();
  const pending = usePendingAction({ pending: isPending });
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [decided, setDecided] = useState<string | null>(null);

  function decide(state: 'in_review' | 'cleared' | 'rejected') {
    setError(null);
    setDecided(state);
    start(async () => {
      const result = await decideReview({ reviewId: props.reviewId, state, notes });
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold text-gray-900">
            {props.event.replace(/_/g, ' ')}
            {props.state === 'in_review' && (
              <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800">
                being reviewed
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500">
            {props.subjectLabel}
            {props.subjectHref && (
              <>
                {' — '}
                <Link href={props.subjectHref} className="underline">
                  open record
                </Link>
              </>
            )}
            {' · opened '}{props.openedAt}
            {props.hitCount > 1 && ` · hit ${props.hitCount} times, last ${props.lastHitAt}`}
          </p>
        </div>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
          score {props.score}
        </span>
      </div>

      <ul className="mt-3 space-y-1 text-sm text-gray-700">
        {props.reasons.map((reason, i) => (
          <li key={i}>• {describeReason(reason)}</li>
        ))}
      </ul>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-gray-600">
          Notes (kept on the review; visible to other admins)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
          placeholder="What did you check, and what did you find?"
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending.disabled || props.state === 'in_review'}
          onClick={() => decide('in_review')}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 disabled:opacity-50"
        >
          {pending.showLabel && decided === 'in_review' ? 'Claiming…' : "I'm looking at this"}
        </button>
        <button
          type="button"
          disabled={pending.disabled}
          onClick={() => decide('cleared')}
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending.showLabel && decided === 'cleared' ? 'Clearing…' : 'Clear — let them through'}
        </button>
        <button
          type="button"
          disabled={pending.disabled}
          onClick={() => decide('rejected')}
          className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending.showLabel && decided === 'rejected' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

export function KillSwitchRow(props: {
  name: string;
  engaged: boolean;
  reason: string | null;
  changedAt: string;
}) {
  const [isPending, start] = useTransition();
  const pending = usePendingAction({ pending: isPending });
  const [error, setError] = useState<string | null>(null);
  // Engaging one of these stops customers transacting, and the two-step is
  // the point: it is one click to release a switch and two to engage one,
  // because the expensive mistake is only in that direction.
  const [confirming, setConfirming] = useState(false);

  function flip(engaged: boolean) {
    setError(null);
    start(async () => {
      const result = await toggleKillSwitch({ name: props.name as RiskKillSwitch, engaged });
      if (result.error) setError(result.error);
      setConfirming(false);
    });
  }

  return (
    <div
      className={`rounded-lg border p-4 ${
        props.engaged ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'
      }`}
    >
      <p className="text-sm font-semibold text-gray-900">{props.name.replace(/_/g, ' ')}</p>
      {props.reason && <p className="mt-1 text-xs text-gray-600">{props.reason}</p>}
      <p className="mt-1 text-xs text-gray-500">
        {props.engaged ? 'Engaged' : 'Not engaged'} · last changed {props.changedAt}
      </p>

      <div className="mt-3">
        {props.engaged ? (
          <button
            type="button"
            disabled={pending.disabled}
            onClick={() => flip(false)}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending.showLabel ? 'Releasing…' : 'Release'}
          </button>
        ) : confirming ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending.disabled}
              onClick={() => flip(true)}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending.showLabel ? 'Stopping…' : 'Yes, stop this now'}
            </button>
            <button
              type="button"
              disabled={pending.disabled}
              onClick={() => setConfirming(false)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending.disabled}
            onClick={() => setConfirming(true)}
            className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 disabled:opacity-50"
          >
            Engage
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
