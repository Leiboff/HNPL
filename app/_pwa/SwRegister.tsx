'use client';

import { useEffect } from 'react';

// ─── SwRegister ──────────────────────────────────────────────────────────
//
// Mounted once from the root layout. Registers /sw.js at root scope and
// then gets out of the way — no UI, no state, no nagging. The SW itself
// (see app/sw.js/route.ts) does skipWaiting + clients.claim so a freshly-
// installed worker takes over on next navigation, which is what makes
// new deploys reach the user promptly.
//
// We do NOT register in dev mode (process.env.NODE_ENV !== 'production'):
// HMR + the SW's caching layer collide badly, and the SW would serve
// stale dev bundles after every code change. Production-only keeps the
// dev experience identical to before.
//
// All work happens inside an effect — never blocks render and never
// runs during SSR. If the runtime lacks serviceWorker support (older
// browsers, in-app webviews that strip it), the whole effect is a
// no-op.

export default function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    // Fire-and-forget. A failure to register the SW is non-fatal —
    // the app continues to work as a normal web app. We log so a
    // genuinely-broken SW doesn't fail silently in production logs.
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        // Nudge an update check on page load. The browser does this
        // automatically every 24h, but a manual call here means a
        // fresh deploy is picked up on the patient's next visit
        // rather than potentially up to a day later.
        reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn('[pwa] service worker registration failed', err && err.message);
      });
  }, []);

  return null;
}
