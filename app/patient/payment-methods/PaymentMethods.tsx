'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import PeachWidget from '@/app/_components/PeachWidget';
import { ADD_CARD_PARAM } from '@/lib/patient/cardReturn';
import { cardBrandLabel, cardBrandGradient } from '@/lib/patient/cardBrand';
import EmptyState from '@/components/EmptyState';
import { formatDate } from '@/app/patient/_format';
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
      className="w-[38px] h-[26px] rounded-chip flex items-center justify-center shrink-0 text-white text-[9px] font-black tracking-wider select-none"
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

  // Once the patient hits "Add card", the Checkout V2 widget takes over.
  //
  // This used to render INLINE, inside the normal payment-methods panel —
  // which sits inside PatientScreen's scrolling sheet, itself inside
  // <main className="pb-28"> above the fixed bottom nav. The widget's iframe
  // has a content-fitting min-height (globals.css `.peach-embed`) with no
  // max-height, so on a short viewport the "Save card" button could end up
  // below the fold, competing with the fixed nav bar for the same strip of
  // screen. A full-viewport overlay (fixed, own scroll container, z-index
  // above the bottom nav's z-30) sidesteps that entirely: the card form
  // always gets the whole screen to grow into, and it scrolls independently
  // of whatever the panel underneath happens to be doing.
  //
  // On success it navigates to shopperResultUrl?checkoutId=... →
  // /patient/payment-methods/complete which reads the status, saves the
  // card, and redirects here.
  if (addCardWidget) {
    return (
      <div
        className="fixed inset-0 z-50 overflow-y-auto bg-white"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
        data-testid="add-card-overlay"
      >
        <div className="mx-auto w-full max-w-md md:max-w-lg px-[18px] pt-5 pb-10">
          <button
            type="button"
            onClick={() => setAddCardWidget(null)}
            className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-700"
            data-testid="payment-methods-widget-cancel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 18-6-6 6-6" />
            </svg>
            Cancel
          </button>
          <h2 className="text-base font-semibold text-gray-900">Add a card</h2>
          <p className="mt-1 mb-4 text-xs text-gray-500">
            We verify your card with your bank — no money is taken.
          </p>
          <PeachWidget
            mode="registration"
            checkoutId={addCardWidget.checkoutId}
            entityId={process.env.NEXT_PUBLIC_PEACH_CHECKOUT_ENTITY_ID ?? ''}
            shopperResultUrl={addCardWidget.shopperResultUrl}
          />
        </div>
      </div>
    );
  }

  // The default card is the one that collects new plans, so it is the one
  // the screen leads with — as a card-shaped object rather than another
  // row, because a list where every entry looks the same makes the patient
  // hunt for the "Default" pill to answer the question they opened the
  // screen with.
  const defaultCard = cards.find((c) => c.is_default) ?? null;
  const backupCards = cards.filter((c) => c !== defaultCard);

  function renderRemoveConfirm(card: CardRow) {
    const removalPreview = previewRemoval(card.id);
    if (!removalPreview) return null;
    return (
      <div className="rounded-card px-[18px] py-[16px] flex flex-col gap-3" style={{ background: 'var(--portal-wash)', border: '1px solid var(--portal-line-soft)' }}>
        <div>
          <p className="text-[14px] font-semibold" style={{ color: 'var(--portal-ink)' }}>Remove this card?</p>
          <p className="mt-1.5 text-[12.5px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
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
            className="rounded-tile px-4 py-[11px] text-[13.5px] font-semibold text-white disabled:opacity-60 transition-colors"
            style={{ background: '#B42318' }}
          >
            {loading ? 'Removing…' : 'Remove'}
          </button>
          <button
            type="button"
            onClick={() => setConfirm({ kind: 'none' })}
            className="bn-btn-wash rounded-tile px-4 py-[11px] text-[13.5px] font-semibold"
            style={{ color: 'var(--portal-ink-2)' }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  function RemoveButton({ card }: { card: CardRow }) {
    const locked = lockedCardIds.includes(card.id);
    return (
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
        className="text-[12.5px] font-semibold hover:text-[#B42318] focus-visible:text-[#B42318] disabled:cursor-not-allowed transition-colors"
        style={{ color: locked ? 'var(--portal-line)' : 'var(--portal-faint)' }}
        title={locked ? LOCKED_REASON : undefined}
        data-testid={`remove-card-${card.id}`}
      >
        Remove
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-[12px]">
      {error  && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {cards.length === 0 && (
        <EmptyState icon="card" title="No saved cards">
          Add one and we&rsquo;ll use it to collect your instalments on your salary date.
        </EmptyState>
      )}

      {/* ── The collection card ─────────────────────────────────────── */}
      {defaultCard && (
        <>
          <div
            className="bn-up relative rounded-card p-[20px] overflow-hidden"
            style={{ background: 'linear-gradient(140deg,var(--brand-navy),var(--brand-navy-deep))' }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-full"
              style={{ top: -60, right: -40, width: 200, height: 200, background: 'radial-gradient(circle, rgba(25,194,182,.28), transparent 68%)' }}
            />
            <div className="relative flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.16em', color: 'rgba(255,255,255,.5)' }}>
                Collection card
              </span>
              <span className="text-[12px] font-bold text-white" style={{ letterSpacing: '.04em' }}>
                {cardBrandLabel(defaultCard.card_brand)}
              </span>
            </div>
            {/* Dots, not the digits we do not hold. Peach tokenises the
                card; the last four is genuinely all this app has, and
                drawing the full 16-digit shape around it is what makes
                that legible as "a card" rather than as a fragment. */}
            <p className="relative mt-[26px] text-[20px] font-semibold text-white tabular-nums" style={{ letterSpacing: '.14em' }}>
              ···· ···· ···· {defaultCard.last_four}
            </p>
            <div className="relative mt-4 flex items-center justify-between gap-3">
              <span className="text-[12.5px] truncate" style={{ color: 'rgba(255,255,255,.55)' }}>
                {defaultCard.cardholder_name} · {formatExpiry(defaultCard.expiry_month, defaultCard.expiry_year)}
              </span>
              <span
                className="flex-none text-[11px] font-semibold rounded-full px-2.5 py-1"
                style={{ background: 'rgba(25,194,182,.2)', color: 'var(--brand-teal-bright)' }}
              >
                Default
              </span>
            </div>
            <div className="relative mt-[14px] flex items-center justify-between gap-3">
              <span className="min-w-0 text-[11.5px] truncate" style={{ color: 'rgba(255,255,255,.4)' }}>
                {/* Microcopy: the default is consumed only when a NEW plan
                    is created — it never re-points existing plans. It has
                    to say "for new plans", because the obvious reading of
                    a card labelled Default on this screen is that every
                    plan collects from it, and that is not true. */}
                <span>Default for new plans</span>
                {' · '}
                <AddedOn card={defaultCard} />
              </span>
              <button
                type="button"
                onClick={() => {
                  if (lockedCardIds.includes(defaultCard.id)) return;
                  setError(null);
                  setNotice(null);
                  setConfirm({ kind: 'remove', cardId: defaultCard.id });
                }}
                disabled={loading || lockedCardIds.includes(defaultCard.id)}
                aria-disabled={lockedCardIds.includes(defaultCard.id)}
                className="flex-none text-[12.5px] font-semibold disabled:cursor-not-allowed transition-colors"
                style={{ color: lockedCardIds.includes(defaultCard.id) ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.55)' }}
                title={lockedCardIds.includes(defaultCard.id) ? LOCKED_REASON : undefined}
                data-testid={`remove-card-${defaultCard.id}`}
              >
                Remove
              </button>
            </div>
          </div>
          {lockedCardIds.includes(defaultCard.id) && (
            <p className="px-1 text-[11.5px] leading-snug" style={{ color: 'var(--portal-faint)' }}>{LOCKED_REASON}</p>
          )}
          {confirm.kind === 'remove' && confirm.cardId === defaultCard.id && renderRemoveConfirm(defaultCard)}
        </>
      )}

      {/* ── Backups ─────────────────────────────────────────────────── */}
      {backupCards.map((card) => {
        const locked = lockedCardIds.includes(card.id);
        return (
          <div key={card.id} className="flex flex-col gap-[12px]">
            <div
              className="rounded-card bg-white p-[16px] flex items-center gap-[13px]"
              style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
            >
              <CardThumbnail brand={card.card_brand} />
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-semibold truncate tabular-nums" style={{ color: 'var(--portal-ink)' }}>
                  {cardBrandLabel(card.card_brand)} ···· {card.last_four}
                </p>
                <p className="mt-[3px] text-[12px] truncate" style={{ color: 'var(--portal-faint)' }}>
                  Backup · expires {formatExpiry(card.expiry_month, card.expiry_year)} · <AddedOn card={card} />
                </p>
              </div>
              <div className="flex-none flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => commitMakeDefault(card.id)}
                  disabled={loading}
                  title="Use this card for new plans. Existing plans are unaffected."
                  className="bn-btn-wash rounded-chip px-3 py-[9px] text-[12.5px] font-semibold disabled:opacity-60"
                  style={{ color: 'var(--portal-ink-2)' }}
                >
                  Make default
                </button>
                <RemoveButton card={card} />
              </div>
            </div>
            {locked && (
              <p className="px-1 -mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--portal-faint)' }}>{LOCKED_REASON}</p>
            )}
            {confirm.kind === 'remove' && confirm.cardId === card.id && renderRemoveConfirm(card)}
          </div>
        );
      })}

      {addError && <Banner tone="danger">{addError}</Banner>}

      <button
        type="button"
        onClick={handleAddCard}
        disabled={addLoading || loading}
        className="rounded-card px-[17px] py-[17px] text-[14px] font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        style={{ border: '1px dashed var(--portal-line)', background: '#fff', color: 'var(--portal-accent-ink)' }}
      >
        {addLoading ? 'Opening card form…' : '+ Add a card'}
      </button>

      {/* No-charge card verification note — accurate for the Flow B
          zero-amount PA recipe. No debit, no refund. Plain text, not a
          tinted panel: it is a standing fact about every card on this
          screen, and a box would make it read as a notice about the last
          thing that happened. */}
      <p className="px-1.5 mt-0.5 text-[11.5px] leading-[1.6]" style={{ color: 'var(--portal-faint)' }}>
        Cards are tokenised by Peach Payments — betternow never stores your full card
        number. We verify your card with your bank — no money is taken.
      </p>
    </div>
  );
}

/** When this card was saved. created_at is already on CardRow and already
 *  selected, so this is data the page had and did not show. It uses the
 *  SHARED formatDate (created_at is a TIMESTAMPTZ; the formatter takes
 *  YYYY-MM-DD) rather than a local copy.
 *
 *  It cannot go stale: a card row is never re-pointed at a different card —
 *  adding one inserts a new row. */
function AddedOn({ card }: { card: CardRow }) {
  return <span data-testid="card-added-at">Added {formatDate(card.created_at.slice(0, 10))}</span>;
}

const CARD_SHADOW = '0 2px 8px -3px rgba(15,31,58,.09)';
const CARD_BORDER = '1px solid rgba(19,41,75,.06)';

function Banner({ tone, children }: { tone: 'danger' | 'success'; children: React.ReactNode }) {
  const cfg = tone === 'danger'
    ? { bg: 'rgba(180,35,24,.10)',  border: 'rgba(180,35,24,.25)',  fg: '#B42318' }
    : { bg: 'rgba(21,168,158,.08)', border: 'rgba(21,168,158,.25)', fg: 'var(--portal-accent-ink)' };
  return (
    <div role="status" className="rounded-tile px-4 py-[13px] text-[13px] leading-[1.5]" style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.fg }}>
      {children}
    </div>
  );
}
