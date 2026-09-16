'use client';

import { useEffect, useState } from 'react';
import { usePasskeys } from '@/lib/hooks/usePasskeys';
import { useInstallPrompt } from '@/app/_pwa/useInstallPrompt';
import { pushSupported, currentPushState } from '@/app/_pwa/pushClient';
import ActionCentreSheet from './ActionCentreSheet';

// ─── ActionCentreBell — header bell that opens the sheet ─────────────
//
// Replaces the "Log out" button in the patient header. Renders a bell
// icon with a small red dot when at least one action-centre item is
// still pending (push not enabled OR passkey not enrolled OR the
// install-prompt is available). Completed items don't count toward
// the badge.

export default function ActionCentreBell({ onDark = false }: { onDark?: boolean }) {
  const [open, setOpen] = useState(false);

  const { passkeys, loading: pkLoading, supported: pkSupported } = usePasskeys();
  const { state: installState } = useInstallPrompt();

  const [pushPending, setPushPending] = useState(false);
  useEffect(() => {
    if (!pushSupported()) return;
    let cancelled = false;
    void (async () => {
      const state = await currentPushState();
      if (cancelled) return;
      setPushPending(state.kind === 'idle');
    })();
    return () => { cancelled = true; };
  }, []);

  const passkeyPending = pkSupported && !pkLoading && passkeys.length === 0;
  const installPending = installState === 'android' || installState === 'ios';

  const hasPending = pushPending || passkeyPending || installPending;

  return (
    <>
      <button
        type="button"
        aria-label={hasPending ? 'Notifications — you have new items' : 'Notifications'}
        onClick={() => setOpen(true)}
        data-testid="action-centre-bell"
        className={
          onDark
            ? 'relative flex items-center justify-center w-[38px] h-[38px] rounded-full text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
            : 'relative rounded-lg p-2 text-gray-700 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--portal-accent)]/60'
        }
        style={onDark ? { background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.14)' } : undefined}
      >
        <svg width={onDark ? 17 : 22} height={onDark ? 17 : 22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={onDark ? 1.8 : 1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {hasPending && (
          <span
            data-testid="action-centre-bell-dot"
            className={
              onDark
                ? 'absolute top-[8px] right-[9px] block w-[7px] h-[7px] rounded-full'
                : 'absolute top-1.5 right-1.5 block w-2 h-2 rounded-full bg-red-500 ring-2 ring-white'
            }
            // Teal, not red: an unread item is something to look at, not
            // something that has gone wrong. Red on this bell read as an
            // alert next to an overdue amount that IS one. The 2px navy
            // ring is what separates the dot from the bell's own stroke.
            // A box-shadow ring rather than a border, so the dot stays 7px
            // of teal instead of 3px inside a 2px frame (border-box).
            style={onDark ? { background: 'var(--brand-teal-bright)', boxShadow: '0 0 0 2px var(--brand-navy-deep)' } : undefined}
            aria-hidden
          />
        )}
      </button>
      <ActionCentreSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
