import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { callSetDefaultCardFlagRpc, callArchiveCardRpc } from '@/lib/cardRpcs';
import { CARDS_SURFACE } from '@/lib/patient/cardReturn';

// ─── Shared card-management server actions + types ───────────────────────
//
// These live in this neutral module — NOT in the /patient/payment-methods
// page, which is an inert redirect — so a future cleanup that deletes the
// redirect page can't take a card action with it. The single card surface
// (the Account tab) imports these.
//
// Both mutations delegate to Postgres functions (migration 0083) that
// enforce the rules server-side:
//   • changeDefaultCard → set_default_card_flag: flips is_default ONLY.
//     The default is for NEW plans; NO existing plan is repointed.
//   • removeCard       → archive_card: soft-delete, BLOCKED while the card
//     is collecting an active plan; reassigns default if needed.

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
      error:       null;
      /** false when the target was already the default (no-op). */
      changed:     boolean;
      oldLastFour: string | null;
      newLastFour: string | null;
    };

export type RemoveCardResult =
  | { error: string }
  | {
      error:             null;
      archived:          boolean;
      /** Set when archiving the default promoted another card. */
      promotedDefaultId: string | null;
      promotedLastFour:  string | null;
    };

// ─── Server Actions ───────────────────────────────────────────────────────────

/**
 * Promote a card to the account default (used to seed NEW plans only).
 * Flag-only — existing/active plans are NOT repointed; they keep the card
 * they were created with and change only via the per-plan flow.
 */
export async function changeDefaultCard(cardId: string): Promise<ChangeDefaultResult> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const result = await callSetDefaultCardFlagRpc(supabase, cardId);
  if (result.error === null) revalidatePath(CARDS_SURFACE);
  return result;
}

/**
 * Remove a saved card. This is a SOFT-DELETE (archive): the processor token
 * is retained for reconciliation/disputes and the card drops off the
 * patient's active list. The database function BLOCKS the archive while the
 * card is collecting an active plan (returns a friendly error) — enforced
 * server-side, so a direct call cannot bypass a disabled UI button.
 */
export async function removeCard(cardId: string): Promise<RemoveCardResult> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const result = await callArchiveCardRpc(supabase, cardId);
  if (result.error === null) revalidatePath(CARDS_SURFACE);
  return result;
}
