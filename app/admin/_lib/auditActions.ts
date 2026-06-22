'use server';

// ─── Admin audit + notes server actions ────────────────────────────────────
//
// Two thin server actions backed by the admin_audit_log table
// (supabase/migrations/0048_admin_audit_log.sql):
//
//   addNote(entityType, entityId, text)
//     Inserts an admin_audit_log row with action='note' attributed
//     to the calling admin. The RLS INSERT policy enforces
//     is_platform_admin() AND actor_id = auth.uid() — server actions
//     don't get to forge attribution. We additionally re-check the
//     role here so a non-admin caller bounces before hitting the DB.
//
//   changePracticeFeePercent(practiceId, nextFee)
//     Updates practices.fee_percent and logs the from→to change to
//     admin_audit_log. SAFE: fee_percent is read at payout-creation
//     time (in the webhook) — existing payout rows carry their own
//     fee_amount/net_amount and are unaffected. The change only
//     touches future plans' payouts. Bounds: 0–25%.
//
// Both actions revalidate the relevant detail page so the timeline
// refreshes immediately.

import { revalidatePath } from 'next/cache';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// AUTHZ POSTURE NOTE (2026-06-22, fix 0054):
//   changePracticeFeePercent's UPDATE of practices.fee_percent now
//   goes through the service-role client so the BEFORE UPDATE
//   trigger protect_practices_columns() (added in migration 0054)
//   lets the protected-column write through. The guardAdmin() check
//   is therefore the sole authz on the write — it MUST pass before
//   svc() is called.

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type AuditEntityType = 'practice' | 'customer';

type Ok = { ok: true };
type Err = { ok: false; error: string };

async function guardAdmin() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin' });
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (profile?.role !== 'admin') {
    return { user: null, supabase: null, error: 'Unauthorized' as const };
  }
  return { user, supabase, error: null };
}

export async function addNote(
  entityType: AuditEntityType,
  entityId:   string,
  text:       string,
): Promise<Ok | Err> {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0)       return { ok: false, error: 'Note cannot be empty.' };
  if (trimmed.length > 2000)      return { ok: false, error: 'Note is too long (max 2000 chars).' };
  if (entityType !== 'practice' && entityType !== 'customer') {
    return { ok: false, error: 'Invalid entity type.' };
  }

  const { user, supabase, error } = await guardAdmin();
  if (error || !user || !supabase) return { ok: false, error: 'Unauthorized' };

  const { error: insErr } = await supabase
    .from('admin_audit_log')
    .insert({
      actor_id:    user.id,
      entity_type: entityType,
      entity_id:   entityId,
      action:      'note',
      payload:     { text: trimmed },
    });

  if (insErr) return { ok: false, error: insErr.message };

  revalidatePath(
    entityType === 'practice'
      ? `/admin/practices/${entityId}`
      : `/admin/customers/${entityId}`,
  );
  return { ok: true };
}

export async function changePracticeFeePercent(
  practiceId: string,
  nextFee:    number,
): Promise<Ok | Err> {
  if (!Number.isFinite(nextFee))    return { ok: false, error: 'Fee must be a number.' };
  if (nextFee < 0 || nextFee > 25)  return { ok: false, error: 'Fee must be between 0 and 25%.' };

  const { user, supabase, error } = await guardAdmin();
  if (error || !user || !supabase) return { ok: false, error: 'Unauthorized' };

  // Read the current value to record the from→to delta in the audit
  // log. If the row doesn't exist, bail without writing.
  const { data: current } = await supabase
    .from('practices')
    .select('fee_percent')
    .eq('id', practiceId)
    .maybeSingle();
  if (!current) return { ok: false, error: 'Practice not found.' };

  const prevFee = Number(current.fee_percent);
  // Round to 2dp before comparing so a no-op edit doesn't pollute the
  // audit log with identical-value rows.
  const nextRounded = Math.round(nextFee * 100) / 100;
  if (Math.abs(prevFee - nextRounded) < 0.001) {
    return { ok: false, error: 'Fee is unchanged.' };
  }

  // Service-role write: the protect_practices_columns() trigger
  // (migration 0054) rejects session-client UPDATEs to fee_percent.
  // guardAdmin() above is the authoritative authz here.
  const { error: updErr } = await svc()
    .from('practices')
    .update({ fee_percent: nextRounded })
    .eq('id', practiceId);
  if (updErr) return { ok: false, error: updErr.message };

  const { error: logErr } = await supabase
    .from('admin_audit_log')
    .insert({
      actor_id:    user.id,
      entity_type: 'practice',
      entity_id:   practiceId,
      action:      'fee_changed',
      payload:     { from: prevFee, to: nextRounded },
    });
  if (logErr) {
    // The fee change DID persist. Audit-log failure is logged for
    // operator follow-up but doesn't unwind the update — the new
    // value is correct, we just lost the attribution trail.
    console.error('[changePracticeFeePercent] audit log insert failed', logErr);
  }

  revalidatePath(`/admin/practices/${practiceId}`);
  return { ok: true };
}
