/**
 * Pure planner for the patient payment-methods page. Given the invariant
 * "active plans always collect from the default card", these decisions
 * become a lot simpler than the previous version:
 *
 *   • Only card                → block, "Add another card first."
 *   • Non-default card         → free to delete (no plans can point at
 *                                it; any stray plan is recovered by the
 *                                server before deletion).
 *   • Default card with others → must change default first. We pick the
 *                                most recently added other card as the
 *                                target; the server invokes the
 *                                change_default_card RPC (which atomic-
 *                                ally flips flags + repoints plans +
 *                                writes plan_events), then deletes the
 *                                old card.
 *
 * The previous repoint-decision fields (`repointToCardId`,
 * `repointToToken`) are gone — the RPC owns that work atomically. The
 * client only needs to know "do we need to promote a different card to
 * default first, and which one".
 */

export type RemovalCard = {
  id:         string;
  is_default: boolean;
  created_at: string;
};

export type CardRemovalPlan =
  | { kind: 'not_found' }
  | { kind: 'block_only_card' }
  /** Non-default card → can delete directly. */
  | { kind: 'remove_non_default' }
  /** Default card → promote `promoteToDefaultId` first, then delete. */
  | { kind: 'remove_default'; promoteToDefaultId: string };

export function planCardRemoval(
  cardId:   string,
  allCards: RemovalCard[],
): CardRemovalPlan {
  const card = allCards.find((c) => c.id === cardId);
  if (!card) return { kind: 'not_found' };

  if (allCards.length <= 1) return { kind: 'block_only_card' };

  if (!card.is_default) return { kind: 'remove_non_default' };

  // Removing the default — pick the newest other card as the new default.
  const newest = allCards
    .filter((c) => c.id !== cardId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  return { kind: 'remove_default', promoteToDefaultId: newest.id };
}
