'use client';

import { useEffect, useCallback, useState } from 'react';

// ─── ConfirmChargeDialog — assertive bottom-sheet guard ─────────────────
//
// Mobile-first bottom sheet (thumb-reachable Confirm). Used by every
// pay path — per-row Pay-now, plan-level Pay-now, plan-level
// Pay-next-instalment, Settle-entire-bill. A single shared confirm
// keeps "moment of commitment" UX consistent.
//
// Presence (the "this is a decision, not a footer" cues):
//   • Darker scrim (bg-black/60) so the sheet is unmistakably the focus.
//   • Slide-up entry animation on mobile (translate-y-full → 0 on the
//     first frame after mount). Desktop centred dialog skips the slide.
//   • Taller sheet on mobile (max-h ~ 60vh) with the heading positioned
//     in the upper third so the eye lands on the decision, not the
//     bottom edge. Compact stays the same on desktop.

function formatRandCents(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

type Props = {
  open:              boolean;
  /** Plain-language headline e.g. "Pay R425.66 now?" — already includes the amount. */
  headline:          string;
  /** Subtitle e.g. "Your card will be charged immediately." */
  subtitle:          string;
  /** Cents we'll charge — displayed on the confirm button so it matches the headline. */
  amountCents:       number;
  /** True while the action is mid-flight; disables both buttons and shows "Charging…". */
  isPending:         boolean;
  onConfirm:         () => void;
  onCancel:          () => void;
};

export default function ConfirmChargeDialog({
  open,
  headline,
  subtitle,
  amountCents,
  isPending,
  onConfirm,
  onCancel,
}: Props) {
  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape' && !isPending) onCancel(); },
    [onCancel, isPending],
  );

  // Slide-up animation state. When `open` flips true, mount with
  // translate-y-full, then on the next frame transition to translate-y-0.
  // Two rAFs are belt-and-braces against React batching where the first
  // paint can sometimes already have the second style applied. The
  // cleanup resets `entered` on close so re-opening replays the slide
  // (rather than the sheet appearing instantly because it was already
  // at translate-y-0 from the prior open).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
      return () => {
        cancelAnimationFrame(id);
        setEntered(false);
      };
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = '';
    };
  }, [open, handleKey]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="confirm-charge-headline">
      {/* Darker scrim — bg-black/60 (was 40) so the sheet reads as a
          modal decision rather than a footer. Tap-outside dismisses
          unless mid-charge. */}
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${entered ? 'opacity-100' : 'opacity-0'}`}
        onClick={() => { if (!isPending) onCancel(); }}
        aria-hidden
      />
      <div className="absolute inset-0 flex flex-col justify-end md:items-center md:justify-center md:p-6 pointer-events-none">
        <div
          className={[
            // Layout: bottom sheet on mobile (rounded top, full width,
            // tall enough that the heading sits in the upper third);
            // centered card on desktop.
            'relative bg-white w-full md:max-w-sm rounded-t-2xl md:rounded-2xl shadow-2xl pointer-events-auto',
            'min-h-[60vh] md:min-h-0',
            // Slide-up on mobile only — desktop has no transform.
            'transform transition-transform duration-300 ease-out',
            entered ? 'translate-y-0' : 'translate-y-full md:translate-y-0',
          ].join(' ')}
        >
          <div className="px-6 pt-10 pb-4 md:pt-6">
            <h2
              id="confirm-charge-headline"
              className="text-xl md:text-base font-semibold leading-tight"
              style={{ color: '#13294B' }}
            >
              {headline}
            </h2>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">{subtitle}</p>
          </div>
          <div className="px-6 pb-8 md:pb-6 mt-6 md:mt-0 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-lg px-5 py-3 md:py-2 text-base md:text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Charging…' : `Confirm — pay ${formatRandCents(amountCents)}`}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-5 py-3 md:py-2 text-base md:text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
