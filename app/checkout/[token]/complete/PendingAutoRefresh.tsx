'use client';

import { useEffect } from 'react';

// ─── PendingAutoRefresh — poll the V2 status while it's PENDING ────────
//
// A pending Peach result (000.200.* / 100.400.500 / 800.400.5xx) is a
// genuine "still processing" state, NOT a decline. Rather than leaving
// the patient on a dead card telling them to refresh manually, we reload
// the completion page after a short delay — each reload re-runs the
// server-side getCheckoutStatus, so the moment Peach settles the result
// (or the webhook flips the rows) the page advances to /done or the
// success state on its own. The webhook remains the backstop.
//
// Bounded by `maxReloads` so a genuinely stuck pending doesn't loop
// forever — after the cap we simply stop; the "check your email" copy
// and the webhook cover the tail.

const RELOAD_DELAY_MS = 5000;
const RELOAD_COUNT_PARAM = 'p';
const MAX_RELOADS = 6; // ~30s of polling before we stop and rest on the webhook

export default function PendingAutoRefresh() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const count = Number(url.searchParams.get(RELOAD_COUNT_PARAM) ?? '0') || 0;
    if (count >= MAX_RELOADS) return;

    const timer = setTimeout(() => {
      url.searchParams.set(RELOAD_COUNT_PARAM, String(count + 1));
      window.location.replace(url.toString());
    }, RELOAD_DELAY_MS);

    return () => clearTimeout(timer);
  }, []);

  return null;
}
