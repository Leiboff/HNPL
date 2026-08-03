'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// ─── markPayoutPaid ─────────────────────────────────────────────────────────
//
// Admin manually marks a pending payout as paid (we initiate the actual
// payout via banking/EFT outside the app — this is the bookkeeping flip).
// Server-side admin auth; UI only triggers, never decides.

async function guardAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.', supabase: null };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.', supabase: null };
  return { ok: true as const, error: null, supabase };
}

export async function markPayoutPaid(payoutId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { data: payout } = await guard.supabase!
    .from('payouts')
    .select('id, status')
    .eq('id', payoutId)
    .eq('status', 'pending')
    .maybeSingle();
  if (!payout) return { error: 'Payout not found or not pending.' };

  const { error } = await guard.supabase!
    .from('payouts')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', payoutId);

  if (error) return { error: error.message };

  revalidatePath('/admin/payouts');
  return { error: null };
}
