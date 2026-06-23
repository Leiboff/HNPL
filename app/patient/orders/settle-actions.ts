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

// ─── Settle entire bill ────────────────────────────────────────────────
//
// Plan-level "pay everything outstanding now". The implementation
// LOOPS over every non-collected instalment on the plan and routes
// each through the SAME attemptChargeInstalment(selfSettle:true) atomic
// claim used by the single-row self-settle action above.
//
// Option (a) (one Paystack charge for the sum, then mark every row
// collected internally) vs option (b) (loop, N charges, one per row):
//
//   • (a) would require a NEW idempotency / reconciliation primitive —
//     the webhook routes charge.success → payments by peach_payment_id
//     (one reference → one payment row). Mapping one reference to N
//     rows needs either a new settlements table or plan-level
//     metadata, i.e. a schema change. The brief says no migration
//     expected.
//
//   • (b) inherits the per-row atomic claim verbatim. Each instalment
//     is its own claim, its own Paystack reference, its own webhook
//     event. A concurrent cron attempt on any one of those rows
//     resolves at THAT row's atomic UPDATE — exactly one charge per
//     instalment. A double-tap of "Settle entire bill" sees every
//     row already in 'processing' on the second pass and returns
//     claim_lost across the board → no double-charge.
//
// Chose (b). Slight cost: the patient sees N transactions on their
// bank statement instead of one. Benefit: zero new code paths for
// idempotency / reconciliation; partial-success on card-limit hits is
// patient-friendly ("settled 2 of 3; we'll retry the third").

export type SettleAllOutcome =
  | { ok: true;  status: 'settled_all'; results: SettleAllRowResult[]; totalChargedCents: number }
  | { ok: false; status: 'unauthorized' }
  | { ok: false; status: 'plan_not_found' }
  | { ok: false; status: 'nothing_to_settle' };

export type SettleAllRowResult = {
  paymentId:         string;
  instalmentNumber:  number;
  outcome:           'charged' | 'already_in_progress' | 'transport_error' | 'not_eligible';
  amountChargedCents: number;
  message?:          string;
};

const SETTLE_ALL_STATUSES = new Set(['scheduled', 'failed', 'defaulted']);

export async function selfSettleEntirePlan(planId: string): Promise<SettleAllOutcome> {
  // ── 1. Session — require an authenticated patient.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, status: 'unauthorized' };
  }

  // ── 2. Ownership of the plan. RLS scopes plans to the caller, so a
  //       missing row means "not yours or not found".
  const { data: plan } = await supabase
    .from('plans')
    .select('id, patient_id, status')
    .eq('id', planId)
    .maybeSingle();
  if (!plan)                          return { ok: false, status: 'plan_not_found' };
  if (plan.patient_id !== user.id)    return { ok: false, status: 'unauthorized' };

  // ── 3. Outstanding instalments — every row that isn't already
  //       collected and is in the settle-eligible set. RLS scopes to
  //       the caller's payments, so no patient_id filter needed.
  const { data: rawRows } = await supabase
    .from('payments')
    .select('id, status, instalment_number, amount, dunning_fees_cents')
    .eq('plan_id', planId)
    .in('status', Array.from(SETTLE_ALL_STATUSES))
    .order('instalment_number', { ascending: true });

  const rows = (rawRows ?? []) as Array<{
    id: string;
    status: string;
    instalment_number: number;
    amount: number;
    dunning_fees_cents: number | null;
  }>;

  if (rows.length === 0) {
    return { ok: false, status: 'nothing_to_settle' };
  }

  // ── 4. Loop and settle. Each row routes through the shared
  //       attemptChargeInstalment(selfSettle:true). Concurrency is
  //       resolved at each row's atomic UPDATE; this loop is
  //       sequential by design so the patient gets a deterministic
  //       per-row outcome and we don't fan out N simultaneous
  //       Paystack calls (which would burn rate limit).
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const results: SettleAllRowResult[] = [];
  let totalChargedCents = 0;

  for (const row of rows) {
    const outcome = await attemptChargeInstalment(svc, row.id, { selfSettle: true });

    if (outcome.kind === 'charged') {
      // Audit row per instalment — the webhook will append the
      // succeeded event when the actual charge.success lands.
      await svc.from('plan_events').insert({
        plan_id:    planId,
        patient_id: user.id,
        event_type: 'instalment_self_settled',
        payload: {
          payment_id:           row.id,
          instalment_number:    row.instalment_number,
          reference:            outcome.reference,
          amount_charged_cents: outcome.amountChargedCents,
          via_settle_all:       true,
        },
      });
      totalChargedCents += outcome.amountChargedCents;
      results.push({
        paymentId:          row.id,
        instalmentNumber:   row.instalment_number,
        outcome:            'charged',
        amountChargedCents: outcome.amountChargedCents,
      });
    } else if (outcome.kind === 'transport_error') {
      results.push({
        paymentId:          row.id,
        instalmentNumber:   row.instalment_number,
        outcome:            'transport_error',
        amountChargedCents: 0,
        message:            outcome.error,
      });
    } else {
      // claim_lost — typically "already_claimed" (concurrent cron / a
      // double-tap / earlier loop iteration that already changed the
      // row's status). 'already_in_progress' covers the user-facing
      // interpretation of any claim_lost reason here.
      results.push({
        paymentId:          row.id,
        instalmentNumber:   row.instalment_number,
        outcome:            outcome.reason === 'already_claimed'
                              ? 'already_in_progress'
                              : 'not_eligible',
        amountChargedCents: 0,
        message:            outcome.reason,
      });
    }
  }

  revalidatePath('/patient');
  revalidatePath('/patient/orders');

  return { ok: true, status: 'settled_all', results, totalChargedCents };
}
