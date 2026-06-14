'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// ─── Server-side admin guard ─────────────────────────────────────────────────
//
// Mirrors the verifyAdmin() helper in app/admin/page.tsx — uses the SSR
// client's getUser() to identify the caller, then reads profiles.role to
// confirm admin status. We do NOT trust client-side UI gating; both
// approvePractice and suspendPractice run this check before any write.

type GuardOk = {
  ok:        true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:  any;
  userId:    string;
};
type GuardErr = { ok: false; error: string };

async function guardAdmin(): Promise<GuardOk | GuardErr> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    return { ok: false, error: 'Unauthorized.' };
  }

  return { ok: true, supabase, userId: user.id };
}

// ─── approvePractice ─────────────────────────────────────────────────────────
//
// Flips practices.status to 'approved' and stamps the audit columns added
// by migration 0046 (approved_at, approved_by). The trading gate
// (lib/practice/tradingGate.ts) and the RLS function from 0043 both
// observe this transition immediately — the practice can trade as soon
// as it ALSO has >= 1 active provider.

export async function approvePractice(practiceId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await guard.supabase
    .from('practices')
    .update({
      status:       'approved',
      approved_at:  new Date().toISOString(),
      approved_by:  guard.userId,
    })
    .eq('id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/admin/practices');
  return { error: null };
}

// ─── suspendPractice ─────────────────────────────────────────────────────────
//
// Flips status to 'suspended'. Does NOT clear approved_at / approved_by —
// the audit trail preserves the first approval. If we later need a full
// status-event history we'll add a separate table.

export async function suspendPractice(practiceId: string): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const { error } = await guard.supabase
    .from('practices')
    .update({ status: 'suspended' })
    .eq('id', practiceId);

  if (error) return { error: error.message };

  revalidatePath('/admin/practices');
  return { error: null };
}
