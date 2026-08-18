// ─── Trading gate ────────────────────────────────────────────────────────────
//
// A practice may create bills / plans only when ALL THREE:
//   a. practices.status = 'approved' — HNPL admin has reviewed and approved
//      the registration.
//   b. At least one practice_members row exists with role = 'provider' and
//      active = true — there is an actual clinician on staff who can be
//      attached to bills.
//   c. Banking resolves — the practice has its own banking, OR (for a
//      multi-branch brand) the brand's central banking is set. We can't
//      settle a bill without a destination account.
//
// This module is the single source of truth for that check. It is called
// server-side by the bill-creation action AND server-side by the practice
// dashboard / new-bill page so the UI shows a consistent explanation for
// why trading is blocked. RLS is NOT the backstop — the existing policies
// only check practice membership; without this gate a freshly-signed-up
// pending practice can trade immediately.
//
// Banking universal post-0062: pre-inversion, condition (c) was gated on
// `practice.group_id` being NOT NULL (branches only). Now every practice
// belongs to a brand (group_id is NOT NULL at the DB layer), so the gate
// fires uniformly. The resolver still treats "own banking wins, brand
// banking is the fallback" — that part is unchanged.
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
  'Add banking to your practice before creating bills — we need an account to pay out the patient payments into.';

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

import { resolvePayoutBanking, type ResolvedBanking } from './banking';

// Optional injection seam — production passes the real
// resolvePayoutBanking; tests pass a deterministic stub so the
// trading-gate test suite stays decoupled from the banking-query
// shape. Default = the real resolver, so production callers don't
// have to know this exists.
export type BankingResolver = (
  supabase:   TradingGateSupabase,
  practiceId: string,
) => Promise<ResolvedBanking>;

export async function checkTradingGate(
  supabase: TradingGateSupabase,
  practiceId: string,
  opts?: { resolveBanking?: BankingResolver },
): Promise<TradingGateResult> {
  // ─── All three conditions read at once ──────────────────────────────────
  //
  // These were three sequential awaits with early returns between them, so a
  // fully set-up practice — the common case, and the one on the hot path of
  // /practice, /practice/bills and /practice/settings — paid every round trip
  // in series on each page load. None of the three depends on another; all
  // three are keyed on practiceId alone.
  //
  // WHAT THIS TRADES. The early returns meant a blocked practice issued only
  // the queries it needed: an unapproved practice never read providers or
  // banking. Now all three always run. That is the right way round — the
  // discarded reads only happen on a path that is ALREADY blocked and
  // rendering a refusal, while the win lands on every successful page load.
  //
  // PRECEDENCE IS PRESERVED EXACTLY, and it is load-bearing: a practice that
  // is both unapproved AND provider-less must report pending_approval, not
  // no_providers (pinned in tradingGate.test.ts). With the reads no longer
  // short-circuiting, the ordering that used to be implicit in the control
  // flow is now explicit in the checks below — same order, same reasons.
  //
  // Note the wave is bounded by resolveBanking, which is two serial reads
  // internally (its second needs practice.group_id from its first). So this
  // is 4 serial round trips becoming 2, not 3 becoming 1.
  const resolveBanking = opts?.resolveBanking ?? resolvePayoutBanking;

  const [
    { data: practice, error: practiceError },
    { data: providers, error: providerError },
    banking,
  ] = await Promise.all([
    supabase
      .from('practices')
      .select('status')
      .eq('id', practiceId)
      .single(),
    supabase
      .from('practice_members')
      .select('user_id')
      .eq('practice_id', practiceId)
      .eq('active', true)
      .eq('role', 'provider')
      .limit(1),
    resolveBanking(supabase, practiceId),
  ]);

  // ── Condition (a): status = 'approved' ──────────────────────────────────
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
  if (providerError || !providers || providers.length === 0) {
    return { ok: false, reason: 'no_providers', message: NO_PROVIDERS_MESSAGE };
  }

  // ── Condition (c): resolved banking exists ──────────────────────────────
  // Universal post-0062: every practice has a brand, so the resolver
  // always returns 'branch' (own banking), 'group' (brand fallback),
  // or 'none'. We block only on 'none'.
  if (banking.source === 'none') {
    return { ok: false, reason: 'no_banking', message: NO_BANKING_MESSAGE };
  }

  return { ok: true };
}
