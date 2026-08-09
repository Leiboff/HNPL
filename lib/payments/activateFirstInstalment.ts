import { calculateFee } from '@/lib/finance';
import crypto from 'node:crypto';

// ─── Shared first-instalment activation ─────────────────────────────
//
// The single terminal write for a successful instalment-1 charge:
//   1. payments row  → status='collected', collected_at=now
//   2. plans row     → status='active'
//   3. payouts row   → inserted (payout_destination = practice, or
//                      provider when the practice_member elected that)
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
    provider_id?:  string | null;
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

  if (plan.provider_id) {
    payoutRow.provider_id = plan.provider_id;
    const { data: member } = await supabase
      .from('practice_members')
      .select('payout_destination, personal_bank_name, personal_account_holder, personal_account_number, personal_branch_code, personal_account_type')
      .eq('user_id', plan.provider_id)
      .eq('practice_id', plan.practice_id as string)
      .maybeSingle();

    if (member?.payout_destination === 'provider') {
      payoutRow.payout_destination      = 'provider';
      payoutRow.snapshot_bank_name      = member.personal_bank_name      ?? null;
      payoutRow.snapshot_account_holder = member.personal_account_holder ?? null;
      payoutRow.snapshot_account_number = member.personal_account_number ?? null;
      payoutRow.snapshot_branch_code    = member.personal_branch_code    ?? null;
      payoutRow.snapshot_account_type   = member.personal_account_type   ?? null;
    }
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
