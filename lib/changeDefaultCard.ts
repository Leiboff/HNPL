import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Raw shape returned by the `change_default_card` Postgres function (see
 * supabase/migrations/0039_change_default_card_fn.sql and
 * supabase/migrations/0040_change_default_card_self_heal.sql).
 */
export type ChangeDefaultRpcResult = {
  changed:         boolean;
  repointed_plans: number;
  plan_refs:       Array<{ id: string; invoice_number: string | null }>;
  old_last_four:   string | null;
  new_last_four:   string | null;
};

/** Server-action-facing shape (camelCase, discriminated by `error`). */
export type ChangeDefaultResponse =
  | { error: string }
  | {
      error:          null;
      changed:        boolean;
      repointedPlans: number;
      oldLastFour:    string | null;
      newLastFour:    string | null;
    };

/**
 * The single seam between the patient payment-methods server actions and
 * the `change_default_card` Postgres function. Extracted so a regression
 * test can verify the RPC is called with the right name and arguments
 * without spinning up a real database — see
 * lib/changeDefaultCard.test.ts.
 *
 * Both the standalone Make-default action AND the default-card removal
 * path go through this helper, so a future edit that forgets to call it
 * is caught at the seam.
 */
export async function callChangeDefaultCardRpc(
  supabase: SupabaseClient,
  cardId: string,
): Promise<ChangeDefaultResponse> {
  const { data, error } = await supabase.rpc('change_default_card', { p_card_id: cardId });
  if (error) return { error: error.message };

  const result = data as ChangeDefaultRpcResult;
  return {
    error:          null,
    changed:        result.changed,
    repointedPlans: result.repointed_plans,
    oldLastFour:    result.old_last_four,
    newLastFour:    result.new_last_four,
  };
}
