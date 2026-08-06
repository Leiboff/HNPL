import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { planCardRemoval, type RemovalCard } from '@/lib/cardRemoval';
import { callChangeDefaultCardRpc } from '@/lib/changeDefaultCard';
import { CARDS_SURFACE } from '@/lib/patient/cardReturn';

// ─── Shared card-management server actions + types ───────────────────────
//
// These are money-path actions (they repoint active plans to a card via
// the change_default_card RPC). They live in this neutral module — NOT in
// the /patient/payment-methods page, which is now an inert redirect — so a
// future cleanup that deletes the redirect page can't take a money-path
// action with it. The single card surface (the Account tab) imports these.

// ─── Types ────────────────────────────────────────────────────────────────────

export type CardRow = {
  id:              string;
  card_brand:      string;
  last_four:       string;
  expiry_month:    number;
  expiry_year:     number;
  cardholder_name: string;
  is_default:      boolean;
  created_at:      string;
};

export type ChangeDefaultResult =
  | { error: string }
  | {
      error:           null;
      /** false when the target was already the default (no-op). */
      changed:         boolean;
      repointedPlans:  number;
      oldLastFour:     string | null;
      newLastFour:     string | null;
    };

export type PreviewDefaultChange =
  | { error: string }
  | {
      error:           null;
      /** Returns 0 when target is already default OR no plans collect
       *  from the previous default. Lets the UI skip the dialog. */
      repointedPlans:  number;
      /** First three invoice numbers (or short ids) for display. */
      planRefs:        string[];
      newLastFour:     string;
      oldLastFour:     string | null;
    };

export type RemoveCardResult =
  | { error: string }
  | {
      error:           null;
      repointedPlans:  number;
      promotedDefaultId: string | null;
    };

// ─── Server Actions ───────────────────────────────────────────────────────────

const ACTIVE_PLAN_STATUSES = ['active', 'pending_first_payment'] as const;

/**
 * Read-only preview: "If I make this card the default, what would
 * happen?" Returns count and up to 3 plan refs so the UI can render the
 * consequence dialog. N=0 lets the UI skip the dialog entirely.
 */
export async function previewDefaultChange(newCardId: string): Promise<PreviewDefaultChange> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: newCard } = await supabase
    .from('payment_methods')
    .select('id, token, last_four, is_default')
    .eq('id', newCardId)
    .eq('patient_id', user.id)
    .maybeSingle();
  if (!newCard) return { error: 'Card not found.' };

  // Already default → no-op preview.
  if (newCard.is_default) {
    return { error: null, repointedPlans: 0, planRefs: [], newLastFour: newCard.last_four, oldLastFour: null };
  }

  // Old default last_four for display — best-effort, allowed to be null.
  const { data: oldCard } = await supabase
    .from('payment_methods')
    .select('last_four')
    .eq('patient_id', user.id)
    .eq('is_default', true)
    .maybeSingle();

  // Count plans that would actually be repointed by the RPC: any active /
  // pending plan whose current token is NOT already the new card's token.
  // This matches the predicate in change_default_card (migration 0039) so
  // the dialog count exactly reflects what the RPC will do — including
  // orphaned-token plans that self-heal on this change.
  const { data: plans } = await supabase
    .from('plans')
    .select('id, invoice_number')
    .eq('patient_id', user.id)
    .neq('peach_registration_id', newCard.token)
    .in('status', ACTIVE_PLAN_STATUSES)
    .order('created_at', { ascending: false })
    .limit(4);

  const list = (plans ?? []) as { id: string; invoice_number: string | null }[];
  return {
    error:           null,
    repointedPlans:  list.length,
    planRefs:        list.slice(0, 3).map((p) => p.invoice_number ?? p.id.slice(0, 8)),
    newLastFour:     newCard.last_four,
    oldLastFour:     oldCard?.last_four ?? null,
  };
}

/**
 * Atomically promotes a card to default and repoints any active/pending
 * plans currently using the previous default. Delegates to the
 * `change_default_card` Postgres function (migration 0038), which runs
 * inside a single transaction — any failure rolls back the flag flip
 * AND the plan repoint, preserving the invariant.
 */
export async function changeDefaultCard(cardId: string): Promise<ChangeDefaultResult> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const result = await callChangeDefaultCardRpc(supabase, cardId);
  if (result.error === null) revalidatePath(CARDS_SURFACE);
  return result;
}

/**
 * Removal. Under the invariant "active plans always collect from the
 * default card":
 *
 *   • Non-default card → free to delete. Server checks for any stray
 *     plan still pointing at this card (broken invariant) and repoints
 *     to the default before deletion, logging a warning.
 *   • Default card with siblings → call the RPC to promote the newest
 *     other card (which atomically repoints all active plans), then
 *     delete the now-non-default original.
 *   • Only card → blocked.
 */
export async function removeCard(cardId: string): Promise<RemoveCardResult> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: cardsRaw } = await supabase
    .from('payment_methods')
    .select('id, is_default, created_at')
    .eq('patient_id', user.id);

  const allCards = (cardsRaw ?? []) as RemovalCard[];
  const plan     = planCardRemoval(cardId, allCards);

  if (plan.kind === 'not_found')      return { error: 'Card not found.' };
  if (plan.kind === 'block_only_card') return { error: 'Add another card before removing this one.' };

  // Fetch the token once — we may need it for both the stray-plan check
  // and the deletion filter.
  const { data: cardToRemove } = await supabase
    .from('payment_methods')
    .select('token, last_four')
    .eq('id', cardId)
    .eq('patient_id', user.id)
    .maybeSingle();
  if (!cardToRemove) return { error: 'Card not found.' };

  let repointedPlans = 0;
  let promotedDefaultId: string | null = null;

  if (plan.kind === 'remove_default') {
    // Promote the newest other card AND repoint all active plans atomically.
    // Reuses the same callChangeDefaultCardRpc seam as the standalone
    // Make-default action — both paths converge on the RPC.
    const rpcResult = await callChangeDefaultCardRpc(supabase, plan.promoteToDefaultId);
    if (rpcResult.error !== null) return { error: rpcResult.error };
    promotedDefaultId = plan.promoteToDefaultId;
    repointedPlans    = rpcResult.repointedPlans;
  } else {
    // remove_non_default — under the invariant, no active plan should
    // collect from this card. If we find any, fix the data before delete.
    const { data: strays } = await supabase
      .from('plans')
      .select('id')
      .eq('patient_id', user.id)
      .eq('peach_registration_id', cardToRemove.token)
      .in('status', ACTIVE_PLAN_STATUSES);

    const strayIds = (strays ?? []).map((p) => p.id as string);
    if (strayIds.length > 0) {
      console.warn(
        `[removeCard] Invariant violation: ${strayIds.length} active plan(s) collecting from non-default card ${cardId} for user ${user.id}. Repointing to current default before delete.`,
      );
      const { data: defaultCard } = await supabase
        .from('payment_methods')
        .select('token')
        .eq('patient_id', user.id)
        .eq('is_default', true)
        .maybeSingle();
      if (defaultCard) {
        const { error: repointErr } = await supabase
          .from('plans')
          .update({ peach_registration_id: defaultCard.token })
          .in('id', strayIds);
        if (repointErr) return { error: repointErr.message };
        repointedPlans = strayIds.length;
      }
    }
  }

  // Finally delete the card row.
  const { error: delErr } = await supabase
    .from('payment_methods')
    .delete()
    .eq('id', cardId)
    .eq('patient_id', user.id);
  if (delErr) return { error: delErr.message };

  revalidatePath(CARDS_SURFACE);
  return { error: null, repointedPlans, promotedDefaultId };
}
