import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── Recording who did the privileged thing ────────────────────────────────
//
// Migration 0131 attaches triggers to every privileged column change, so the
// EVENT is recorded whatever writes it. This is the other half: the actor and
// the intent, from the code path that has just authenticated a caller.
//
// The two halves fail in opposite directions, which is why there are two:
//
//   the trigger    cannot be forgotten — it fires for the cron, for psql, for
//                  an action nobody has written yet — but under a
//                  service-role connection auth.uid() is NULL and it cannot
//                  name anyone.
//   this helper    knows exactly who, and can record things that are not a
//                  column change at all (retrying a collection fires a card
//                  charge and changes no column an audit trigger could watch).
//                  It can be forgotten by the next code path.
//
// Where both fire you get two rows for one event. That is intended: an
// unattributed trigger row with no matching call-site row is the signal that
// a write arrived from somewhere nobody wired up.
//
// ─── WHY THE SERVICE-ROLE CLIENT ───────────────────────────────────────────
//
// 0048's RLS policy is `is_platform_admin() AND actor_id = auth.uid()`, which
// makes a browser-originated insert unforgeable — and that policy stays
// exactly as it is; it is what stops anyone hand-rolling a log entry.
//
// It also refuses two callers this helper must serve: a BRAND ADMIN changing
// their own branch's banking (not a platform admin, and the single
// highest-value event in this file), and any action whose write already goes
// through the service-role client. Refusing to record those is worse than
// recording them: the caller's identity is not in question at the point this
// is called — the action has already run its own authorization guard and is
// about to make the change — so the guard, not the policy, is what the
// attribution rests on.
//
// Hence the argument is `actorId` and not a session: pass the id the calling
// action has ALREADY authorized. Never pass one from a request body.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

function svc(): Svc {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/** Matches the CHECK on admin_audit_log.entity_type (0131). */
export type AuditEntity =
  | 'practice'
  | 'customer'
  | 'practice_group'
  | 'payout'
  | 'payout_batch'
  | 'payment';

export type AdminAction = {
  /** The authenticated caller, from the action's own guard. */
  actorId:    string;
  entityType: AuditEntity;
  entityId:   string;
  /** Verb, snake_case, past tense where it reads better. */
  action:     string;
  /** Anything an investigator would need. Never a bank account number. */
  payload?:   Record<string, unknown>;
};

/**
 * Write one admin_audit_log row.
 *
 * NEVER throws and never returns a failure the caller must handle. An audit
 * write that could fail the action it describes would mean a logging outage
 * blocks settlement — and an admin who cannot mark a batch paid will find
 * another way to mark it paid, which is worse than an unlogged one. A failure
 * is logged with an alertable prefix instead.
 */
export async function recordAdminAction(entry: AdminAction): Promise<void> {
  try {
    const { error } = await svc().from('admin_audit_log').insert({
      actor_id:    entry.actorId,
      entity_type: entry.entityType,
      entity_id:   entry.entityId,
      action:      entry.action,
      payload:     entry.payload ?? {},
    });
    if (error) {
      console.error('[admin-audit] ALERT failed to record a privileged action', {
        action: entry.action, entityType: entry.entityType, entityId: entry.entityId,
        error: error.message,
      });
    }
  } catch (err) {
    console.error('[admin-audit] ALERT threw while recording a privileged action', {
      action: entry.action, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record an action that is ATTEMPTED before it is known to have worked.
 *
 * The audit's own recommendation, and the right shape for anything that can
 * fail halfway: a card retry that dies mid-flight is exactly the event an
 * investigator needs to see, and a log written only on success would be
 * missing it. Two rows — `<action>` then `<action>_result` — so the pair
 * shows both the intent and what came of it, and an intent with no result is
 * itself informative.
 */
export async function recordAdminAttempt(
  entry: AdminAction,
): Promise<(outcome: Record<string, unknown>) => Promise<void>> {
  await recordAdminAction(entry);
  return (outcome: Record<string, unknown>) =>
    recordAdminAction({ ...entry, action: `${entry.action}_result`, payload: outcome });
}
