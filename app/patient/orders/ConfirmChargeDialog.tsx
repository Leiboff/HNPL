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

export type ChargeLine = {
  label:       string;
  amountCents: number;
  /** Renders the figure in danger red. Reserved for a NON-ZERO late fee. */
  danger?:     boolean;
};

type Props = {
  open:              boolean;
  /**
   * Plain-language headline e.g. "Pay R425.66 now?" — already includes the
   * amount. It is the dialog's ACCESSIBLE NAME: visually the amount leads
   * on its own line, but a screen-reader user needs the whole question in
   * one utterance when the dialog opens, not a bare figure.
   */
  headline:          string;
  /** Subtitle e.g. "Your card will be charged immediately." */
  subtitle:          string;
  /** Cents we'll charge — displayed on the confirm button so it matches the headline. */
  amountCents:       number;
  /** Small uppercase label above the figure. Defaults to "Pay now". */
  eyebrow?:          string;
  /**
   * What the total is made of. Rendered only when there is more than one
   * line — a single row restating the total it sits under is noise. The
   * point of it is the late fee: a patient settling a failed collection is
   * being charged more than the instalment, and this is where the app owes
   * them that number rather than a total they have to reconcile themselves.
   */
  breakdown?:        ChargeLine[];
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
  eyebrow = 'Pay now',
  breakdown,
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
        className={`absolute inset-0 transition-opacity duration-300 ${entered ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: 'rgba(7,16,31,.45)' }}
        onClick={() => { if (!isPending) onCancel(); }}
        aria-hidden
      />
      <div className="absolute inset-0 flex flex-col justify-end md:items-center md:justify-center md:p-6 pointer-events-none">
        <div
          className={[
            // Layout: bottom sheet on mobile (rounded top, full width,
            // tall enough that the heading sits in the upper third);
            // centered card on desktop.
            'bn-app relative bg-white w-full md:max-w-sm rounded-t-[26px] md:rounded-card shadow-2xl pointer-events-auto',
            'min-h-[60vh] md:min-h-0',
            // Slide-up on mobile only — desktop has no transform.
            'transform transition-transform duration-300 ease-out',
            entered ? 'translate-y-0' : 'translate-y-full md:translate-y-0',
          ].join(' ')}
        >
          {/* Grab handle — the same 38×4 mark every sheet in the portal
              carries, so a sheet is recognisable as a sheet before its
              content is read. */}
          <div className="md:hidden w-[38px] h-1 rounded-full mx-auto mt-[10px]" style={{ background: 'var(--portal-line-soft)' }} aria-hidden />

          <div className="px-6 pt-8 md:pt-6 text-center">
            {/* The amount leads. This is the one screen in the app whose
                entire job is a single number — how much is about to leave
                the account — so it is set at display size and centred, and
                the question is carried by the eyebrow above it and the
                button below. `headline` stays as the dialog's accessible
                name for anyone who cannot see that arrangement. */}
            <h2 id="confirm-charge-headline" className="sr-only">{headline}</h2>
            <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.18em', color: 'var(--portal-faint)' }}>
              {eyebrow}
            </p>
            <p
              className="mt-3 font-bold tabular-nums"
              style={{ fontSize: 52, lineHeight: 1, letterSpacing: '-.045em', color: 'var(--portal-ink)' }}
            >
              {formatRandCents(amountCents)}
            </p>
            <p className="mt-[11px] text-[13.5px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>{subtitle}</p>
          </div>

          {breakdown && breakdown.length > 1 && (
            <div className="px-6 pt-6 flex flex-col gap-3">
              {breakdown.map((line) => (
                <div key={line.label} className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px]" style={{ color: 'var(--portal-muted)' }}>{line.label}</span>
                  <span
                    className="text-[13.5px] font-semibold tabular-nums"
                    style={{ color: line.danger ? '#B42318' : 'var(--portal-ink)' }}
                  >
                    {formatRandCents(line.amountCents)}
                  </span>
                </div>
              ))}
              <div className="h-px" style={{ background: 'var(--portal-hairline)' }} />
            </div>
          )}

          <div className="px-6 pb-8 md:pb-6 pt-6 flex flex-col gap-[10px]">
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="bn-btn-teal rounded-tile py-4 text-[15px] font-semibold text-white disabled:opacity-50"
            >
              {isPending ? 'Charging…' : `Pay ${formatRandCents(amountCents)}`}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="py-2 text-[13.5px] font-semibold disabled:opacity-50"
              style={{ color: 'var(--portal-muted)' }}
            >
              Cancel
            </button>
            <p className="text-center text-[11.5px]" style={{ color: 'var(--portal-faint)' }}>
              Secured by Peach Payments · 3-D Secure
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
