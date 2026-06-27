// ─── Banking resolution — group-or-branch flexibility ──────────────────
//
// Resolves which banking row to settle a branch's payouts against:
//   • If the practice has its own banking populated → use it
//     (per-branch billing — e.g. Lamberti chain).
//   • Else fall back to the GROUP's banking
//     (central billing — e.g. a retail chain).
//   • If neither → no banking; not settleable.
//
// Standalone practices (group_id = NULL) ALWAYS resolve to "branch"
// (their own banking) — the group lookup short-circuits when there's
// no group_id. The behaviour for standalone is byte-for-byte
// equivalent to "read the practice row directly" — same columns, same
// fallback rules — so the prime directive (standalone unchanged) holds.
//
// The function accepts a Supabase client through a structural type so
// the caller can pass either the SSR or service-role client. Same
// structural-loose pattern as lib/practice/tradingGate.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BankingSupabase = any;

export type BankingFields = {
  bank_name:           string | null;
  bank_account_number: string | null;
  branch_code:         string | null;
  account_holder:      string | null;
  account_type:        string | null;
};

export type ResolvedBanking =
  | { source: 'branch'; banking: BankingFields }
  | { source: 'group';  banking: BankingFields; groupId: string }
  | { source: 'none' };

function hasBanking(b: Partial<BankingFields> | null | undefined): boolean {
  return !!(b && (b.bank_name?.trim()) && (b.bank_account_number?.trim()));
}

/**
 * Resolve banking for a practice's payouts. Returns the BRANCH's own
 * banking when populated; falls back to the GROUP's banking when the
 * branch belongs to a group AND has no own banking; returns 'none'
 * when neither is set. Standalone practices (group_id NULL) skip the
 * group lookup entirely.
 *
 * The "has banking" predicate is: bank_name + bank_account_number
 * both non-empty. branch_code etc. are nice-to-have for the actual
 * payout file but their absence doesn't render the row un-settleable
 * — the admin can fill them in before processing.
 */
export async function resolvePayoutBanking(
  supabase:   BankingSupabase,
  practiceId: string,
): Promise<ResolvedBanking> {
  const { data: practice } = await supabase
    .from('practices')
    .select('group_id, bank_name, bank_account_number, branch_code, account_holder, account_type')
    .eq('id', practiceId)
    .maybeSingle();

  if (!practice) return { source: 'none' };

  // Branch's own banking wins when set.
  if (hasBanking(practice)) {
    return {
      source: 'branch',
      banking: {
        bank_name:           practice.bank_name           ?? null,
        bank_account_number: practice.bank_account_number ?? null,
        branch_code:         practice.branch_code         ?? null,
        account_holder:      practice.account_holder      ?? null,
        account_type:        practice.account_type        ?? null,
      },
    };
  }

  // Standalone (group_id NULL) and no own banking → 'none'. The group
  // lookup below short-circuits here, so standalone is unchanged.
  if (!practice.group_id) return { source: 'none' };

  // Branch + no own banking → fall back to the group's banking.
  const { data: group } = await supabase
    .from('practice_groups')
    .select('id, bank_name, bank_account_number, branch_code, account_holder, account_type')
    .eq('id', practice.group_id)
    .maybeSingle();

  if (group && hasBanking(group)) {
    return {
      source: 'group',
      groupId: group.id as string,
      banking: {
        bank_name:           group.bank_name           ?? null,
        bank_account_number: group.bank_account_number ?? null,
        branch_code:         group.branch_code         ?? null,
        account_holder:      group.account_holder      ?? null,
        account_type:        group.account_type        ?? null,
      },
    };
  }

  return { source: 'none' };
}
