/**
 * Pure planner that decides what happens when a patient removes a card.
 * The server action calls this with already-loaded data and then executes
 * the returned plan against the database. Keeping the decision logic out
 * of the server action keeps it unit-testable.
 *
 * Rules:
 *   • The patient's only card cannot be removed (no target to fall back
 *     to). UI surfaces a hint; server returns `kind: 'block_only_card'`.
 *   • If any ACTIVE / PENDING_FIRST_PAYMENT plan references this card's
 *     Paystack token, those plans must be repointed to a different card
 *     before deletion. The natural target is the current default; if the
 *     card being removed IS the default, the most recently added other
 *     card is auto-promoted to default and used as the target.
 *   • If the removed card was the default, exactly one other card is
 *     promoted (the same target). Default invariant "exactly one default"
 *     is preserved.
 */

export type RemovalCard = {
  id:         string;
  token:      string;
  is_default: boolean;
  created_at: string;
};

export type CardRemovalPlan =
  | { kind: 'not_found' }
  | { kind: 'block_only_card' }
  | {
      kind:                'remove';
      /** New default card id, if removing the current default. */
      promoteToDefaultId:  string | null;
      /** Repoint target — the token to apply to active plans (and the
       *  card id that will hold the new default), null if no repoint
       *  is needed. */
      repointToCardId:     string | null;
      repointToToken:      string | null;
    };

export function planCardRemoval(
  cardId: string,
  allCards: RemovalCard[],
  hasActivePlansOnCard: boolean,
): CardRemovalPlan {
  const card = allCards.find((c) => c.id === cardId);
  if (!card) return { kind: 'not_found' };

  if (allCards.length <= 1) return { kind: 'block_only_card' };

  // Pick the target card for repoint and (if needed) the new default.
  // Prefer the current default when it's a different card. If the card
  // being removed IS the default, the most recently added other card is
  // promoted.
  const currentDefault = allCards.find((c) => c.is_default);
  const target =
    currentDefault && currentDefault.id !== cardId
      ? currentDefault
      : allCards
          .filter((c) => c.id !== cardId)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  const promoteToDefaultId = card.is_default ? target.id : null;
  const repoint = hasActivePlansOnCard;

  return {
    kind:                'remove',
    promoteToDefaultId,
    repointToCardId:     repoint ? target.id    : null,
    repointToToken:      repoint ? target.token : null,
  };
}
