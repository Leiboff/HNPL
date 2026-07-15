'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { attemptChargeInstalment } from '@/lib/payments/chargeInstalment';
import { getPaymentProvider } from '@/lib/payments/provider';

// ─── Patient-initiated "Pay now" — self-settle a past-due instalment ──
//
// Funnels through the SAME atomic claim primitive as the cron
// (attemptChargeInstalment with selfSettle:true). That is the single
// most important correctness property: a concurrent cron attempt + a
// patient tap on Pay now both call the same UPDATE-with-WHERE-status
// claim, so exactly ONE charge ever fires — whichever UPDATE wins.
//
// Authorization order:
//   1. Session client → require an authenticated user.
//   2. Session client → fetch the payment row by id; RLS scopes to
//      "rows owned by the caller" (payments_select policy). Ownership
//      is therefore enforced by the DB, not the app code.
//   3. The settleable-status whitelist guards against UI bugs that
//      try to settle a 'processing' or 'collected' row.
//   4. Service-role client → attemptChargeInstalment(selfSettle:true)
//      does the atomic claim + Paystack call. Service-role bypasses
//      RLS — safe because we've already verified ownership above.
//
// Settleable statuses:
//   • 'scheduled'  — not yet due, but the patient wants to pay early.
//                    Today the brief asks only for past-due rows to
//                    show Pay now; this is conservative and adds an
//                    extra UI gate, not a code gate. Allowing the
//                    underlying action means a future "early settle"
//                    UI doesn't need a parallel charging path.
//   • 'failed'     — in the ladder; cron will retry on next_attempt_date.
//                    Self-settling pre-empts the next attempt.
//   • 'defaulted'  — cap-hit; cron will NOT retry. Self-settle is the
//                    only way back from here besides admin write-off.
//
// Outcomes (mirrored from attemptChargeInstalment):
//   • 'charged'        — Paystack accepted the charge. The webhook
//                        will confirm collected or failed async. UI
//                        should show "processing — we'll confirm
//                        shortly" until the webhook flips status.
//   • 'claim_lost'     — concurrent cron or another tab already
//                        claimed. The earlier attempt is in flight;
//                        the user does not need to retry.
//   • 'transport_err'  — Paystack network error. Surfaces to the user
//                        as "try again in a moment" — the underlying
//                        row is in 'processing' awaiting admin
//                        reconciliation.
//   • 'unauthorized'   — session expired or ownership mismatch.
//   • 'not_settleable' — status outside the whitelist.

export type SelfSettleResult =
  | { ok: true;  status: 'charged'; reference: string; amountChargedCents: number }
  | { ok: false; status: 'unauthorized' }
  | { ok: false; status: 'not_settleable'; currentStatus: string }
  | { ok: false; status: 'not_found' }
  | { ok: false; status: 'claim_lost'; reason: string }
  | { ok: false; status: 'transport_error'; message: string };

const SETTLEABLE_STATUSES = new Set(['scheduled', 'failed', 'defaulted']);

export async function selfSettleInstalment(paymentId: string): Promise<SelfSettleResult> {
  // ── 1. Session — require an authenticated patient.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, status: 'unauthorized' };
  }

  // ── 2. Ownership + settleability. RLS scopes the SELECT to rows the
  //       caller owns; a missing row therefore means "not yours OR not
  //       found", which we collapse into 'not_found' to avoid an
  //       enumeration oracle.
  const { data: payment } = await supabase
    .from('payments')
    .select('id, status, plan_id, patient_id')
    .eq('id', paymentId)
    .maybeSingle();

  if (!payment) {
    return { ok: false, status: 'not_found' };
  }
  if (payment.patient_id !== user.id) {
    // Defence in depth — RLS should already have hidden this.
    return { ok: false, status: 'unauthorized' };
  }
  if (!SETTLEABLE_STATUSES.has(payment.status as string)) {
    return { ok: false, status: 'not_settleable', currentStatus: payment.status as string };
  }

  // ── 3. Service-role client → atomic claim + Paystack charge.
  //       attemptChargeInstalment is shared with the cron — the SAME
  //       UPDATE-with-WHERE-status claim is what serialises the
  //       cron-vs-self-settle race to exactly one winner.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const outcome = await attemptChargeInstalment(svc, paymentId, { selfSettle: true });

  revalidatePath('/patient');
  revalidatePath('/patient/orders');

  if (outcome.kind === 'charged') {
    // Mark the row in plan_events for the audit trail. Best-effort —
    // a failed insert doesn't reverse the charge. The webhook later
    // appends instalment_attempt_succeeded with via_self_settle:true
    // when the actual outcome lands.
    await svc.from('plan_events').insert({
      plan_id:    payment.plan_id,
      patient_id: payment.patient_id,
      event_type: 'instalment_self_settled',
      payload: {
        payment_id:          paymentId,
        reference:           outcome.reference,
        amount_charged_cents: outcome.amountChargedCents,
      },
    });
    return {
      ok: true,
      status: 'charged',
      reference: outcome.reference,
      amountChargedCents: outcome.amountChargedCents,
    };
  }

  if (outcome.kind === 'transport_error') {
    return { ok: false, status: 'transport_error', message: outcome.error };
  }

  // claim_lost — concurrent cron / another tab won the race.
  return { ok: false, status: 'claim_lost', reason: outcome.reason };
}

// ─── Settle entire bill — ONE Paystack charge via the settlement row ──
//
// Plan-level "pay everything outstanding now" using the settlement-row
// model added by migration 0058. The atomic claim_plan_for_settlement
// RPC snapshots every settle-eligible instalment, inserts ONE new
// payment row (kind='settlement') for the summed total, flips every
// eligible instalment to 'processing' in one UPDATE, and reverts
// cleanly if it lost a race against the cron. Then this action fires
// ONE Paystack charge against the settlement row's reference. The
// webhook's existing charge.success handler closes the loop —
// see app/api/webhooks/paystack/route.ts handleChargeSuccess where
// kind='settlement' fans out collected to every covered instalment.
//
// Why one charge, not the per-instalment loop:
//   • One Paystack transaction fee instead of N.
//   • One statement line for the patient instead of N.
//   • Voluntary all-or-nothing is correct semantics — half-settling
//     a voluntary "pay everything" tap is the wrong contract.
//
// Exactly-one-charge against the cron:
//   The atomic UPDATE inside claim_plan_for_settlement is a single
//   statement: "UPDATE payments SET status='processing',
//   settled_by_payment_id=$settlement WHERE id = ANY(...) AND
//   status IN ('scheduled','failed','defaulted')". Postgres takes
//   row-level locks; a concurrent cron attempt on any covered row
//   races at THAT row's lock. Whichever runs first wins it; the
//   other sees status='processing' and matches zero rows for that id.
//   The RPC checks ROW_COUNT == expected; if less, it knows the cron
//   beat it on at least one row, reverts the rows it DID claim back
//   to their snapshotted prior statuses, deletes the settlement row,
//   and returns 'race_lost'. The action then returns race_lost to
//   the patient with a "try again in a moment" message. Net: no
//   instalment is ever in two pending charges.

export type SettleAllOutcome =
  | { ok: true;  status: 'charged'; settlementId: string; amountCents: number; coveredCount: number; reference: string }
  | { ok: false; status: 'unauthorized' }
  | { ok: false; status: 'plan_not_found' }
  | { ok: false; status: 'nothing_to_settle' }
  | { ok: false; status: 'race_lost' }
  | { ok: false; status: 'transport_error'; message: string }
  | { ok: false; status: 'declined'; message: string }
  | { ok: false; status: 'no_registration_id' }
  | { ok: false; status: 'no_email' };

export async function selfSettleEntirePlan(planId: string): Promise<SettleAllOutcome> {
  // ── 1. Session — require an authenticated patient.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, status: 'unauthorized' };
  }

  // ── 2. Atomic multi-row claim + settlement-row insert via the RPC.
  //       The RPC verifies plan ownership against p_patient_id (=auth
  //       user), snapshots every eligible instalment, claims them in
  //       one UPDATE, and inserts the settlement row. On race-loss it
  //       reverts cleanly and returns 'race_lost' — see migration 0058.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const today = new Date().toISOString().slice(0, 10);
  const { data: claim, error: claimErr } = await svc.rpc('claim_plan_for_settlement', {
    p_plan_id:    planId,
    p_patient_id: user.id,
    p_today:      today,
  });

  if (claimErr) {
    console.error('[settle-all] claim_plan_for_settlement RPC failed', claimErr);
    return { ok: false, status: 'transport_error', message: claimErr.message };
  }

  const c = claim as {
    ok: boolean;
    error?: string;
    settlement_id?: string;
    amount_cents?: number;
    covered_count?: number;
  };

  if (!c.ok) {
    switch (c.error) {
      case 'plan_not_found':    return { ok: false, status: 'plan_not_found' };
      case 'nothing_to_settle': return { ok: false, status: 'nothing_to_settle' };
      case 'race_lost':         return { ok: false, status: 'race_lost' };
      default:                  return { ok: false, status: 'unauthorized' };
    }
  }

  const settlementId = c.settlement_id as string;
  const amountCents  = c.amount_cents  as number;
  const coveredCount = c.covered_count as number;

  // ── 3. Plan + patient — needed for the Peach MIT call.
  const { data: plan } = await svc
    .from('plans')
    .select('peach_registration_id, patient_id')
    .eq('id', planId)
    .maybeSingle();
  if (!plan?.peach_registration_id) {
    // No stored card — revert the claim by failing the settlement row.
    // Mirrors the chargeInstalment revert pattern: flip rows back to
    // their snapshot statuses via the RPC's failure path is the right
    // home; here we directly fail-out the settlement row, and the
    // webhook handler's failure path will run the revert.
    await failSettlementRow(svc, settlementId, 'no_registration_id');
    return { ok: false, status: 'no_registration_id' };
  }

  const { data: profile } = await svc
    .from('profiles')
    .select('email')
    .eq('id', plan.patient_id)
    .single();
  if (!profile?.email) {
    await failSettlementRow(svc, settlementId, 'no_email');
    return { ok: false, status: 'no_email' };
  }

  // ── 4. Reference + Peach MIT charge. Reference embeds 'settle' so
  //       the webhook can short-circuit-detect a settlement charge if
  //       needed; routing primarily uses the payment row's kind column.
  const reference = `hnpl_settle_${settlementId.replace(/-/g, '').slice(0, 16)}`;
  await svc.from('payments').update({ peach_payment_id: reference }).eq('id', settlementId);

  await svc.from('plan_events').insert({
    plan_id:    planId,
    patient_id: user.id,
    event_type: 'instalment_self_settled',
    payload: {
      settlement_id:        settlementId,
      reference,
      amount_cents:         amountCents,
      covered_count:        coveredCount,
      via_settle_entire:    true,
    },
  });

  const provider = getPaymentProvider();
  const chargeResult = await provider.chargeSavedCard({
    registrationId:        plan.peach_registration_id,
    amountCents,
    merchantTransactionId: reference,
    currency:              'ZAR',
    standingInstruction: {
      mode:   'REPEATED',
      source: 'MIT',
      type:   'UNSCHEDULED',
    },
  });

  if (chargeResult.status === 'error') {
    // Transport error: the settlement row stays in 'processing'.
    // We do NOT revert here — Peach may still have received the
    // charge; reverting would risk double-charging if a delayed
    // webhook later arrives. Same posture as chargeInstalment's
    // transport_error path. Admin reconciles via the Peach dashboard.
    return {
      ok: false,
      status: 'transport_error',
      message: chargeResult.resultDescription ?? 'transport error',
    };
  }

  if (chargeResult.status === 'rejected') {
    // Immediate provider rejection (card decline, etc.). Same posture
    // as the charge.failed webhook path: revert the settlement row.
    await failSettlementRow(svc, settlementId, chargeResult.resultDescription ?? 'declined');
    return {
      ok: false,
      status: 'declined',
      message: chargeResult.resultDescription ?? 'Card was declined.',
    };
  }

  revalidatePath('/patient');
  revalidatePath('/patient/orders');

  return {
    ok: true,
    status: 'charged',
    settlementId,
    amountCents,
    coveredCount,
    reference,
  };
}

// Revert a settlement row that never made it to Paystack — flips it
// to 'failed' so the webhook's charge.failed handler (or an admin
// sweep) restores the covered instalments to their snapshot statuses.
// Used when post-claim preconditions miss (no card / no email).
async function failSettlementRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  settlementId: string,
  reason: string,
): Promise<void> {
  await svc.from('payments').update({
    status:         'failed',
    failure_reason: reason,
  }).eq('id', settlementId);
}
