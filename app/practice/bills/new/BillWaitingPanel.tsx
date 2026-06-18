'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { RealtimeChannel } from '@supabase/supabase-js';
import {
  deriveBillLifecycleStatus,
  billLifecycleChip,
  type BillLifecycleStatus,
} from '@/lib/bills/lifecycle';
import StepMedallion from '@/app/checkout/[token]/_components/StepMedallion';

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
// Visual rhythm: one confident message per state, anchored by a
// state-coded medallion. The Paid state is the moment that matters —
// big hero amount, calm green halo, single concise confirmation.
// Redundant chip + amount + check have been consolidated.

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

// State-coded card tones. Subtle backgrounds, not loud — this is
// peripheral vision for a busy receptionist; we use the medallion to
// carry the colour signal.
function stateClasses(status: BillLifecycleStatus): {
  card: string;
} {
  switch (status) {
    case 'paid':    return { card: 'bg-[#E7F6EC] border-[#1E9E55]/25' };
    case 'viewed':  return { card: 'bg-[#15A89E]/8 border-[#15A89E]/25' };
    case 'expired': return { card: 'bg-[#EEF1F6] border-[#D8DEE8]' };
    case 'sent':
    default:        return { card: 'bg-[#FAFBFD] border-[#E5E9F0]' };
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

  const tone = stateClasses(lifecycle);

  // ── Paid: the moment that matters ──────────────────────────────────
  // Big confident amount, single green medallion, calm one-line confirm.
  // No redundant chip + tick + amount triple — the medallion + amount
  // together are the confirmation.
  if (lifecycle === 'paid') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={`rounded-[20px] border p-7 sm:p-8 text-center transition-colors duration-300 ${tone.card}`}
      >
        <div className="flex justify-center mb-4">
          <StepMedallion icon="tick" tone="green" />
        </div>
        <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#1E7A45]">Collected</p>
        <p className="mt-2 text-4xl sm:text-5xl font-semibold tabular-nums text-[#0F1F3A]">
          {formatRand(amount)}
        </p>
        <p className="mt-3 text-sm text-[#3A4B66]">
          from <span className="font-medium text-[#0F1F3A]">{patientLabel}</span>
        </p>
      </div>
    );
  }

  // ── Expired ────────────────────────────────────────────────────────
  if (lifecycle === 'expired') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={`rounded-[20px] border p-6 sm:p-7 text-center transition-colors duration-300 ${tone.card}`}
      >
        <div className="flex justify-center mb-4">
          <StepMedallion icon="clock" tone="muted" />
        </div>
        <p className="text-lg font-semibold text-[#0F1F3A]">Link expired</p>
        <p className="mt-1 text-sm text-[#3A4B66]">
          {patientLabel} didn&apos;t pay before the link expired.
        </p>
      </div>
    );
  }

  // ── Waiting / Viewed ───────────────────────────────────────────────
  // Same structure for both — a single soft state-coded medallion, a
  // big-but-not-screaming amount, a calm status line. The medallion's
  // tone carries the difference: amber halo for "Sent / Waiting",
  // teal halo for "Viewed / Paying". Live updates on viewed_at flip
  // the tone without rebuilding the layout (less visual flicker).
  const isViewed = lifecycle === 'viewed';
  const headline = isViewed
    ? 'Patient is paying'
    : 'Waiting for payment';
  const sub = isViewed
    ? `${patientLabel} has opened the link.`
    : `Watching for ${patientLabel}'s payment…`;
  const chip = billLifecycleChip(lifecycle);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-[20px] border p-6 sm:p-7 text-center transition-colors duration-300 ${tone.card}`}
    >
      <div className="flex justify-center mb-4">
        <span className="relative inline-flex">
          <StepMedallion icon="clock" tone={isViewed ? 'teal' : 'amber'} />
          {/* A single soft pulse ring — calm, not flashy. Removed for
              reduced-motion users via the system preference. */}
          <span
            aria-hidden
            className={`absolute inset-0 rounded-full motion-safe:animate-ping ${
              isViewed ? 'bg-[#15A89E]/25' : 'bg-[#C8841C]/25'
            }`}
            style={{ animationDuration: '2.4s' }}
          />
        </span>
      </div>
      <p className="text-lg font-semibold text-[#0F1F3A]">{headline}</p>
      <p className="mt-1 text-sm text-[#3A4B66]">{sub}</p>
      <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-white border border-[#E5E9F0] px-3 py-1">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${isViewed ? 'bg-[#15A89E]' : 'bg-[#C8841C]'}`}
        />
        <span className="text-xs font-medium text-[#3A4B66]" title={chip.hint}>
          {chip.label}
        </span>
        <span className="text-xs text-[#7A8AA0]">·</span>
        <span className="text-xs tabular-nums font-medium text-[#0F1F3A]">{formatRand(amount)}</span>
      </div>
    </div>
  );
}
