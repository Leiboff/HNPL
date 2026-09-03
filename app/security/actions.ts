'use server';

import { createClient } from '@/lib/supabase/server';
import { isMfaRequiredRole } from '@/lib/auth/privilegedRoles';
import { recordMfaFactorEvent } from '@/lib/auth/mfaAudit';

// ─── MFA factor-change audit hooks ─────────────────────────────────────
//
// The actual enrol / verify / unenrol calls run in the browser
// (SecurityClient.tsx) against `supabase.auth.mfa.*` — they have to, the
// TOTP secret and the challenge live in the browser. These server actions
// exist for the ONE thing the browser cannot be trusted to do for itself:
// write the audit row. The row is written from the server session, so its
// actor is `auth.getUser()` server-side, never a value the client asserts.
//
// This is the app-driven half of item F. It catches every factor change
// that goes THROUGH this page. The other half — the scheduled diff of
// auth.mfa_factors (app/api/cron/mfa-factor-audit) — catches the changes
// that do NOT: a factor deleted with the service-role admin API, or any
// change made outside the app. Neither is sufficient alone; a change this
// action records is also picked up by the next cron diff, and the pair
// reading as one event is fine (same intended-duplicate posture as
// admin_audit_log's trigger + call-site rows).
//
// Best-effort by design: a failed audit write must not block a security
// action. An admin who cannot finish enrolling because the log is down is
// an admin who stays at aal1, which is the worse outcome. Failures are
// logged with an alertable prefix inside recordMfaFactorEvent.

type FactorEventInput = {
  factorId:     string;
  friendlyName?: string | null;
};

/**
 * Record that the current user VERIFIED a new factor (reached aal2).
 * Called by the client immediately after a successful `mfa.verify()`.
 */
export async function auditFactorEnrolled(input: FactorEventInput): Promise<{ ok: boolean }> {
  return recordFromSession('mfa_factor_enrolled', input);
}

/**
 * Record that the current user UNENROLLED a factor. Called by the client
 * after a successful `mfa.unenroll()`.
 */
export async function auditFactorUnenrolled(input: FactorEventInput): Promise<{ ok: boolean }> {
  return recordFromSession('mfa_factor_unenrolled', input);
}

async function recordFromSession(
  action: 'mfa_factor_enrolled' | 'mfa_factor_unenrolled',
  input:  FactorEventInput,
): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  // Role is read server-side so the payload cannot claim a role the caller
  // does not hold. Non-privileged roles never reach this page, but the
  // record is only meaningful for the accounts the mandate covers.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role ?? null;

  await recordMfaFactorEvent({
    userId:       user.id,
    actorId:      user.id, // self-service: the actor is the account holder.
    action,
    factorId:     input.factorId,
    friendlyName: input.friendlyName ?? null,
    role,
    privileged:   isMfaRequiredRole(role),
    source:       'self_service',
  });

  return { ok: true };
}
