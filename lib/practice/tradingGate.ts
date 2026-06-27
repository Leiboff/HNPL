// ─── Trading gate ────────────────────────────────────────────────────────────
//
// A practice may create bills / plans only when BOTH:
//   a. practices.status = 'approved' — HNPL admin has reviewed and approved
//      the registration.
//   b. At least one practice_members row exists with role = 'provider' and
//      active = true — there is an actual clinician on staff who can be
//      attached to bills.
//
// This module is the single source of truth for that check. It is called
// server-side by the bill-creation action AND server-side by the practice
// dashboard / new-bill page so the UI shows a consistent explanation for
// why trading is blocked. RLS is NOT the backstop — the existing policies
// only check practice membership; without this gate a freshly-signed-up
// pending practice can trade immediately.
//
// The function accepts a Supabase client through a structural type so the
// caller can pass either the SSR client or the service-role client. We use
// the service-role client at the call sites: trading is a security gate
// and we don't want RLS misconfiguration to silently flip the gate the
// wrong way.

export const PENDING_APPROVAL_MESSAGE =
  'Your practice is awaiting BetterNow approval — we usually review new practices within one working day. You can create bills as soon as the review is done.';

export const NO_PROVIDERS_MESSAGE =
  'Add at least one provider (the doctor, dentist, or practitioner) to your practice before creating a bill. You can do this on Team.';

export const NO_BANKING_MESSAGE =
  'This branch has no banking on file and no group banking to fall back on. Add banking on the branch or on the brand before creating bills.';

export type TradingGateReason = 'pending_approval' | 'no_providers' | 'no_banking';

export type TradingGateResult =
  | { ok: true }
  | { ok: false; reason: TradingGateReason; message: string };

// Intentionally loose so callers can pass either @supabase/ssr's
// SupabaseClient or the service-role client without TypeScript trying
// to align the helper's structural type with Supabase's deeply-generic
// PostgREST builder (which triggers "Type instantiation is excessively
// deep and possibly infinite" under strict mode). The hot path is so
// small that the lost compile-time safety is irrelevant — the test
// suite (lib/practice/tradingGate.test.ts) covers the actual contract.
//
// The function reads exactly two queries:
//   .from('practices').select('status').eq('id', X).single()
//   .from('practice_members').select('user_id')
//     .eq('practice_id', X).eq('active', true).eq('role', 'provider').limit(1)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TradingGateSupabase = any;

import { resolvePayoutBanking } from './banking';

export async function checkTradingGate(
  supabase: TradingGateSupabase,
  practiceId: string,
): Promise<TradingGateResult> {
  // ── Condition (a): status = 'approved' ──────────────────────────────────
  // Also reads group_id so we know whether to apply the branch-only
  // banking precondition below. Standalone (group_id NULL) keeps the
  // existing two-condition gate verbatim — adding the column to the
  // SELECT does not change any predicate that already exists.
  const { data: practice, error: practiceError } = await supabase
    .from('practices')
    .select('status, group_id')
    .eq('id', practiceId)
    .single();

  if (practiceError || !practice) {
    // Treat "can't read the practice row" as pending so we fail closed.
    // A real "practice not found" is a different bug — the bill-creation
    // surface should never reach this code without a valid practice id.
    return { ok: false, reason: 'pending_approval', message: PENDING_APPROVAL_MESSAGE };
  }
  if (practice.status !== 'approved') {
    return { ok: false, reason: 'pending_approval', message: PENDING_APPROVAL_MESSAGE };
  }

  // ── Condition (b): >= 1 active provider ─────────────────────────────────
  const { data: providers, error: providerError } = await supabase
    .from('practice_members')
    .select('user_id')
    .eq('practice_id', practiceId)
    .eq('active', true)
    .eq('role', 'provider')
    .limit(1);

  if (providerError || !providers || providers.length === 0) {
    return { ok: false, reason: 'no_providers', message: NO_PROVIDERS_MESSAGE };
  }

  // ── Condition (c) — BRANCHES ONLY: resolved banking exists ──────────────
  // Standalone practices (group_id NULL) skip this so the existing
  // two-condition gate stays byte-for-byte unchanged. For a branch,
  // the resolver checks own banking, then group banking, then 'none'.
  if (practice.group_id) {
    const banking = await resolvePayoutBanking(supabase, practiceId);
    if (banking.source === 'none') {
      return { ok: false, reason: 'no_banking', message: NO_BANKING_MESSAGE };
    }
  }

  return { ok: true };
}
