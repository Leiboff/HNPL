// ─── Shared resolver for PracticeShell's two permission-gated inputs ──────
//
// PracticeShell takes isBrandAdmin + canManageTill and feeds them to
// getPracticeManagerLinks (practiceManagerLinks.ts), which decides whether
// the "Till devices" and "Practice details" nav links appear. Both values
// were resolved by an identical ~15-line block copy-pasted into
// /practice/page.tsx and /practice/members/page.tsx — and the sub-screens
// that had no shell at all computed neither.
//
// Rolling the shell out to every practice screen would have meant four
// copies of that block. That is precisely the failure mode
// practiceManagerLinks.ts exists to prevent (two hand-maintained link lists
// that silently diverged), so the resolution lives here ONCE instead.
//
// This is a pure extraction — the query shape, the client it runs on, and
// the `can_manage_practice || isBrandAdmin` combination are byte-for-byte
// what the two working pages already did. It does NOT change who can see
// what; it only stops the four call sites from drifting apart.

/**
 * Intentionally loose, for exactly the reason lib/practice/tradingGate.ts
 * documents for its own TradingGateSupabase alias: writing a structural
 * type for Supabase's deeply-generic PostgREST builder makes TypeScript
 * report "Type instantiation is excessively deep and possibly infinite" at
 * the call sites (confirmed here — a hand-rolled structural type produced
 * TS2589 in app/practice/page.tsx plus TS2345 at all four callers, because
 * PostgrestBuilder is thenable but not a Promise).
 *
 * These lookups MUST run on the CALLER'S OWN authenticated client, not
 * service-role: RLS participating in the check is the point, and that is
 * what the two pages this was extracted from already did.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PracticeShellSupabase = any;

export type PracticeShellAuthority = {
  /** Active practice_group_members row for this practice's brand. */
  isBrandAdmin:  boolean;
  /** can_manage_practice OR isBrandAdmin — the exact authority
   *  app/practice/pos/devices/actions.ts's guardTillManager() checks. */
  canManageTill: boolean;
};

export async function resolvePracticeShellAuthority(
  supabase: PracticeShellSupabase,
  userId: string,
  practiceId: string,
  /** The caller's can_manage_practice on THIS practice. */
  canManagePractice: boolean,
): Promise<PracticeShellAuthority> {
  const { data: practiceGroupRow } = await supabase
    .from('practices')
    .select('group_id')
    .eq('id', practiceId)
    .maybeSingle();

  const groupId = (practiceGroupRow as { group_id?: string } | null)?.group_id;

  let isBrandAdmin = false;
  if (groupId) {
    const { data: brandMembership } = await supabase
      .from('practice_group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .eq('user_id',  userId)
      .eq('active',   true)
      .maybeSingle();
    isBrandAdmin = !!brandMembership;
  }

  return { isBrandAdmin, canManageTill: canManagePractice || isBrandAdmin };
}
