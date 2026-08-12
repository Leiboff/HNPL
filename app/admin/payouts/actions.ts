'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

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
// batch. Those are rows activated since the last Friday run (they will be
// batched on the next one) and legacy rows from before batching existed. It
// now REFUSES a batched row, so a payout inside a batch can only be settled
// through its batch and the two can never disagree.

async function guardAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.', supabase: null };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.', supabase: null };
  return { ok: true as const, error: null, supabase };
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

  const { data: batch } = await guard.supabase!
    .from('payout_batches')
    .select('id, status')
    .eq('id', batchId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!batch) return { error: 'Batch not found or already paid.' };

  const paidAt = new Date().toISOString();

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

  const { data: payout } = await guard.supabase!
    .from('payouts')
    .select('id, status, batch_id')
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

  const { error } = await guard.supabase!
    .from('payouts')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', payoutId)
    // Re-assert both conditions at write time: the read above is a separate
    // statement, so a batch could have claimed this row in between.
    .eq('status', 'pending')
    .is('batch_id', null);

  if (error) return { error: error.message };

  revalidatePath('/admin/payouts');
  return { error: null };
}
