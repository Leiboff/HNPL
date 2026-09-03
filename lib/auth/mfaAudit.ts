import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── Writing MFA factor changes into admin_audit_log ───────────────────
//
// admin_audit_log is the platform's one privileged-action ledger, next to
// log_payout_settlement, log_profile_role_changes and
// log_practice_group_banking_changes. Factor changes and break-glass
// account use belong on it too (item F), so an investigator reading one
// timeline sees "who moved money" and "who changed the locks" together.
//
// ─── WHY THE SERVICE-ROLE CLIENT, AND WHY THAT IS SAFE HERE ────────────
//
// admin_audit_log's INSERT policy is `is_platform_admin() AND actor_id =
// auth.uid()`. That policy is correct and stays exactly as it is — it is
// what stops a browser hand-rolling a log entry. But it refuses two
// callers this module must serve:
//
//   • a `sales` user enrolling their own factor — `sales` is NOT a
//     platform admin, so the session-client insert would be rejected;
//   • the cron diff, which runs under service-role with auth.uid() NULL.
//
// So the write goes through the service-role client, exactly as
// app/admin/_lib/adminAudit.ts does for the same reason. The identity is
// not in question at the call site: `actorId` is established server-side
// (a validated session for self-service, or NULL-actor for a cron-detected
// out-of-band change) and is never taken from a request body.
//
// entity_type is 'auth_factor', added to the admin_audit_log CHECK by
// migration 0139. entity_id is the user whose factor changed — so a
// customer-360 style lookup by that id surfaces the factor history
// alongside everything else about the account.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

function svc(): Svc {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type MfaFactorEvent = {
  /** The account whose factor changed — becomes entity_id. */
  userId:       string;
  /**
   * Who caused the change. The account holder for self-service; null for a
   * change detected out-of-band by the cron diff, where no actor is known.
   * admin_audit_log.actor_id is nullable and FK ON DELETE RESTRICT, so a
   * null actor is a valid, meaningful "nobody in-app did this" marker.
   */
  actorId:      string | null;
  action:
    | 'mfa_factor_enrolled'
    | 'mfa_factor_unenrolled'
    | 'mfa_factor_appeared'   // cron saw a factor the state table did not
    | 'mfa_factor_disappeared'// cron saw a factor vanish (service-role delete)
    | 'mfa_factor_status_changed'
    | 'break_glass_signin';   // first-ever sign-in on a privileged account
  factorId?:     string | null;
  friendlyName?: string | null;
  role?:         string | null;
  privileged?:   boolean;
  /** 'self_service' | 'cron_diff' | 'sign_in'. */
  source:        string;
  /** Anything else an investigator needs. Never a secret. */
  extra?:        Record<string, unknown>;
};

/**
 * Write one MFA factor-change row. NEVER throws; a logging failure is
 * logged with an alertable prefix, never propagated — the same contract as
 * recordAdminAction, and for the same reason (a security action must not
 * be blocked by an audit outage).
 */
export async function recordMfaFactorEvent(event: MfaFactorEvent): Promise<void> {
  const payload: Record<string, unknown> = {
    source:        event.source,
    factor_id:     event.factorId ?? null,
    friendly_name: event.friendlyName ?? null,
    role:          event.role ?? null,
    privileged:    event.privileged ?? null,
    ...(event.extra ?? {}),
  };

  try {
    const { error } = await svc().from('admin_audit_log').insert({
      actor_id:    event.actorId,
      entity_type: 'auth_factor',
      entity_id:   event.userId,
      action:      event.action,
      payload,
    });
    if (error) {
      console.error('[mfa-audit] ALERT failed to record a factor change', {
        action: event.action, userId: event.userId, error: error.message,
      });
    }
  } catch (err) {
    console.error('[mfa-audit] ALERT threw while recording a factor change', {
      action: event.action, error: err instanceof Error ? err.message : String(err),
    });
  }
}
