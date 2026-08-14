'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatRand } from '@/app/practice/billHelpers';
import type {
  TillActivity,
  TillSessionRow,
  TillSessionOutcome,
} from '@/lib/practice/tillActivity';

// ─── "Today at this till" ────────────────────────────────────────────────────
//
// WHAT IT IS FOR
// ──────────────
// A receptionist is supposed to live in the till and never need the practice
// dashboard. The gap in that promise was small and constant: this screen shows
// ONE session and "Start next patient" discards it, so the most common question
// at a front desk — "did that bill go through?" — sent them to a screen they are
// not logged into. This strip answers it in one glance.
//
// It is read while somebody waits, sometimes on the phone. So STATUS is the
// thing being scanned for, and status is what the layout leads with on each row.
//
// WHY IT SURVIVES "START NEXT PATIENT"
// ────────────────────────────────────
// Because it is not session state and it is not inside the form that holds
// session state. TillShell mounts this as a SIBLING of CounterSessionForm, so
// handleStartNext — which clears that form's `issued`, `stage`, `qrDataUrl` and
// friends — has no reach into it at all. Surviving the reset is therefore
// structural rather than something this component has to remember to do; a test
// pins the sibling relationship for exactly that reason.
//
// WHY IT DOES NOT POLL — AND THIS IS NOT LAZINESS
// ───────────────────────────────────────────────
// The obvious design is a background poll, and CounterSessionForm already polls
// (STAGE_POLL_MS = 3s) so the pattern exists. It cannot be used here, and the
// reason is a security control:
//
//   requireUnlockedDevice — the guard every till action including this one goes
//   through — WRITES last_activity_at = now() on every successful call, and the
//   till re-locks after TILL_IDLE_TIMEOUT_MS without activity. A strip polling
//   in the background would stamp that column forever, so an unattended till at
//   a front desk would never lock again.
//
// CounterSessionForm's poll is safe because it is bounded: it only runs while a
// session is issued, and stops at the first terminal stage. A strip poll would
// be unbounded — the screen is open all day.
//
// So: fetch once on mount, and give the teller an explicit Refresh. That is also
// what the use case actually wants — the question arrives from a person, and a
// person is a trigger. The bill they are asking about was issued minutes ago and
// is already in the list; one tap covers the rest.
//
// The alternative would be a read-only variant of requireUnlockedDevice that
// does not touch last_activity_at. That is a change to till device auth, which
// this piece is not permitted to make, and it is the right way to add polling
// later if it is ever wanted.
//
// NO FORMATTING OF ITS OWN
// ────────────────────────
// Money goes through ../billHelpers formatRand — not the local copy sitting in
// CounterSessionForm, which is a duplicate of it. There are no dates or times
// rendered at all: the codebase has no shared time-of-day formatter, "today" is
// already the frame, and recency is carried by the ordering. Inventing an
// HH:MM formatter here is exactly the SAST-instant-in-host-timezone mistake
// lib/payments/payoutWindow exists to prevent.

// ── The words ───────────────────────────────────────────────────────────────
//
// Colour is never the only signal — every chip carries a distinct WORD, the same
// rule the payout status chips follow, so a reader who cannot separate green from
// amber still gets the answer.
//
// 'done' is labelled "Paid" because that is what the patient did and what this
// screen already says about the same stage ("Payment received" on the QR panel).
// Two words for one state on one screen is how a receptionist ends up unsure
// whether they mean the same thing.
const OUTCOME_CHIP: Record<TillSessionOutcome, { label: string; cls: string }> = {
  done:    { label: 'Paid',              cls: 'bg-green-100 text-green-700' },
  pending: { label: 'Waiting on patient', cls: 'bg-amber-100 text-amber-800' },
  stopped: { label: 'Not completed',      cls: 'bg-gray-100 text-gray-600'  },
};

/**
 * The precise reason a stopped session stopped.
 *
 * One bucket for colour, two words for the detail — because "did it go through?"
 * has the same answer either way, but "what happened?" does not.
 *
 * All three are reachable. 'expired' is abandonment (the timeout or the
 * teller's "Start next patient") via expire_stale_checkout_session;
 * 'declined' is the patient's own refusal; 'payment_failed' is a rejected
 * first charge. The last two are propagated by
 * lib/checkout/declineCheckoutSessions.ts.
 *
 * These three exist as separate words because they need three DIFFERENT things
 * from the person reading them:
 *
 *   expired         issue it again — nothing was refused, the QR just ran out.
 *   payment_failed  try another card. This is the common one, and it is why
 *                   "Card didn’t go through" says CARD: it names the thing to
 *                   act on, and it puts the failure on the payment rather than
 *                   on the patient or on the practice. It deliberately echoes
 *                   the patient's own screen, which says "Payment didn't go
 *                   through" — one event should not have two vocabularies
 *                   across the counter from each other.
 *   declined        do NOT retry. "Patient declined" rather than a bare
 *                   "Declined", because at a till an unqualified "Declined"
 *                   reads as the card being declined — that is what the word
 *                   means on every card machine in the country — which is the
 *                   exact opposite action. It also names who acted, so nothing
 *                   here reads as a fault at the practice's end.
 */
const STOPPED_DETAIL: Record<string, string> = {
  expired:        'Didn’t finish in time',
  declined:       'Patient declined',
  payment_failed: 'Card didn’t go through',
};

type Props = {
  /** Injected by TillShell, which owns the device secret. */
  getTodaysCounterSessions: () => Promise<{ error: string | null; activity?: TillActivity }>;
};

export default function TodayActivityStrip({ getTodaysCounterSessions }: Props) {
  const [activity, setActivity] = useState<TillActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getTodaysCounterSessions();
    setLoading(false);
    if (result.error || !result.activity) {
      setError(result.error ?? 'Could not load today’s activity.');
      return;
    }
    setError(null);
    setActivity(result.activity);
  }, [getTodaysCounterSessions]);

  useEffect(() => { load(); }, [load]);

  return (
    <section
      aria-labelledby="till-today-heading"
      data-testid="till-today-strip"
      className="mt-8 rounded-2xl border border-gray-200 bg-white"
    >
      <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
        <div>
          <h2 id="till-today-heading" className="text-sm font-semibold text-gray-900">
            Today at this till
          </h2>
          {activity && activity.sessions.length > 0 && (
            <p className="text-xs text-gray-500 mt-0.5" data-testid="till-today-summary">
              {activity.doneCount} paid · {activity.pendingCount} waiting ·{' '}
              {activity.stoppedCount} not completed
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          data-testid="till-today-refresh"
          className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60"
        >
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </header>

      {error ? (
        <p role="alert" className="px-5 py-6 text-sm text-red-800" data-testid="till-today-error">
          {error}
        </p>
      ) : !activity ? (
        // First load only. Deliberately not a spinner that replaces the whole
        // strip on every Refresh — a list that vanishes while it reloads is a
        // list the reader has to wait for twice.
        <p className="px-5 py-6 text-sm text-gray-400" data-testid="till-today-loading">
          Checking today’s activity…
        </p>
      ) : activity.sessions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <ul className="divide-y divide-gray-100" data-testid="till-today-list">
            {activity.sessions.map((s) => <Row key={s.sessionId} session={s} />)}
          </ul>
          {activity.truncated && (
            <p className="border-t border-gray-100 px-5 py-2 text-xs text-gray-500" data-testid="till-today-truncated">
              Showing the {activity.sessions.length} most recent. Earlier ones today
              are on the practice dashboard.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Row({ session }: { session: TillSessionRow }) {
  const chip   = OUTCOME_CHIP[session.outcome];
  const detail = session.outcome === 'stopped' ? STOPPED_DETAIL[session.stage] : null;

  return (
    <li
      data-testid={`till-today-row-${session.sessionId}`}
      data-outcome={session.outcome}
      data-stage={session.stage}
      className="flex items-center justify-between gap-3 px-5 py-3"
    >
      <div className="min-w-0">
        {/* "Thabo M." at most — the payoutPatientLabel rule. A till screen is
            read by whoever is next in the queue, so it prints no more of a
            patient's name than the payouts tab does. An unresolved session has
            no patient at all and shows its invoice number instead. */}
        <p className="text-sm font-medium text-gray-900 truncate" data-testid={`till-today-label-${session.sessionId}`}>
          {session.label}
        </p>
        {session.invoiceNumber && !session.labelIsInvoice && (
          <p className="text-[11px] font-mono text-gray-500">{session.invoiceNumber}</p>
        )}
        {detail && (
          <p className="text-[11px] text-gray-500" data-testid={`till-today-detail-${session.sessionId}`}>
            {detail}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-semibold tabular-nums text-gray-900" data-testid={`till-today-amount-${session.sessionId}`}>
          {session.amount != null ? formatRand(session.amount) : '—'}
        </span>
        <span
          data-testid={`till-today-chip-${session.sessionId}`}
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${chip.cls}`}
        >
          {chip.label}
        </span>
      </div>
    </li>
  );
}

// Not "R0.00" and not a bare panel: a quiet morning is a real state, and a strip
// that renders as an empty box reads as broken to someone who has just been
// asked a question.
function EmptyState() {
  return (
    <p className="px-5 py-6 text-sm text-gray-500" data-testid="till-today-empty">
      No bills issued at this till yet today. Ones you issue will appear here, so
      you can check them without leaving this screen.
    </p>
  );
}
