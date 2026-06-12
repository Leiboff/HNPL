'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CardRow, RemoveCardResult } from './page';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year).slice(-2)}`;
}

// ─── Card thumbnail ───────────────────────────────────────────────────────────

function CardThumbnail({ brand }: { brand: string }) {
  const bg =
    brand === 'Visa'       ? 'linear-gradient(135deg,#1a1f71,#4361ee)' :
    brand === 'Mastercard' ? 'linear-gradient(135deg,#eb001b,#ff5f00)' :
                             'linear-gradient(135deg,#13294B,#15A89E)';
  const label =
    brand === 'Visa'       ? 'VISA' :
    brand === 'Mastercard' ? 'MC'   :
                             brand.slice(0, 2).toUpperCase();
  return (
    <div
      className="w-11 h-8 rounded-lg flex items-center justify-center shrink-0 text-white text-[10px] font-black tracking-wider select-none"
      style={{ background: bg }}
    >
      {label}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  initialCards: CardRow[];
  initializeCardRegistration: () => Promise<{ error: string | null; authorizationUrl?: string }>;
  removeCard:                 (cardId: string) => Promise<RemoveCardResult>;
  setDefaultCard:             (cardId: string) => Promise<{ error: string | null }>;
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function PaymentMethods({
  initialCards,
  initializeCardRegistration,
  removeCard,
  setDefaultCard,
}: Props) {
  const router = useRouter();

  const [cards,           setCards]           = useState<CardRow[]>(initialCards);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [notice,          setNotice]          = useState<string | null>(null);

  // Add-card button state
  const [addLoading, setAddLoading] = useState(false);
  const [addError,   setAddError]   = useState<string | null>(null);

  // Sync local state when the server re-renders (after router.refresh()).
  const initialCardsKey = initialCards
    .map((c) => `${c.id}|${c.is_default}`)
    .join(',');

  useEffect(() => {
    setCards(initialCards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCardsKey]);

  // ── Derived for the confirm dialog: what happens if user removes this card?
  // Mirrors the server planner so the consequence copy is honest.
  function previewRemoval(cardId: string) {
    const card = cards.find((c) => c.id === cardId);
    if (!card)                  return { kind: 'not_found'   as const };
    if (cards.length <= 1)      return { kind: 'block_only_card' as const };

    const currentDefault = cards.find((c) => c.is_default);
    const target =
      currentDefault && currentDefault.id !== cardId
        ? currentDefault
        : [...cards]
            .filter((c) => c.id !== cardId)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

    return {
      kind:                 'remove' as const,
      willPromoteToDefault: card.is_default,
      target,
    };
  }

  // ─── Add card ─────────────────────────────────────────────────────────────

  async function handleAddCard() {
    setAddError(null);
    setAddLoading(true);
    const result = await initializeCardRegistration();
    if (result.error) {
      setAddError(result.error);
      setAddLoading(false);
      return;
    }
    if (result.authorizationUrl) {
      window.location.href = result.authorizationUrl;
      // Keep loading spinner — page is navigating away.
    }
  }

  // ─── Remove ───────────────────────────────────────────────────────────────

  async function handleRemove(cardId: string) {
    setLoading(true);
    setError(null);
    setNotice(null);

    const result = await removeCard(cardId);
    setLoading(false);

    if (result.error !== null) {
      setError(result.error);
      setConfirmRemoveId(null);
      return;
    }

    setConfirmRemoveId(null);
    if (result.repointedPlans > 0) {
      setNotice(
        result.repointedPlans === 1
          ? '1 active plan was moved to your default card.'
          : `${result.repointedPlans} active plans were moved to your default card.`,
      );
    }
    router.refresh();
  }

  // ─── Set default ──────────────────────────────────────────────────────────

  async function handleSetDefault(cardId: string) {
    setLoading(true);
    setError(null);

    const result = await setDefaultCard(cardId);
    setLoading(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setCards((prev) => prev.map((c) => ({ ...c, is_default: c.id === cardId })));
    router.refresh();
  }

  // ─── Card list view ───────────────────────────────────────────────────────

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
            const isConfirming = confirmRemoveId === card.id;
            const preview      = isConfirming ? previewRemoval(card.id) : null;
            const onlyCard     = cards.length <= 1;
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
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {!card.is_default && (
                      <button
                        type="button"
                        onClick={() => handleSetDefault(card.id)}
                        disabled={loading}
                        className="text-xs font-medium disabled:opacity-60 transition-colors"
                        style={{ color: '#15A89E' }}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { if (!onlyCard) { setConfirmRemoveId(card.id); setError(null); setNotice(null); } }}
                      disabled={loading || onlyCard}
                      // Quiet at rest: gray. Red only on hover / focus, so
                      // a resting card doesn't look "armed".
                      className="text-xs font-medium text-gray-500 hover:text-red-700 focus-visible:text-red-700 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
                      title={onlyCard ? 'Add another card first.' : undefined}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* ── Confirm dialog (inline) ─────────────────────────── */}
                {isConfirming && preview?.kind === 'remove' && (
                  <div className="border-t border-gray-100 bg-gray-50 px-5 py-4 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Remove this card?</p>
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                        {preview.willPromoteToDefault
                          ? `Your default will change to ${preview.target.card_brand} •••• ${preview.target.last_four}. `
                          : `Future instalments will be collected from your default card (${preview.target.card_brand} •••• ${preview.target.last_four}). `}
                        Active plans on this card will collect from there going forward.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleRemove(card.id)}
                        disabled={loading}
                        className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
                      >
                        {loading ? 'Removing…' : 'Remove'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(null)}
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

      {/* R1.00 verification note — keep as-is */}
      <div
        className="rounded-xl px-4 py-3 text-xs text-[#13294B]"
        style={{ background: 'rgba(19,41,75,.05)', border: '1px solid rgba(19,41,75,.10)' }}
      >
        We charge R1.00 to verify your card and refund it immediately.
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
        {addLoading ? 'Redirecting…' : 'Add a card'}
      </button>
    </div>
  );
}
