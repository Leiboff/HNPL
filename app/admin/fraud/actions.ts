'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { recordAdminAction } from '@/app/admin/_lib/adminAudit';

// ─── Releasing a customer the fraud rules refused ────────────────────────
//
// This is the other half of an auto-blocking rule, and the half that is
// usually missing. A rule that can refuse a paying customer and has no way
// to un-refuse them is not a control, it is an outage with a rationale — and
// the thresholds in lib/security/identitySignals.ts are, by the platform's
// own admission, judgements about human behaviour rather than numbers fitted
// to data, because there is no data yet. Some of them will be wrong.
//
// ─── WHY THE SESSION CLIENT, NOT SERVICE-ROLE ────────────────────────────
//
// Same shape as app/admin/payouts/actions.ts, for the same reason and it is
// the reason migration 0138's guard trigger is written the way it is: under
// a service-role connection auth.uid() is NULL, so the trigger's
// `released_by = auth.uid()` check could not be satisfied and the release
// would carry no actor. A release is somebody's decision to let a suspected
// fraudster through. It has to have a name on it.
//
// The trigger narrows this UPDATE to exactly three columns, so even a bug
// here cannot rewrite the decision, the rule, or the counts behind it.

async function guardAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.', supabase: null, userId: null };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.', supabase: null, userId: null };
  return { ok: true as const, error: null, supabase, userId: user.id };
}

export async function releaseFraudDecision(
  decisionId: string,
  note: string,
): Promise<{ error: string | null }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // A note is required, and that is not paperwork. The whole reason to
  // record a release is so the NEXT person can tell "we called her, she is
  // a nurse who pays for four family members" apart from "cleared the
  // queue". A release with no reason is indistinguishable from the second.
  const trimmed = note.trim();
  if (trimmed.length < 8) {
    return { error: 'Please say why this customer is being released — it is the only record of the decision.' };
  }

  const { data: decision } = await guard.supabase!
    .from('fraud_decisions')
    .select('id, user_id, decision, rule, released_at')
    .eq('id', decisionId)
    .maybeSingle();

  if (!decision)             return { error: 'Decision not found.' };
  if (decision.released_at)  return { error: 'This decision has already been released.' };

  // Recorded BEFORE the write, on the 0131 discipline: if the update fails
  // the intent is still on the record, and an intent with no matching
  // outcome is exactly the shape an investigator needs to see.
  await recordAdminAction({
    actorId:    guard.userId!,
    entityType: 'customer',
    entityId:   decision.user_id as string,
    action:     'release_fraud_decision',
    payload:    { decision_id: decisionId, rule: decision.rule, note: trimmed },
  });

  const { error } = await guard.supabase!
    .from('fraud_decisions')
    .update({
      released_at:  new Date().toISOString(),
      released_by:  guard.userId,
      release_note: trimmed,
    })
    .eq('id', decisionId)
    .is('released_at', null);

  if (error) return { error: error.message };

  revalidatePath('/admin/fraud');
  return { error: null };
}
