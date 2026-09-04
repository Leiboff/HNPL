'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { recordAdminAction } from '@/app/admin/_lib/adminAudit';
import { requireAAL2 } from '@/lib/auth/aal';
import { evaluateRisk, mayProceed } from '@/lib/risk/evaluate';
import { resolvePayoutBanking } from '@/lib/practice/banking';

// ─── The payout risk gate (audit 2026-09-03, S-07) ──────────────────────────
//
// The last point at which money can be held. Everything earlier in the loss
// chain is recoverable in principle — a plan can be cancelled, a card charge
// reversed. Once the EFT leaves, the ring has been paid and the remaining
// instalments are never going to arrive.
//
// So this gate asks a different question from the ones above it. Not "is this
// admin allowed to settle" (guardAdmin and requireAAL2 answer that, and both
// are correct) but "is this merchant one we should still be paying". The
// distinction matters because both answers can be yes and no at the same
// time: an entirely legitimate admin settling an entirely valid batch for a
// practice whose first-payment rate collapsed on Tuesday.
//
// It reads a tripped circuit breaker (a standing block on the practice
// dimension, written by trip_practice_circuit_breaker) and the daily
// platform payout ceiling, and refuses on either. Refusal here is a HOLD, not
// a cancellation: nothing is written, the batch stays pending, and it settles
// normally once a reviewer clears it.
async function payoutRiskRefusal(
  supabase: Parameters<typeof resolvePayoutBanking>[0],
  practiceId: string,
  amount: number,
): Promise<string | null> {
  const banking = await resolvePayoutBanking(supabase, practiceId);
  const decision = await evaluateRisk({
    event:       'payout_release',
    practiceId,
    bankAccount: banking.source === 'none' ? null : banking.banking.bank_account_number,
    amount,
    // An admin's own browser is not a signal about the merchant, and
    // clustering every practice an admin settles onto one device token would
    // make the duplicate-device rule fire on the admin.
    skipDevice:  true,
  });
  if (mayProceed(decision)) return null;
  return decision.reviewId
    ? 'This practice is held for review — payouts are paused until it is cleared. See the risk queue.'
    : decision.refusalMessage;
}

// ─── Settlement actions ─────────────────────────────────────────────────────
//
// Marking paid is a BOOKKEEPING FLIP. We initiate the actual payout via
// banking/EFT outside the app; nothing here talks to a bank. Server-side
// admin auth throughout; the UI only triggers, never decides.
//
// Settlement is now BATCH-first (migration 0090). A practice reconciles one
// weekly bank deposit against one batch, so the unit an admin settles has to
// be the batch — flipping half a batch's plans would produce a figure the
// practice cannot check against their statement.
//
// markPayoutPaid survives for exactly one case: a payout that is not in any
// batch. Those are rows activated since the last weekly close (they will be
// batched on the next one) and legacy rows from before batching existed. It
// now REFUSES a batched row, so a payout inside a batch can only be settled
// through its batch and the two can never disagree.

async function guardAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.', supabase: null, userId: null };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.', supabase: null, userId: null };
  return { ok: true as const, error: null, supabase, userId: user.id };
}

// ─── markBatchPaid ──────────────────────────────────────────────────────────
//
// Flips a whole weekly batch and every payout inside it. Ordering matters:
// the member payouts are flipped FIRST, then the batch. If the process dies
// between the two, the batch still reads 'pending' and a retry completes it —
// whereas flipping the batch first would leave a 'paid' batch full of
// 'pending' payouts, which reads as money owed twice.
//
// Both writes are conditional on 'pending', so a double-click or a concurrent
// admin cannot double-flip or move paid_at a second time.

export async function markBatchPaid(batchId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // AAL2 (CRITICAL tier) — payout settlement moves money and is
  // irreversible, so a factor presented within 5 minutes is required, not
  // merely an aal2 session from earlier in the day.
  const aal = await requireAAL2('critical');
  if (!aal.ok) return { error: aal.error };

  const { data: batch } = await guard.supabase!
    .from('payout_batches')
    .select('id, status, practice_id, total_net')
    .eq('id', batchId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!batch) return { error: 'Batch not found or already paid.' };

  // Held BEFORE the audit row and before either write. A settlement that is
  // recorded as intended and then refused would leave the trail claiming an
  // EFT was asserted when it was not.
  const held = await payoutRiskRefusal(
    guard.supabase!,
    batch.practice_id as string,
    Number(batch.total_net ?? 0),
  );
  if (held) return { error: held };

  const paidAt = new Date().toISOString();

  // ── Recorded BEFORE the flip (audit A-12) ────────────────────────────
  //
  // "Marked paid" is a human ASSERTION that an EFT left the bank — nothing
  // here talks to a bank, so this row is the only evidence the payment was
  // ever claimed to have happened, and it used to be evidence with no
  // signature on it.
  //
  // Written first because this action makes TWO writes (members, then the
  // batch) and can die between them. A record written only on success would
  // be missing precisely the half-finished settlements an investigator needs
  // to see. Migration 0131's triggers then record whichever writes actually
  // committed, so the pair reads as intent-then-outcome.
  await recordAdminAction({
    actorId:    guard.userId!,
    entityType: 'payout_batch',
    entityId:   batchId,
    action:     'mark_batch_paid',
    payload:    { from: 'pending', to: 'paid', paid_at: paidAt },
  });

  const { error: payoutsErr } = await guard.supabase!
    .from('payouts')
    .update({ status: 'paid', paid_at: paidAt })
    .eq('batch_id', batchId)
    .eq('status', 'pending');
  if (payoutsErr) return { error: payoutsErr.message };

  const { error: batchErr } = await guard.supabase!
    .from('payout_batches')
    .update({ status: 'paid', paid_at: paidAt })
    .eq('id', batchId)
    .eq('status', 'pending');
  if (batchErr) return { error: batchErr.message };

  revalidatePath('/admin/payouts');
  return { error: null };
}

// ─── markPayoutPaid ─────────────────────────────────────────────────────────
//
// Single unbatched payout. See the note at the top of this file for why a
// BATCHED row is refused rather than settled here.

export async function markPayoutPaid(payoutId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // AAL2 (CRITICAL tier) — payout settlement. See markBatchPaid.
  const aal = await requireAAL2('critical');
  if (!aal.ok) return { error: aal.error };

  const { data: payout } = await guard.supabase!
    .from('payouts')
    .select('id, status, batch_id, practice_id, net_amount')
    .eq('id', payoutId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!payout) return { error: 'Payout not found or not pending.' };

  if (payout.batch_id) {
    return {
      error: 'This payout belongs to a weekly batch — settle the batch instead, ' +
             'so the practice can reconcile the full deposit.',
    };
  }

  // The same gate as the batch path. An unbatched payout is the smaller
  // door into the same room, and leaving it ungated would make the control
  // trivially avoidable by settling rows one at a time.
  const heldPayout = await payoutRiskRefusal(
    guard.supabase!,
    payout.practice_id as string,
    Number(payout.net_amount ?? 0),
  );
  if (heldPayout) return { error: heldPayout };

  const paidAt = new Date().toISOString();

  await recordAdminAction({
    actorId:    guard.userId!,
    entityType: 'payout',
    entityId:   payoutId,
    action:     'mark_payout_paid',
    payload:    { from: 'pending', to: 'paid', paid_at: paidAt, batched: false },
  });

  const { error } = await guard.supabase!
    .from('payouts')
    .update({ status: 'paid', paid_at: paidAt })
    .eq('id', payoutId)
    // Re-assert both conditions at write time: the read above is a separate
    // statement, so a batch could have claimed this row in between.
    .eq('status', 'pending')
    .is('batch_id', null);

  if (error) return { error: error.message };

  revalidatePath('/admin/payouts');
  return { error: null };
}
