'use client';

import { useCallback, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

// ─── BottomSheet — the portal's one sheet ────────────────────────────────
//
// Four sheets used to exist in this app and no two of them looked alike:
// the action centre was a right-hand panel on desktop with a sticky header
// and an × button, the install prompt was a rounded toast, the passkey
// prompt was a full-screen card, and the push soft-ask was a bar. They also
// behaved differently — some closed on Escape, some did not; none closed on
// navigation. A patient who opened the action centre, tapped through to a
// plan and came back found it still sitting there over the new screen.
//
// This is the shared shell. Everything about the CHROME lives here — the
// scrim, the travel, the grab handle, the title row, the padding — so a
// fifth sheet cannot arrive with a fifth set of manners.
//
// Three ways to close, and all three are required:
//   • the Close button — the obvious one;
//   • the scrim — the one people actually reach for on a phone;
//   • ANY navigation — because a sheet is about the screen it opened over.
//     Route changes here come from links inside the sheet and from the
//     bottom nav, neither of which knows the sheet exists, so the sheet
//     watches the pathname itself rather than asking them to.
//
// Escape closes it too, and the body scroll-locks while it is open — a
// sheet that lets the page scroll underneath reads as a floating card
// rather than as a layer.

export default function BottomSheet({
  open,
  onClose,
  title,
  blurb,
  children,
  footer,
  label,
  testid,
}: {
  open:      boolean;
  onClose:   () => void;
  title:     string;
  blurb?:    string;
  children:  React.ReactNode;
  /** A CTA under the items. Usually the navy button; omit for a sheet
   *  that is only telling you things (the action centre). */
  footer?:   React.ReactNode;
  /** Accessible name when it should differ from the visible title. */
  label?:    string;
  testid?:   string;
}) {
  const pathname = usePathname();

  const onKey = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }, [onClose]);

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onKey]);

  // Close on navigation — on an ACTUAL route change, never on mount.
  //
  // The first version of this guarded on `open` alone and assumed that was
  // enough, because a closed sheet closing again is a no-op. It is not:
  // every caller mounts this component only once it is already open, so
  // the mount-time effect ran with open === true and fired onClose
  // immediately. The action centre shut the instant the bell opened it,
  // the install sheet wrote a PERMANENT dismissal to localStorage, and the
  // passkey prompt called its skip server action — each without the
  // patient touching anything.
  //
  // So the comparison has to be against the previous pathname, not against
  // open. The ref is seeded at mount, which is what makes the first run a
  // no-op, and is updated on every real transition so navigating away and
  // back still closes.
  const prevPath = useRef(pathname);
  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    if (open) onClose();
  }, [pathname, open, onClose]);

  if (!open) return null;

  return (
    <div className="bn-app fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={label ?? title}>
      <div
        className="bn-scrim absolute inset-0"
        style={{ background: 'rgba(7,16,31,.45)' }}
        onClick={onClose}
        aria-hidden
      />
      <div className="absolute inset-0 flex flex-col justify-end pointer-events-none">
        <div
          className="bn-sheet relative bg-white w-full md:max-w-md md:mx-auto max-h-[88vh] overflow-y-auto pointer-events-auto"
          style={{
            borderRadius: '26px 26px 0 0',
            padding: '20px 18px calc(34px + env(safe-area-inset-bottom))',
            boxShadow: '0 -14px 40px -12px rgba(7,16,31,.4)',
          }}
          data-testid={testid}
        >
          {/* The grab handle is decorative — the sheet is not draggable —
              but it is the mark that says "this came up from the bottom
              edge and goes back down", which is what stops a phone user
              hunting for a close control. The real controls are the
              Close button and the scrim. */}
          <div className="w-[38px] h-1 rounded-full mx-auto mb-4" style={{ background: 'var(--portal-line-soft)' }} aria-hidden />

          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[17px] font-semibold" style={{ color: 'var(--portal-ink)' }}>{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="flex-none text-[13px] font-semibold"
              style={{ color: 'var(--portal-accent-ink)' }}
            >
              Close
            </button>
          </div>

          {blurb && (
            <p className="mt-[7px] text-[13px] leading-[1.6]" style={{ color: 'var(--portal-muted)' }}>{blurb}</p>
          )}

          <div className="mt-4 flex flex-col gap-[10px]">{children}</div>

          {footer && <div className="mt-4">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

// ─── SheetRow — one item inside a sheet ──────────────────────────────────
//
// Icon tile, title, body, and an optional right-aligned aside (an age, a
// state). Three tones, and they mean something rather than decorating:
// amber is waiting on the patient, teal is done or good news, neutral is
// everything else.

export type SheetTone = 'neutral' | 'teal' | 'amber';

const TONE: Record<SheetTone, { bg: string; border: string; dotBg: string; dotFg: string }> = {
  neutral: { bg: 'var(--portal-wash)',     border: 'var(--portal-hairline)', dotBg: 'rgba(19,41,75,.05)',  dotFg: 'var(--portal-ink)' },
  teal:    { bg: 'rgba(21,168,158,.07)',   border: 'rgba(21,168,158,.2)',    dotBg: 'rgba(21,168,158,.14)', dotFg: 'var(--portal-accent-ink)' },
  amber:   { bg: 'rgba(245,158,11,.07)',   border: '#F5D49A',                dotBg: 'rgba(245,158,11,.16)', dotFg: '#B45309' },
};

export function SheetRow({
  tone = 'neutral',
  icon,
  title,
  body,
  aside,
  error,
  action,
  testid,
}: {
  tone?:  SheetTone;
  icon:   React.ReactNode;
  title:  string;
  body:   string;
  aside?: React.ReactNode;
  error?: string | null;
  action?: { label: string; onClick: () => void; busy: boolean } | null;
  testid?: string;
}) {
  const t = TONE[tone];
  return (
    <div
      data-testid={testid}
      className="flex items-start gap-3 rounded-tile p-[14px]"
      style={{ background: t.bg, border: `1px solid ${t.border}` }}
    >
      <span
        className="flex-none w-[30px] h-[30px] rounded-chip flex items-center justify-center"
        style={{ background: t.dotBg, color: t.dotFg }}
        aria-hidden
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-semibold" style={{ color: 'var(--portal-ink)' }}>{title}</p>
        <p className="mt-[3px] text-[12.5px] leading-[1.5]" style={{ color: 'var(--portal-muted)' }}>{body}</p>
        {error && <p role="alert" className="mt-1.5 text-[12.5px]" style={{ color: '#B42318' }}>{error}</p>}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.busy}
            className="bn-btn-teal mt-2.5 rounded-chip px-3 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60"
          >
            {action.label}
          </button>
        )}
      </div>
      {/* The right-hand aside: an age ("2h"), a state ("On"), or a done
          mark. A node rather than a string, so a sheet can put its own
          glyph here instead of this component growing a variant per
          sheet. */}
      {aside && (
        <span className="flex-none flex items-center gap-1 text-[11.5px]" style={{ color: 'var(--portal-faint)' }}>{aside}</span>
      )}
    </div>
  );
}
