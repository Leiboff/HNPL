'use client';

import { useEffect, useState } from 'react';
import { pushSupported, currentPushState, enablePush } from './pushClient';

// ─── PushSoftAsk ─────────────────────────────────────────────────────────
//
// The "would you like reminders?" card that appears on the patient
// portal AFTER they have an active plan. The browser's
// Notification.requestPermission() prompt is the harshest UX in the
// platform — asking on cold load is the antipattern. Instead:
//
//   1. We surface this card only when there's something to remind them
//      about (caller controls visibility via the `enabled` prop —
//      typically `hasActivePlan`).
//   2. The card explains in plain English what we'd send BEFORE the
//      browser ever shows its prompt.
//   3. Only when the patient clicks "Turn on reminders" do we call
//      Notification.requestPermission(), which then triggers the
//      browser prompt — a clear "yes I want this" gesture means a
//      ~10× higher accept rate than instant-prompt.
//   4. Dismissal sticks (localStorage) so we don't re-ask. The patient
//      can still turn it on later via the settings toggle on /profile.
//
// What this component will NOT do:
//   • Auto-prompt on mount.
//   • Reappear after dismissal.
//   • Show if permission is already granted/denied (the toggle
//     handles those states).

const LS_KEY = 'hnpl_push_softask_dismissed';

type Props = {
  /** Drive from the parent: only show if the patient has an active plan. */
  enabled: boolean;
};

export default function PushSoftAsk({ enabled }: Props) {
  const [visible, setVisible] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!pushSupported()) return;
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(LS_KEY) === '1') return;

    // Check state asynchronously — only show the card when permission
    // is still 'default'. If it's already granted/denied (or browser
    // doesn't support push), the toggle on /profile is the right
    // surface, not this soft-ask.
    let cancelled = false;
    (async () => {
      const state = await currentPushState();
      if (cancelled) return;
      if (state.kind === 'idle') setVisible(true);
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  function dismiss() {
    try { localStorage.setItem(LS_KEY, '1'); } catch { /* private mode */ }
    setVisible(false);
  }

  async function turnOn() {
    setErr(null);
    setBusy(true);
    try {
      const next = await enablePush();
      if (next.kind === 'subscribed') {
        // Done — hide. We also flag dismissed so a "granted then
        // revoked then granted again" loop wouldn't re-summon the
        // card; the toggle in profile is the right place after that.
        try { localStorage.setItem(LS_KEY, '1'); } catch { /* private mode */ }
        setVisible(false);
      } else if (next.kind === 'blocked') {
        setErr('Notifications are blocked. You can turn them on in your browser settings.');
      } else {
        // 'idle' = user dismissed the OS prompt. Leave the card
        // visible so they can try again, or X out.
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Turn on payment reminders"
      className="rounded-2xl border border-[#E5E9F0] bg-white p-5 sm:p-6 shadow-[0_1px_2px_rgba(15,31,58,0.04)]"
    >
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl bg-[radial-gradient(circle_at_30%_25%,#15A89E22,#13294B14_70%)] ring-1 ring-[#13294B]/10 flex items-center justify-center shrink-0 text-[#13294B]">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path d="M6 9a6 6 0 0 1 12 0v4l1.5 2H4.5L6 13V9Z" strokeLinejoin="round" />
            <path d="M10 18a2 2 0 0 0 4 0" strokeLinecap="round" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-[#0F1F3A]">
            Turn on payment reminders
          </h3>
          <p className="mt-1 text-sm text-[#3A4B66]">
            We&apos;ll let you know the day before each instalment, when a payment lands,
            and if something needs your attention. That&apos;s it — no marketing.
          </p>

          {err && (
            <p className="mt-3 text-xs text-[#8A1F1F]">{err}</p>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={turnOn}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm font-semibold text-white focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/30 transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 140%)' }}
            >
              {busy ? 'Turning on…' : 'Turn on reminders'}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="text-sm font-medium text-[#7A8AA0] hover:text-[#3A4B66]"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
