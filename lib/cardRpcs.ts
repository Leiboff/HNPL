import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Seams between the patient card-management server actions and the
//     Postgres card functions (migration 0083) ──────────────────────────
//
// Extracted so regression tests can verify each RPC is called with the
// right name + args without a real database. Both card mutations are
// enforced server-side inside the DB functions:
//   • set_default_card_flag — flip is_default only (no plan repoint).
//   • archive_card          — guard + soft-delete + default reassignment.

// ── Make default (flag-only) ──────────────────────────────────────────

export type SetDefaultRpcResult = {
  changed:       boolean;
  old_last_four: string | null;
  new_last_four: string | null;
};

export type SetDefaultResponse =
  | { error: string }
  | {
      error:       null;
      changed:     boolean;
      oldLastFour: string | null;
      newLastFour: string | null;
    };

export async function callSetDefaultCardFlagRpc(
  supabase: SupabaseClient,
  cardId: string,
): Promise<SetDefaultResponse> {
  const { data, error } = await supabase.rpc('set_default_card_flag', { p_card_id: cardId });
  if (error) return { error: error.message };

  const r = data as SetDefaultRpcResult;
  return {
    error:       null,
    changed:     r.changed,
    oldLastFour: r.old_last_four,
    newLastFour: r.new_last_four,
  };
}

// ── Archive (soft-delete, guarded) ────────────────────────────────────

export type ArchiveRpcResult = {
  archived:            boolean;
  promoted_default_id: string | null;
  promoted_last_four:  string | null;
};

export type ArchiveResponse =
  | { error: string }
  | {
      error:             null;
      archived:          boolean;
      promotedDefaultId: string | null;
      promotedLastFour:  string | null;
    };

/**
 * The DB function raises `card_collecting_active_plan` when the card still
 * backs an active plan — surfaced here as a friendly, user-facing message.
 * Every other raised code passes through verbatim.
 */
export async function callArchiveCardRpc(
  supabase: SupabaseClient,
  cardId: string,
): Promise<ArchiveResponse> {
  const { data, error } = await supabase.rpc('archive_card', { p_card_id: cardId });
  if (error) {
    if (error.message.includes('card_collecting_active_plan')) {
      return { error: 'Collecting an active plan — change the card on that plan first.' };
    }
    return { error: error.message };
  }

  const r = data as ArchiveRpcResult;
  return {
    error:             null,
    archived:          r.archived,
    promotedDefaultId: r.promoted_default_id,
    promotedLastFour:  r.promoted_last_four,
  };
}
