'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { CardRow } from './page';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatExpiry(month: number, year: number): string {
  return `${String(month).padStart(2, '0')}/${String(year).slice(-2)}`;
}

const CURRENT_YEAR = new Date().getFullYear();
const YEARS  = Array.from({ length: 15 }, (_, i) => CURRENT_YEAR + i);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

// ─── Sub-components ───────────────────────────────────────────────────────────

function BrandBadge({ brand }: { brand: string }) {
  const cls =
    brand === 'Visa'       ? 'bg-blue-700 text-white' :
    brand === 'Mastercard' ? 'bg-red-600 text-white'  :
                             'bg-gray-600 text-white';
  return (
    <span className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold tracking-wide ${cls}`}>
      {brand.toUpperCase()}
    </span>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  initialCards: CardRow[];
  initializeCardRegistration: () => Promise<{ error: string | null; authorizationUrl?: string }>;
  updateCard: (
    cardId: string,
    data: { expiry_month: number; expiry_year: number; cardholder_name: string },
  ) => Promise<{ error: string | null }>;
  removeCard: (cardId: string) => Promise<{ error: string | null }>;
  setDefaultCard: (cardId: string) => Promise<{ error: string | null }>;
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function PaymentMethods({
  initialCards,
  initializeCardRegistration,
  updateCard,
  removeCard,
  setDefaultCard,
}: Props) {
  const router = useRouter();

  const [cards, setCards]               = useState<CardRow[]>(initialCards);
  const [mode, setMode]                 = useState<'list' | 'edit'>('list');
  const [editingCard, setEditingCard]   = useState<CardRow | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // Add-card button state
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError]     = useState<string | null>(null);

  // Edit form state
  const [editMonth, setEditMonth] = useState('');
  const [editYear, setEditYear]   = useState('');
  const [editName, setEditName]   = useState('');

  // Sync local state when the server re-renders (after router.refresh())
  const initialCardsKey = initialCards
    .map((c) => `${c.id}|${c.expiry_month}|${c.expiry_year}|${c.cardholder_name}|${c.is_default}`)
    .join(',');

  useEffect(() => {
    setCards(initialCards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCardsKey]);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function openEdit(card: CardRow) {
    setEditingCard(card);
    setEditMonth(String(card.expiry_month));
    setEditYear(String(card.expiry_year));
    setEditName(card.cardholder_name);
    setError(null);
    setMode('edit');
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
      // Keep loading spinner — page is navigating away
    }
  }

  // ─── Edit ─────────────────────────────────────────────────────────────────

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingCard) return;
    setError(null);

    const month = parseInt(editMonth, 10);
    const year  = parseInt(editYear, 10);
    const now   = new Date();
    if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
      setError('This card has expired.');
      return;
    }
    if (!editName.trim()) {
      setError('Cardholder name is required.');
      return;
    }

    setLoading(true);
    const result = await updateCard(editingCard.id, {
      expiry_month:    month,
      expiry_year:     year,
      cardholder_name: editName.trim(),
    });
    setLoading(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setCards((prev) =>
      prev.map((c) =>
        c.id === editingCard.id
          ? { ...c, expiry_month: month, expiry_year: year, cardholder_name: editName.trim() }
          : c
      )
    );
    setMode('list');
    setEditingCard(null);
    router.refresh();
  }

  // ─── Remove ───────────────────────────────────────────────────────────────

  async function handleRemove(cardId: string) {
    setLoading(true);
    setError(null);

    const removedCard = cards.find((c) => c.id === cardId);
    const result = await removeCard(cardId);
    setLoading(false);

    if (result.error) {
      setError(result.error);
      setConfirmRemoveId(null);
      return;
    }

    setCards((prev) => {
      const remaining = prev.filter((c) => c.id !== cardId);
      if (removedCard?.is_default && remaining.length > 0) {
        remaining[0] = { ...remaining[0], is_default: true };
      }
      return remaining;
    });
    setConfirmRemoveId(null);
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

  // ─── Edit form view ───────────────────────────────────────────────────────

  if (mode === 'edit' && editingCard) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Edit card</h2>
            <div className="flex items-center gap-2 mt-1">
              <BrandBadge brand={editingCard.card_brand} />
              <span className="font-mono text-sm text-gray-600">•••• {editingCard.last_four}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { setMode('list'); setEditingCard(null); setError(null); }}
            className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>

        <form onSubmit={handleEdit} className="space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <Field id="editMonth" label="Expiry month">
              <select
                id="editMonth"
                value={editMonth}
                onChange={(e) => setEditMonth(e.target.value)}
                className={inputCls}
              >
                {MONTHS.map((m) => (
                  <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                ))}
              </select>
            </Field>
            <Field id="editYear" label="Expiry year">
              <select
                id="editYear"
                value={editYear}
                onChange={(e) => setEditYear(e.target.value)}
                className={inputCls}
              >
                {YEARS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field id="editName" label="Cardholder name">
            <input
              id="editName"
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={inputCls}
            />
          </Field>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {loading ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </div>
    );
  }

  // ─── Card list view ───────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {cards.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No payment methods</p>
          <p className="mt-1 text-sm text-gray-400">Add a card to pay your instalments.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {cards.map((card) => (
            <div
              key={card.id}
              className="bg-white rounded-2xl border border-gray-200 shadow-sm px-5 py-4"
            >
              {confirmRemoveId === card.id ? (
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm text-gray-700">Remove this card?</p>
                  <div className="flex gap-2 shrink-0">
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
                      className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <BrandBadge brand={card.card_brand} />
                      <span className="font-mono text-sm text-gray-900">•••• {card.last_four}</span>
                      {card.is_default && (
                        <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                          Default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">
                      Expires {formatExpiry(card.expiry_month, card.expiry_year)}
                    </p>
                    <p className="text-xs text-gray-500">{card.cardholder_name}</p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0 flex-wrap justify-end">
                    {!card.is_default && (
                      <button
                        type="button"
                        onClick={() => handleSetDefault(card.id)}
                        disabled={loading}
                        className="text-xs font-medium text-[#13294B] hover:text-[#0E2140] disabled:opacity-60 transition-colors"
                      >
                        Set as default
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEdit(card)}
                      className="text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(card.id)}
                      className="text-xs font-medium text-red-600 hover:text-red-700 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg bg-[#13294B]/5 border border-[#13294B]/20 px-4 py-3 text-sm text-[#13294B]">
        We&apos;ll charge R1.00 to verify your card and refund it immediately. This adds your card so you can pay future plans without re-entering details.
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
        className="flex items-center justify-center gap-2 rounded-2xl border border-dashed border-gray-300 px-5 py-3 text-sm font-medium text-gray-600 hover:border-[#15A89E] hover:text-[#13294B] transition-colors w-full disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <span className="text-lg leading-none" aria-hidden>+</span>
        {addLoading ? 'Redirecting to payment…' : 'Add a card'}
      </button>
    </div>
  );
}
