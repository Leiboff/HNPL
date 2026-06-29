// ─── Banking resolution — group-or-branch flexibility ──────────────────
//
// Resolves which banking row to settle a practice's payouts against:
//   • If the practice has its own banking populated → use it
//     (per-practice billing — solo practitioner OR a brand-with-many
//     where each branch bills itself).
//   • Else fall back to the BRAND's banking
//     (central billing — e.g. a retail chain that bills centrally).
//   • If neither → no banking; not settleable.
//
// Post-0062: every practice belongs to a brand (group_id NOT NULL).
// The pre-0062 "standalone short-circuit" (no group_id → return
// source:none) is gone — it became unreachable once the column was
// made NOT NULL. The shape of the answer is unchanged for the solo
// case: solo practitioner with their own banking still resolves to
// source:'branch'; solo practitioner with NO banking (and a brand row
// whose banking is also empty — the default for an auto-created
// brand) still resolves to source:'none'. The new model is just one
// code path instead of two.
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
 * Resolve banking for a practice's payouts. Returns the PRACTICE's
 * own banking when populated; falls back to the BRAND's banking when
 * the practice has no own banking; returns 'none' when neither is set.
 *
 * Post-0062: every practice has a group_id (NOT NULL at the DB layer).
 * The solo case is "brand of n=1 practices where the brand banking
 * row is usually empty" — the resolver returns source:'branch' for
 * the practice's own banking and the user never sees the word "brand"
 * in their dashboard. The "source:'group'" branch only meaningfully
 * fires for multi-branch brands that have centralised banking.
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

  // Practice's own banking wins when set — solo practitioner OR a
  // branch in a brand that bills per-location.
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

  // No own banking. Every practice now has a brand (group_id NOT NULL
  // post-0062) — defensively skip the lookup if a snapshot/restore
  // has somehow surfaced a NULL row, so the helper still degrades
  // safely to source:'none' in that pathological case.
  if (!practice.group_id) return { source: 'none' };

  // Fall back to the brand's banking. For a solo brand the row is
  // usually empty (no central banking) → falls through to 'none'.
  // For a centrally-billed brand the row is populated → 'group'.
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
