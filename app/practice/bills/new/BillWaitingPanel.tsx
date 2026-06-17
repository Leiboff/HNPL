'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { RealtimeChannel } from '@supabase/supabase-js';
import {
  deriveBillLifecycleStatus,
  billLifecycleChip,
  type BillLifecycleStatus,
} from '@/lib/bills/lifecycle';

// ─── BillWaitingPanel ────────────────────────────────────────────────────
//
// The at-the-till "card machine beep" view. The provider has just
// emailed a checkout link to the patient who is standing at reception.
// They need to SEE the payment land before letting the patient go.
//
// What this panel does, in priority order:
//
//   1. SHOW the current lifecycle state — large, glanceable, mobile-
//      first. The receptionist is looking at a tablet/phone propped
//      on the counter.
//   2. SUBSCRIBE via Supabase realtime to two row changes:
//        • plans.id = planId           → status: pending → active = "Paid"
//        • patient_invitations.id      → viewed_at: NULL → ts   = "Viewed"
//      Realtime cannot tell us anything RLS would not let us SELECT —
//      practice members already have SELECT on both via 0002 / 0021 /
//      0035, so this works for any practice user (admin, staff, provider).
//   3. FALL BACK to a slow poll (FALLBACK_POLL_MS) for the case where
//      a realtime event silently drops (network blip, backgrounded
//      tab). Without this, a receptionist staring at "waiting" while
//      the patient has already paid is the exact failure mode the
//      feature is supposed to eliminate.
//   4. CLEAN UP — remove the channel + clear the interval on unmount.
//      Don't leak realtime channels: each one is a websocket frame
//      consumer on the Supabase side.
//
// What this panel does NOT do:
//   • It does NOT change the lifecycle state on the server — it is a
//     read-only observer. The webhook (plans→active) and the
//     /checkout/[token] page (invitations.viewed_at) are the only
//     writers.
//   • It does NOT poll forever. Once the lifecycle reaches "paid" or
//     "expired" the panel stops polling and unsubscribes — there's
//     nothing more to watch.

// Slow safety poll while waiting. Realtime is the primary signal; this
// is the belt-and-braces net for dropped events.
const FALLBACK_POLL_MS = 15_000;

type Props = {
  planId:               string;
  invitationId?:        string;
  patientLabel:         string;
  amount:               number;
  initial: {
    planStatus:           string;
    invitationViewedAt:   string | null;
    invitationAcceptedAt: string | null;
    invitationExpiresAt:  string | null;
  };
};

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

type LiveState = {
  planStatus:           string;
  invitationViewedAt:   string | null;
  invitationAcceptedAt: string | null;
  invitationExpiresAt:  string | null;
};

function statusToneClasses(status: BillLifecycleStatus): {
  card:  string;
  icon:  string;
  pulse: boolean;
} {
  switch (status) {
    case 'paid':
      return { card: 'bg-green-50 border-green-200', icon: 'text-green-600', pulse: false };
    case 'viewed':
      return { card: 'bg-blue-50 border-blue-200', icon: 'text-blue-600', pulse: true };
    case 'expired':
      return { card: 'bg-gray-50 border-gray-200', icon: 'text-gray-400', pulse: false };
    case 'sent':
    default:
      return { card: 'bg-amber-50 border-amber-200', icon: 'text-amber-600', pulse: true };
  }
}

export default function BillWaitingPanel({
  planId,
  invitationId,
  patientLabel,
  amount,
  initial,
}: Props) {
  const [state, setState] = useState<LiveState>(initial);

  const lifecycle = deriveBillLifecycleStatus({
    planStatus:           state.planStatus,
    invitationViewedAt:   state.invitationViewedAt,
    invitationAcceptedAt: state.invitationAcceptedAt,
    invitationExpiresAt:  state.invitationExpiresAt,
  });
  const isTerminal = lifecycle === 'paid' || lifecycle === 'expired';

  useEffect(() => {
    // Stop observing once the lifecycle hits a terminal state — no
    // realtime channel, no poll, nothing further to watch.
    if (isTerminal) return;

    const supabase = createClient();
    let cancelled = false;

    // ── Realtime subscription ─────────────────────────────────────────
    // One channel per panel instance. The plan filter is required; the
    // invitation filter is optional (existing-patient bills have no
    // invitation row to watch).
    const channel: RealtimeChannel = supabase
      .channel(`bill-waiting:${planId}`)
      .on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'plans',
          filter: `id=eq.${planId}`,
        },
        (payload) => {
          const next = payload.new as { status?: string } | null;
          if (!next?.status) return;
          setState((prev) => ({ ...prev, planStatus: next.status as string }));
        },
      );

    if (invitationId) {
      channel.on(
        'postgres_changes',
        {
          event:  'UPDATE',
          schema: 'public',
          table:  'patient_invitations',
          filter: `id=eq.${invitationId}`,
        },
        (payload) => {
          const next = payload.new as {
            viewed_at?:   string | null;
            accepted_at?: string | null;
          } | null;
          if (!next) return;
          setState((prev) => ({
            ...prev,
            invitationViewedAt:   next.viewed_at   ?? prev.invitationViewedAt,
            invitationAcceptedAt: next.accepted_at ?? prev.invitationAcceptedAt,
          }));
        },
      );
    }

    channel.subscribe();

    // ── Fallback safety poll ──────────────────────────────────────────
    // Re-reads the current truth from the DB. The lifecycle helper
    // dedupes by value, so a poll that finds no change is cheap and
    // does not cause a re-render.
    async function poll() {
      if (cancelled) return;
      // Plan status
      const { data: plan } = await supabase
        .from('plans')
        .select('status')
        .eq('id', planId)
        .maybeSingle();
      if (cancelled || !plan) return;

      // Invitation (only if relevant)
      let invitationPatch: Partial<LiveState> = {};
      if (invitationId) {
        const { data: inv } = await supabase
          .from('patient_invitations')
          .select('viewed_at, accepted_at, expires_at')
          .eq('id', invitationId)
          .maybeSingle();
        if (cancelled) return;
        if (inv) {
          invitationPatch = {
            invitationViewedAt:   (inv as { viewed_at?:   string | null }).viewed_at   ?? null,
            invitationAcceptedAt: (inv as { accepted_at?: string | null }).accepted_at ?? null,
            invitationExpiresAt:  (inv as { expires_at?:  string | null }).expires_at  ?? null,
          };
        }
      }

      setState((prev) => {
        const next: LiveState = {
          ...prev,
          planStatus: (plan as { status: string }).status,
          ...invitationPatch,
        };
        // Skip the re-render if nothing changed.
        if (
          next.planStatus           === prev.planStatus &&
          next.invitationViewedAt   === prev.invitationViewedAt &&
          next.invitationAcceptedAt === prev.invitationAcceptedAt &&
          next.invitationExpiresAt  === prev.invitationExpiresAt
        ) {
          return prev;
        }
        return next;
      });
    }

    const intervalId = window.setInterval(poll, FALLBACK_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      supabase.removeChannel(channel);
    };
  }, [planId, invitationId, isTerminal]);

  const chip       = billLifecycleChip(lifecycle);
  const tone       = statusToneClasses(lifecycle);
  const headline   =
    lifecycle === 'paid'    ? '✓ Paid'
    : lifecycle === 'viewed'  ? 'Patient is paying…'
    : lifecycle === 'expired' ? 'Link expired'
    :                           'Waiting for payment…';
  const sub        =
    lifecycle === 'paid'    ? `${formatRand(amount)} collected from ${patientLabel}`
    : lifecycle === 'viewed'  ? `${patientLabel} has opened the link.`
    : lifecycle === 'expired' ? `The bill to ${patientLabel} was not paid.`
    :                           `Watching for ${patientLabel}'s payment…`;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-2xl border p-6 sm:p-8 text-center transition-colors ${tone.card}`}
    >
      <div className={`mx-auto w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center ${tone.icon} bg-white border ${
        lifecycle === 'paid'    ? 'border-green-200' :
        lifecycle === 'viewed'  ? 'border-blue-200'  :
        lifecycle === 'expired' ? 'border-gray-200'  :
                                  'border-amber-200'
      }`}>
        {lifecycle === 'paid' ? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : lifecycle === 'expired' ? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        ) : (
          <svg
            width="28" height="28" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth={2}
            aria-hidden
            className={tone.pulse ? 'animate-pulse' : ''}
          >
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
          </svg>
        )}
      </div>
      <h3 className="mt-4 text-xl sm:text-2xl font-semibold text-gray-900">{headline}</h3>
      <p className="mt-1 text-sm text-gray-600">{sub}</p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <span
          title={chip.hint}
          aria-label={chip.hint}
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${chip.cls}`}
        >
          {chip.label}
        </span>
        <span className="text-xs text-gray-400 tabular-nums">{formatRand(amount)}</span>
      </div>
    </div>
  );
}
