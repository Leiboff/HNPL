'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import PeachWidget from '@/app/_components/PeachWidget';
import { ADD_CARD_PARAM } from '@/lib/patient/cardReturn';
import { cardBrandLabel, cardBrandGradient } from '@/lib/patient/cardBrand';
import type {
  CardRow,
  ChangeDefaultResult,
  RemoveCardResult,
} from './actions';

const LOCKED_REASON = 'Collecting an active plan — change the card on that plan first.';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year).slice(-2)}`;
}

// ─── Card thumbnail ───────────────────────────────────────────────────────────

function CardThumbnail({ brand }: { brand: string }) {
  return (
    <div
      className="w-11 h-8 rounded-lg flex items-center justify-center shrink-0 text-white text-[10px] font-black tracking-wider select-none"
      style={{ background: cardBrandGradient(brand) }}
    >
      {cardBrandLabel(brand)}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  initialCards:               CardRow[];
  /** Ids of cards currently collecting an active plan — cannot be removed
      (RULE 2). Authoritatively re-checked server-side in archive_card. */
  lockedCardIds:              string[];
  // Kicks off the Checkout V2 card-vault flow (Flow B). Returns
  // { checkoutId, shopperResultUrl }; the sheet mounts the widget
  // against those. No cross-page navigation.
  initializeCardRegistration: () => Promise<{
    error:            string | null;
    checkoutId?:      string;
    shopperResultUrl?: string;
  }>;
  changeDefaultCard:          (cardId: string) => Promise<ChangeDefaultResult>;
  removeCard:                 (cardId: string) => Promise<RemoveCardResult>;
};

type Confirm =
  | { kind: 'none' }
  | { kind: 'remove'; cardId: string };

// ─── Main component ───────────────────────────────────────────────────────────

export default function PaymentMethods({
  initialCards,
  lockedCardIds,
  initializeCardRegistration,
  changeDefaultCard,
  removeCard,
}: Props) {
  const router       = useRouter();
  const pathname     = usePathname();
  const searchParams = useSearchParams();

  const [cards,   setCards]   = useState<CardRow[]>(initialCards);
  const [confirm, setConfirm] = useState<Confirm>({ kind: 'none' });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [notice,  setNotice]  = useState<string | null>(null);

  // ── ?added=added|already banner from the Checkout V2 return route ──
  //     The return route uses server-side `redirect(...)` on success
  //     so the browser lands on the card surface with the flag. Shown
  //     once per navigation; the effect strips the query param after
  //     reading it, off whatever path we're mounted on (the card surface
  //     moved into Account, so this must not hard-code a route).
  useEffect(() => {
    const flag = searchParams.get('added');
    if (!flag) return;
    setNotice(flag === 'already' ? 'This card is already saved.' : 'Card added successfully.');
    const params = new URLSearchParams(searchParams.toString());
    params.delete('added');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── ?addCard=1 → auto-open the add-card widget ────────────────────
  //     The "Try again" affordance on the verification result screen
  //     returns here with this flag so a fresh registration RE-LAUNCHES
  //     (rather than re-polling a finished checkout, which can never
  //     succeed). Fire once, then strip the flag so a refresh or
  //     back-nav doesn't re-open the widget.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (searchParams.get(ADD_CARD_PARAM) !== '1') return;
    if (autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(ADD_CARD_PARAM);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    void handleAddCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Add-card button state
  const [addLoading, setAddLoading] = useState(false);
  const [addError,   setAddError]   = useState<string | null>(null);
  // Once initializeCardRegistration returns, hold checkoutId +
  // shopperResultUrl so the sheet can mount the Checkout V2 widget.
  const [addCardWidget, setAddCardWidget] = useState<{
    checkoutId:       string;
    shopperResultUrl: string;
  } | null>(null);

  // Sync local state when the server re-renders (after router.refresh()).
  const initialCardsKey = initialCards
    .map((c) => `${c.id}|${c.is_default}`)
    .join(',');

  useEffect(() => {
    setCards(initialCards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCardsKey]);

  // ── Which card the default moves to when archiving the current default.
  //     Mirrors archive_card's "newest other active card" reassignment so
  //     the confirm copy is accurate. Archiving a non-default card promotes
  //     nothing.
  function previewRemoval(cardId: string) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return null;
    if (!card.is_default) return { willPromoteToDefault: false, target: null };
    const target = [...cards]
      .filter((c) => c.id !== cardId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
    return { willPromoteToDefault: true, target };
  }

  // ─── Add card ─────────────────────────────────────────────────────────────

  async function handleAddCard() {
    setAddError(null);
    setAddLoading(true);
    const result = await initializeCardRegistration();
    setAddLoading(false);
    if (result.error || !result.checkoutId || !result.shopperResultUrl) {
      setAddError(result.error ?? 'Failed to start card registration.');
      return;
    }
    setAddCardWidget({
      checkoutId:       result.checkoutId,
      shopperResultUrl: result.shopperResultUrl,
    });
  }

  // ─── Make default (flag-only — applies to NEW plans only) ──────────────────

  async function commitMakeDefault(cardId: string) {
    setLoading(true);
    setError(null);
    setNotice(null);
    const result = await changeDefaultCard(cardId);
    setLoading(false);

    if (result.error !== null) {
      setError(result.error);
      return;
    }

    if (result.changed) {
      // No plan is repointed — the default seeds NEW plans only.
      setNotice(`Default for new plans is now •••• ${result.newLastFour}.`);
    }
    router.refresh();
  }

  // ─── Remove (soft-delete / archive) ─────────────────────────────────────────

  async function handleRemove(cardId: string) {
    setLoading(true);
    setError(null);
    setNotice(null);

    const result = await removeCard(cardId);
    setLoading(false);
    setConfirm({ kind: 'none' });

    if (result.error !== null) {
      setError(result.error);
      return;
    }

    setNotice(
      result.promotedLastFour
        ? `Card removed. Default for new plans is now •••• ${result.promotedLastFour}.`
        : 'Card removed.',
    );
    router.refresh();
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  // Once the patient hits "Add card", the Checkout V2 widget takes over
  // the whole panel until they cancel or complete the flow. On success
  // it navigates to shopperResultUrl?checkoutId=... →
  // /patient/payment-methods/complete which reads the status, saves the
  // card, and redirects here.
  if (addCardWidget) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3">
            <h2 className="text-base font-semibold text-gray-900">Add a card</h2>
            <p className="mt-1 text-xs text-gray-500">
              We verify your card with your bank — no money is taken.
            </p>
          </div>
          <PeachWidget
            checkoutId={addCardWidget.checkoutId}
            entityId={process.env.NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID ?? ''}
            shopperResultUrl={addCardWidget.shopperResultUrl}
          />
          <button
            type="button"
            onClick={() => setAddCardWidget(null)}
            className="mt-3 text-xs text-gray-500 underline hover:text-gray-700"
            data-testid="payment-methods-widget-cancel"
          >
            Cancel and go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
          {notice}
        </div>
      )}

      {cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-12 text-center">
          <p className="font-medium text-gray-500">No payment methods</p>
          <p className="mt-1 text-sm text-gray-400">Add a card to pay your instalments.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {cards.map((card) => {
            const isConfirmRemove        = confirm.kind === 'remove' && confirm.cardId === card.id;
            const locked                 = lockedCardIds.includes(card.id);
            const removalPreview         = isConfirmRemove ? previewRemoval(card.id) : null;
            return (
              <div
                key={card.id}
                className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm overflow-hidden"
              >
                {/* ── Card row ────────────────────────────────────────── */}
                <div className="flex items-center gap-3 px-5 py-4">
                  <CardThumbnail brand={card.card_brand} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-gray-900">
                        •••• {card.last_four}
                      </span>
                      {card.is_default && (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          style={{ background: 'rgba(21,168,158,.12)', color: '#15A89E' }}
                        >
                          Default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      {card.cardholder_name} · Exp {formatExpiry(card.expiry_month, card.expiry_year)}
                    </p>
                    {card.is_default && (
                      // Microcopy: the default is consumed only when a NEW
                      // plan is created — it never re-points existing plans.
                      <p className="text-[11px] text-gray-400 mt-0.5">Default for new plans</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {!card.is_default && (
                      <button
                        type="button"
                        onClick={() => commitMakeDefault(card.id)}
                        disabled={loading}
                        title="Use this card for new plans. Existing plans are unaffected."
                        className="text-xs font-medium disabled:opacity-60 transition-colors"
                        style={{ color: '#15A89E' }}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (locked) return;
                        setError(null);
                        setNotice(null);
                        setConfirm({ kind: 'remove', cardId: card.id });
                      }}
                      disabled={loading || locked}
                      aria-disabled={locked}
                      // Quiet at rest, red on hover/focus only.
                      className="text-xs font-medium text-gray-500 hover:text-red-700 focus-visible:text-red-700 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
                      title={locked ? LOCKED_REASON : undefined}
                      data-testid={`remove-card-${card.id}`}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Reason a locked card can't be removed (RULE 2). */}
                {locked && (
                  <p className="px-5 pb-3 -mt-1 text-[11px] leading-snug text-gray-400">
                    {LOCKED_REASON}
                  </p>
                )}

                {/* ── Confirm: Remove ─────────────────────────────────── */}
                {isConfirmRemove && removalPreview && (
                  <div className="border-t border-gray-100 bg-gray-50 px-5 py-4 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Remove this card?</p>
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                        {removalPreview.willPromoteToDefault && removalPreview.target
                          ? `We'll archive this card — a secure reference is kept for reconciliation — and your default for new plans moves to ${removalPreview.target.card_brand} •••• ${removalPreview.target.last_four}. Active plans are unaffected; each keeps its own card.`
                          : `We'll archive this card — a secure reference is kept for reconciliation — and take it off your list. Active plans are unaffected; each keeps its own card.`}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleRemove(card.id)}
                        disabled={loading}
                        data-testid="confirm-remove"
                        className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
                      >
                        {loading ? 'Removing…' : 'Remove'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirm({ kind: 'none' })}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

              </div>
            );
          })}
        </div>
      )}

      {/* No-charge card verification note — accurate for the Flow B
          zero-amount PA recipe. No debit, no refund. */}
      <div
        className="rounded-xl px-4 py-3 text-xs text-[#13294B]"
        style={{ background: 'rgba(19,41,75,.05)', border: '1px solid rgba(19,41,75,.10)' }}
      >
        We verify your card with your bank — no money is taken.
      </div>

      {addError && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {addError}
        </div>
      )}

      <button
        type="button"
        onClick={handleAddCard}
        disabled={addLoading || loading}
        className="flex items-center justify-center gap-2 w-full rounded-2xl border border-dashed px-5 py-3.5 text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        style={{ borderColor: 'rgba(21,168,158,.4)', color: '#13294B' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        {addLoading ? 'Opening card form…' : 'Add a card'}
      </button>
    </div>
  );
}
