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

export default function ActionCentreBell() {
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
        className="relative rounded-lg p-2 text-gray-700 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E]/60"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {hasPending && (
          <span
            data-testid="action-centre-bell-dot"
            className="absolute top-1.5 right-1.5 block w-2 h-2 rounded-full bg-red-500 ring-2 ring-white"
            aria-hidden
          />
        )}
      </button>
      <ActionCentreSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
