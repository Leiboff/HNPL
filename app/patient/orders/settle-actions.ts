'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { attemptChargeInstalment } from '@/lib/payments/chargeInstalment';

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
