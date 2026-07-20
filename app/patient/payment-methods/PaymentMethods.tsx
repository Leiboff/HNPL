'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import PeachCopyAndPayWidget from '@/app/_components/PeachCopyAndPayWidget';
import type {
  CardRow,
  ChangeDefaultResult,
  PreviewDefaultChange,
  RemoveCardResult,
} from './page';

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
  initialCards:               CardRow[];
  // Kicks off the COPYandPAY card-vault flow (Flow B). Returns
  // { checkoutId, shopperResultUrl }; the sheet mounts the widget
  // against those. No cross-page navigation.
  initializeCardRegistration: () => Promise<{
    error:            string | null;
    checkoutId?:      string;
    shopperResultUrl?: string;
  }>;
  previewDefaultChange:       (cardId: string) => Promise<PreviewDefaultChange>;
  changeDefaultCard:          (cardId: string) => Promise<ChangeDefaultResult>;
  removeCard:                 (cardId: string) => Promise<RemoveCardResult>;
};

type Confirm =
  | { kind: 'none' }
  | { kind: 'remove'; cardId: string }
  | {
      kind:           'make-default';
      cardId:         string;
      repointedPlans: number;
      planRefs:       string[];
      newLastFour:    string;
      oldLastFour:    string | null;
    };

// ─── Main component ───────────────────────────────────────────────────────────

export default function PaymentMethods({
  initialCards,
  initializeCardRegistration,
  previewDefaultChange,
  changeDefaultCard,
  removeCard,
}: Props) {
  const router = useRouter();

  const [cards,   setCards]   = useState<CardRow[]>(initialCards);
  const [confirm, setConfirm] = useState<Confirm>({ kind: 'none' });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [notice,  setNotice]  = useState<string | null>(null);

  // Add-card button state
  const [addLoading, setAddLoading] = useState(false);
  const [addError,   setAddError]   = useState<string | null>(null);
  // Once initializeCardRegistration returns, hold checkoutId +
  // shopperResultUrl so the sheet can mount the COPYandPAY widget.
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

  // ── Preview helper for the remove dialog (which target gets promoted).
  function previewRemoval(cardId: string) {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return null;
    if (!card.is_default) return { willPromoteToDefault: false, target: null };
    const target = [...cards]
      .filter((c) => c.id !== cardId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
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

  // ─── Make default ─────────────────────────────────────────────────────────

  async function handleMakeDefaultClick(cardId: string) {
    setError(null);
    setNotice(null);
    setLoading(true);
    const preview = await previewDefaultChange(cardId);
    setLoading(false);

    if (preview.error !== null) {
      setError(preview.error);
      return;
    }

    // N = 0 → skip the dialog and apply the change immediately.
    if (preview.repointedPlans === 0) {
      await commitMakeDefault(cardId);
      return;
    }

    // Otherwise open the consequence dialog.
    setConfirm({
      kind:           'make-default',
      cardId,
      repointedPlans: preview.repointedPlans,
      planRefs:       preview.planRefs,
      newLastFour:    preview.newLastFour,
      oldLastFour:    preview.oldLastFour,
    });
  }

  async function commitMakeDefault(cardId: string) {
    setLoading(true);
    setError(null);
    const result = await changeDefaultCard(cardId);
    setLoading(false);
    setConfirm({ kind: 'none' });

    if (result.error !== null) {
      setError(result.error);
      return;
    }

    if (result.repointedPlans > 0) {
      const plural = result.repointedPlans === 1 ? 'plan' : 'plans';
      setNotice(
        `${result.repointedPlans} active ${plural} now collecting from •••• ${result.newLastFour}.`,
      );
    } else if (result.changed) {
      // Default flag flipped but no active plans were repointed — usually
      // because there are no active plans yet. Surface confirmation so
      // the user knows the click did something.
      setNotice(`Default card is now •••• ${result.newLastFour}.`);
    }
    router.refresh();
  }

  // ─── Remove ───────────────────────────────────────────────────────────────

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

    if (result.repointedPlans > 0) {
      const plural = result.repointedPlans === 1 ? 'plan was' : 'plans were';
      setNotice(`${result.repointedPlans} active ${plural} moved to your default card.`);
    }
    router.refresh();
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  // Once the patient hits "Add card", the COPYandPAY widget takes over
  // the whole panel until they cancel or complete the flow. The widget
  // POSTs to shopperResultUrl on success → /patient/payment-methods/
  // complete?resourcePath=... which saves the card and redirects here.
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
          <PeachCopyAndPayWidget
            checkoutId={addCardWidget.checkoutId}
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
            const isConfirmRemove        = confirm.kind === 'remove'       && confirm.cardId === card.id;
            const isConfirmMakeDefault   = confirm.kind === 'make-default' && confirm.cardId === card.id;
            const onlyCard               = cards.length <= 1;
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
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {!card.is_default && (
                      <button
                        type="button"
                        onClick={() => handleMakeDefaultClick(card.id)}
                        disabled={loading}
                        className="text-xs font-medium disabled:opacity-60 transition-colors"
                        style={{ color: '#15A89E' }}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        if (onlyCard) return;
                        setError(null);
                        setNotice(null);
                        setConfirm({ kind: 'remove', cardId: card.id });
                      }}
                      disabled={loading || onlyCard}
                      // Quiet at rest, red on hover/focus only.
                      className="text-xs font-medium text-gray-500 hover:text-red-700 focus-visible:text-red-700 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
                      title={onlyCard ? 'Add another card first.' : undefined}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* ── Confirm: Remove ─────────────────────────────────── */}
                {isConfirmRemove && removalPreview && (
                  <div className="border-t border-gray-100 bg-gray-50 px-5 py-4 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Remove this card?</p>
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                        {removalPreview.willPromoteToDefault && removalPreview.target
                          ? `Your default will change to ${removalPreview.target.card_brand} •••• ${removalPreview.target.last_four}. Active plans on this card will collect from there going forward.`
                          : 'This card is not collecting any active plans. Removing it just takes it off your profile.'}
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
                        onClick={() => setConfirm({ kind: 'none' })}
                        className="rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Confirm: Make default ───────────────────────────── */}
                {isConfirmMakeDefault && confirm.kind === 'make-default' && (
                  <div className="border-t border-gray-100 bg-gray-50 px-5 py-4 space-y-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Make this card default?</p>
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                        {confirm.repointedPlans === 1
                          ? `1 active plan will collect from •••• ${confirm.newLastFour} going forward.`
                          : `${confirm.repointedPlans} active plans will collect from •••• ${confirm.newLastFour} going forward.`}
                      </p>
                      {confirm.planRefs.length > 0 && confirm.planRefs.length === confirm.repointedPlans && (
                        <ul className="mt-2 text-xs text-gray-500 space-y-0.5">
                          {confirm.planRefs.map((ref) => (
                            <li key={ref} className="font-mono">· {ref}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => commitMakeDefault(card.id)}
                        disabled={loading}
                        className="rounded-lg px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60 transition-all"
                        style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
                      >
                        {loading ? 'Updating…' : 'Make default'}
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
