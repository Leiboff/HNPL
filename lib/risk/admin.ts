// ─── Operator controls: kill switches and the review queue ──────────────
//
// The two things a human does to this system while it is running. Both go
// through the SECURITY DEFINER functions in 0142 rather than through direct
// table writes, for one reason: attribution. A kill switch flipped by
// "service_role" and a review cleared by nobody are the two log lines you do
// not want to be reading during the incident review.
//
// Neither of these functions checks that the caller is an admin. That is the
// calling server action's job, and it is the pattern this codebase already
// uses — the RPCs are service-role only (0125's EXECUTE allow-list), so the
// only way to reach them is through code that has already authorised the
// actor. What these functions guarantee is that whoever does reach them is
// RECORDED.

import { createClient as createServiceClient } from '@supabase/supabase-js';
import type { RiskDimension, RiskKillSwitch } from './vocabulary';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

function svc(): Svc {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type KillSwitchResult =
  | { ok: true; name: RiskKillSwitch; engaged: boolean }
  | { ok: false; error: string };

/**
 * Engage or release a platform kill switch.
 *
 * Takes effect on the next request — `evaluate_risk` reads the table on
 * every call, which is the whole reason a switch is a row and not an
 * environment variable. An environment variable needs a deploy, and the
 * moment you need one of these is the moment a deploy is the slowest thing
 * available.
 */
export async function setKillSwitch(
  name: RiskKillSwitch,
  engaged: boolean,
  actorId: string,
  reason?: string,
  client?: Svc,
): Promise<KillSwitchResult> {
  const db = client ?? svc();
  const { data, error } = await db.rpc('set_risk_kill_switch', {
    p_name:    name,
    p_engaged: engaged,
    p_actor:   actorId,
    p_reason:  reason ?? null,
  });

  if (error) return { ok: false, error: error.code ?? 'rpc_error' };
  if (!data || (data as { ok?: boolean }).ok !== true) {
    return { ok: false, error: (data as { error?: string })?.error ?? 'unknown' };
  }

  // Loud by design. Engaging a kill switch stops customers transacting, and
  // a change of that weight that produced no log line would be indefensible
  // afterwards.
  console.error(JSON.stringify({
    event: 'risk_kill_switch',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    switch: name,
    engaged,
    actor_id: actorId,
    reason: reason ?? null,
  }));

  return { ok: true, name, engaged };
}

export type RiskBlockSpec = {
  dimension: RiskDimension;
  /** Already tokenised — the caller must pass the value the store holds, not
   *  the raw identifier. A reviewer working from a risk_events row has the
   *  dimension and can obtain the token; nobody should be re-hashing a raw
   *  SA ID in an admin action to enter one. */
  token: string;
  action: 'friction' | 'review' | 'deny';
  reason?: string;
  /** Omit for an indefinite block. */
  ttlSecs?: number;
};

export type ReviewDecisionResult =
  | { ok: true; reviewId: string; state: string }
  | { ok: false; error: string };

/**
 * Decide one review, and turn the reviewer's conclusion into enforcement.
 *
 * `blocks` is the part that matters. A queue where clearing and rejecting
 * both just close the row is a queue that produces no controls — the same
 * ring returns tomorrow and trips the same rule, and the human does the same
 * work again. Rejecting with a block on the device or the instrument is how
 * the second visit is cheaper than the first.
 *
 * Clearing does NOT erase the observations behind the review. A cleared
 * account whose device later appears on nine more accounts must still be
 * countable; forgetting the history because someone said "fine on Tuesday"
 * hands a ring a clean slate for the price of one plausible support ticket.
 */
export async function decideRiskReview(
  reviewId: string,
  state: 'in_review' | 'cleared' | 'rejected',
  actorId: string,
  opts?: { notes?: string; blocks?: RiskBlockSpec[]; client?: Svc },
): Promise<ReviewDecisionResult> {
  const db = opts?.client ?? svc();
  const { data, error } = await db.rpc('decide_risk_review', {
    p_review_id: reviewId,
    p_state:     state,
    p_actor:     actorId,
    p_notes:     opts?.notes ?? null,
    p_blocks:    (opts?.blocks ?? []).map((b) => ({
      dimension: b.dimension,
      token:     b.token,
      action:    b.action,
      reason:    b.reason ?? null,
      ...(b.ttlSecs === undefined ? {} : { ttl_secs: b.ttlSecs }),
    })),
  });

  if (error) return { ok: false, error: error.code ?? 'rpc_error' };
  if (!data || (data as { ok?: boolean }).ok !== true) {
    return { ok: false, error: (data as { error?: string })?.error ?? 'unknown' };
  }
  return { ok: true, reviewId, state };
}

export type OpenReview = {
  id: string;
  event: string;
  state: string;
  accountId: string | null;
  practiceId: string | null;
  score: number;
  hitCount: number;
  openedAt: string;
  lastHitAt: string;
  reasons: unknown;
};

/**
 * The queue, worst first.
 *
 * Ordered by score then recency rather than oldest-first, deliberately: the
 * cost of leaving a duplicate-identity review for an hour is a plan HNPL
 * will never collect, and the cost of leaving a busy-practice review is a
 * slightly annoyed receptionist.
 */
export async function listOpenReviews(
  limit = 50,
  client?: Svc,
): Promise<OpenReview[]> {
  const db = client ?? svc();
  const { data, error } = await db
    .from('risk_reviews')
    .select('id, event, state, account_id, practice_id, score, hit_count, opened_at, last_hit_at, reasons')
    .in('state', ['open', 'in_review'])
    .order('score', { ascending: false })
    .order('last_hit_at', { ascending: false })
    .limit(limit);

  if (error || !Array.isArray(data)) return [];

  return data.map((row: Record<string, unknown>) => ({
    id:         String(row.id),
    event:      String(row.event),
    state:      String(row.state),
    accountId:  (row.account_id as string | null) ?? null,
    practiceId: (row.practice_id as string | null) ?? null,
    score:      Number(row.score ?? 0),
    hitCount:   Number(row.hit_count ?? 1),
    openedAt:   String(row.opened_at),
    lastHitAt:  String(row.last_hit_at),
    reasons:    row.reasons,
  }));
}
