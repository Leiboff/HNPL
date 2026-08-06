/**
 * Pure planner for the patient card list. Under the new rules:
 *
 *   • DEFAULT is for NEW plans only — it does NOT bind existing plans, so
 *     removing (archiving) the default carries no plan-repoint consequence.
 *     A default being archived just promotes the newest other active card.
 *   • A card CANNOT be removed while it is currently collecting an active
 *     plan (its token backs an active / pending_first_payment plan). That
 *     is the ONLY block — not a blanket "never delete", and not the old
 *     "only card" block. A card collecting nothing active is always
 *     archivable, even if it is the last card.
 *
 * `collectsActivePlan` is authoritatively determined server-side (the
 * archive_card RPC re-checks it in the database); this planner mirrors that
 * verdict so the UI can disable "Remove" with an explanation and so the
 * account surface can compute the default-reassignment target for copy.
 */

export type RemovalCard = {
  id:                 string;
  is_default:         boolean;
  created_at:         string;
  /** True when this card's token backs an active/pending plan. */
  collectsActivePlan: boolean;
};

export type CardRemovalPlan =
  | { kind: 'not_found' }
  /** Blocked — the card is collecting an active plan. */
  | { kind: 'block_collecting' }
  /** Archivable non-default card. */
  | { kind: 'archive_non_default' }
  /** Archivable default — promote `promoteToDefaultId` (null if none left). */
  | { kind: 'archive_default'; promoteToDefaultId: string | null };

export function planCardRemoval(
  cardId:   string,
  allCards: RemovalCard[],
): CardRemovalPlan {
  const card = allCards.find((c) => c.id === cardId);
  if (!card) return { kind: 'not_found' };

  // The single, conditional block.
  if (card.collectsActivePlan) return { kind: 'block_collecting' };

  if (!card.is_default) return { kind: 'archive_non_default' };

  // Archiving the default — promote the newest OTHER card (any remaining
  // card; null when this was the only one).
  const newest = allCards
    .filter((c) => c.id !== cardId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  return { kind: 'archive_default', promoteToDefaultId: newest?.id ?? null };
}
