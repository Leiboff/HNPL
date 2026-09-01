import { calculateFee } from '@/lib/finance';
import crypto from 'node:crypto';

// ─── Shared first-instalment activation ─────────────────────────────
//
// The single terminal write for a successful instalment-1 charge:
//   1. payments row  → status='collected', collected_at=now
//   2. plans row     → status='active'
//   3. payouts row   → inserted, ALWAYS payout_destination='practice'
//                      (one practice = one bank account = one deposit;
//                      see the note at the insert for why the old
//                      provider-destination branch was removed)
//
// This is also the moment a plan ACTIVATES, which makes payouts.created_at
// the activation timestamp the weekly payout runner batches on — see
// lib/payments/runPayoutBatches.ts. Nothing else may create payouts rows;
// payouts.plan_id is UNIQUE (0087) and this helper is its only creator.
//
// Called from TWO places, both idempotent by design:
//
//   • payWithSavedCard (app/patient/actions.ts) — the SYNCHRONOUS
//     Peach MIT response is authoritative for status='success', per
//     the contract in lib/payments/provider.ts. Without this write
//     the plan sat on 'pending_first_payment' forever while the money
//     had actually moved (the exact stuck state seen in prod on
//     plan 8f80d0df… on 2026-07-22).
//
//   • Peach webhook (app/api/payments/peach/webhook/route.ts) —
//     bonus reconciliation. If the sync write above fails or the
//     process dies mid-flight, the webhook still lands and this
//     helper runs again. Every write is precondition-guarded so
//     duplicate delivery is a no-op.
//
// The two callers pass DIFFERENT supabase clients (service-role in
// the webhook; service-role obtained via createServiceClient in
// payWithSavedCard). The RLS-vs-service question is deliberately
// resolved at the CALLER — this helper doesn't know or care.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

export type ActivateFirstInstalmentInput = {
  paymentId:   string;
  plan: {
    id:            string;
    total_amount:  unknown;
    practice_id:   unknown;
    /** The treating practitioner's MEMBERSHIP row (0094). */
    provider_member_id?: string | null;
    patient_id?:   string | null;
  };
  now?: string;
};

export type ActivateFirstInstalmentResult =
  | { ok: true }
  | { ok: false; step: 'payment' | 'plan' | 'payout'; error: string };

export async function activateFirstInstalment(
  supabase: SvcClient,
  input:    ActivateFirstInstalmentInput,
): Promise<ActivateFirstInstalmentResult> {
  const now = input.now ?? new Date().toISOString();
  const { paymentId, plan } = input;

  // ── 1. Payment row → collected. Precondition: NOT already collected.
  // Guarding by status !=  'collected' makes concurrent duplicate
  // deliveries a no-op instead of double-stamping collected_at.
  const { error: pmtErr } = await supabase
    .from('payments')
    .update({ status: 'collected', collected_at: now })
    .eq('id', paymentId)
    .neq('status', 'collected');
  if (pmtErr) {
    return { ok: false, step: 'payment', error: pmtErr.message };
  }

  // ── 2. Plan row → active. Precondition: still pending_first_payment.
  // If the webhook lands second, this update is a no-op.
  const { error: planErr } = await supabase
    .from('plans')
    .update({ status: 'active' })
    .eq('id', plan.id)
    .eq('status', 'pending_first_payment');
  if (planErr) {
    return { ok: false, step: 'plan', error: planErr.message };
  }

  // ── 2b. Close whatever token opened this plan ──
  //
  // Deliberately HERE — after the plan is active, and before the payout
  // fast-path below, which returns early when a payout already exists.
  //
  // Putting it at the end of the function looked tidier and was wrong: the
  // fast-path return meant only the FIRST caller to reach the payout block
  // ever closed the token, so if that call's close failed (it is non-fatal
  // and only logs), no later call would retry it — and the window this
  // exists to shut would stay open with an ALERT line as the only trace.
  //
  // Every invocation now attempts it. Both writes are precondition-guarded,
  // so the ordinary case — a second caller arriving after the first already
  // closed everything — is a zero-row no-op.
  await closeCheckoutTokensForPlan(supabase, plan.id);

  // ── 3. Payout — one row per plan. Three independent callers can each
  // reach this point for the SAME plan (anon checkout return, portal
  // payment-complete return, Peach webhook) — only the webhook guards
  // itself against re-entry via plans.status; the other two call this
  // helper unconditionally. The existence check below is a fast-path
  // (skip the fee lookup + calc when we already know a payout exists)
  // but is NOT the correctness guarantee — two calls' SELECTs can both
  // land before either INSERT commits. The authoritative guarantee is
  // the DB-level UNIQUE constraint on payouts.plan_id (migration 0087)
  // combined with the upsert below: the losing write is rejected by the
  // constraint and ignoreDuplicates turns that rejection into a benign
  // no-op instead of an error.
  const { data: existingPayouts } = await supabase
    .from('payouts')
    .select('id')
    .eq('plan_id', plan.id)
    .limit(1);
  if (existingPayouts && existingPayouts.length > 0) {
    return { ok: true };
  }

  const { data: practice } = await supabase
    .from('practices')
    .select('fee_percent')
    .eq('id', plan.practice_id as string)
    .single();

  const feePercent = Number(practice?.fee_percent ?? 6);
  const { gross, fee, net } = calculateFee(Number(plan.total_amount), feePercent);

  const payoutRow: Record<string, unknown> = {
    id:                 crypto.randomUUID(),
    practice_id:        plan.practice_id as string,
    plan_id:            plan.id,
    gross_amount:       gross,
    fee_amount:         fee,
    net_amount:         net,
    status:             'pending',
    payout_destination: 'practice',
  };

  // payouts.provider_id is still recorded where it can be, but it is NO LONGER
  // the attribution of record: since 0094 that lives on
  // plans.provider_member_id, which is what the practice dashboard, the brand
  // by-doctor rollup and /provider all read. It never influenced WHERE the
  // money goes, and now it does not carry the attribution either — see the
  // block below the payout row for why it is still populated at all.
  //
  // ── payout_destination is always 'practice' ─────────────────────────
  //
  // This used to branch: if the doctor's practice_members row elected
  // payout_destination='provider', the payout was redirected to their
  // personal account and their bank details were snapshotted onto the
  // payout row. That option is removed — decided as part of the payout
  // runner: ONE PRACTICE = ONE BANK ACCOUNT = ONE DEPOSIT.
  //
  // Two reasons it had to go, both structural rather than cosmetic:
  //   • Weekly batching groups a practice's payouts into a single bank
  //     deposit (migration 0090). A provider-destined row inside that
  //     batch would silently mean two transfers for one batch total,
  //     which is exactly the unreconcilable figure batching exists to
  //     prevent.
  //   • payout_destination and the five personal_bank_* columns live PER
  //     MEMBERSHIP, so one doctor working at two branches could carry two
  //     different destinations with nothing noticing.
  //
  // The columns and both CHECK constraints stay in place on purpose —
  // historical payouts rows written under the old rule must remain
  // reconcilable, so nothing is dropped and 'provider' remains a legal
  // value for those rows. Nothing WRITES it any more.
  // WHY THIS RESOLVES THROUGH THE MEMBERSHIP NOW
  //
  // 0094 moved plan attribution from plans.provider_id (an auth user) to
  // plans.provider_member_id (a practice_members row), so that a roster-only
  // practitioner with no login can be billed for.
  //
  // payouts.provider_id still REFERENCES profiles(id), and that is left
  // exactly as it is — this migration deliberately does not touch the payouts
  // schema, its policies, or the fee/net calculation. So the value written here
  // is the membership's user_id when it has one, and NULL when it does not.
  //
  // A roster-only practitioner's payout therefore carries no provider_id. That
  // is correct rather than lossy: the attribution of record now lives on the
  // PLAN, which every attribution consumer (practice dashboard, brand
  // by-doctor rollup, /provider) reads since 0094. payouts.provider_id is only
  // still populated for the one policy that keys on it (provider_select_own_
  // payouts, 0022), and a practitioner without a login cannot sign in to
  // exercise it in the first place.
  if (plan.provider_member_id) {
    const { data: member } = await supabase
      .from('practice_members')
      .select('user_id')
      .eq('id', plan.provider_member_id)
      .maybeSingle();
    if (member?.user_id) payoutRow.provider_id = member.user_id;
  }

  // upsert + ignoreDuplicates → INSERT ... ON CONFLICT (plan_id) DO
  // NOTHING. If a concurrent caller already won the insert, this is a
  // silent no-op (error is null) rather than a unique-violation error —
  // exactly the idempotent behaviour a second/third caller needs.
  const { error: payoutErr } = await supabase
    .from('payouts')
    .upsert(payoutRow, { onConflict: 'plan_id', ignoreDuplicates: true });
  if (payoutErr) {
    return { ok: false, step: 'payout', error: payoutErr.message };
  }

  return { ok: true };
}

// ─── 4. Close whatever token opened this plan ───────────────────────────
//
// THE DEFECT THIS CLOSES (audit 2026-09-01, F-06)
//
// Stamping patient_invitations.accepted_at and advancing the POS session
// to 'completed' used to happen ONLY on the browser return pages
// (app/checkout/[token]/complete and app/patient/payment-complete). The
// webhook — the other, equally normal way a plan activates — did neither.
//
// So every time the webhook won the activation race, which is every time
// the patient closed the tab, lost signal or pressed back after the card
// cleared, the plan went live and the token stayed OPEN for the rest of
// its seven-day TTL. Re-opening that link re-entered initiateCheckout,
// which deleted the collected instalment and rewrote the schedule; letting
// the next card decline then cancelled a plan whose 94% payout had already
// been created and could not be reversed.
//
// initiateCheckout now refuses those plan states outright, so this is the
// second of two independent fixes rather than the only one. It is worth
// having both: the guard stops the exploit, and this stops the situation
// the exploit needed. It also fixes a plain reliability bug that was
// sitting in the same place — a webhook-activated till bill left its
// counter session reading "Waiting on patient" forever, which is the third
// time that particular freeze has had to be fixed.
//
// Non-fatal by construction: every failure is caught and logged, so this
// can never throw out into the ledger writes around it. That is what lets
// it sit before the payout fast-path (see the call site) rather than at the
// end of the function where it would only ever run once.
//
// Both writes are precondition-guarded, so the ordinary case — the browser
// page got here first — is a zero-row no-op rather than a double write.
async function closeCheckoutTokensForPlan(supabase: SvcClient, planId: string): Promise<void> {
  try {
    const { error: inviteErr } = await supabase
      .from('patient_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('plan_id', planId)
      .is('accepted_at', null);
    if (inviteErr) {
      console.error('[activateFirstInstalment] ALERT could not close the invitation for an activated plan', {
        planId, error: inviteErr.message,
        note: 'the plan IS active; its checkout link may still resolve until it expires',
      });
    }

    const { error: sessionErr } = await supabase
      .from('checkout_sessions')
      .update({ stage: 'completed' })
      .eq('plan_id', planId)
      .neq('stage', 'completed');
    if (sessionErr) {
      console.error('[activateFirstInstalment] ALERT could not close the counter session for an activated plan', {
        planId, error: sessionErr.message,
        note: 'the plan IS active; the till strip may still show this session as waiting',
      });
    }
  } catch (err) {
    console.error('[activateFirstInstalment] ALERT token close threw (non-fatal)', {
      planId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
