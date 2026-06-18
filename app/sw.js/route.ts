import { NextResponse } from 'next/server';

// ─── /sw.js — Service Worker ─────────────────────────────────────────────
//
// Served from a route handler (not public/sw.js) so we can stamp a
// build identifier into the response body. Browsers diff the SW body
// byte-by-byte to decide whether to install a new version — if the
// body never changes, deploys never invalidate the cache, and patients
// get served stale HTML/JS forever. The classic PWA bug we're avoiding.
//
// BUILD_ID resolves at MODULE LOAD time (not per request) so the route
// returns identical bytes for the lifetime of a deploy:
//   • On Vercel: VERCEL_GIT_COMMIT_SHA — stable per deploy, changes on push.
//   • Locally:   Date.now() at server boot — bumps on `pnpm dev` restart.
//
// What's cached (and what is deliberately NOT):
//
//   CACHE        STRATEGY              CONTENTS
//   ───────────  ────────────────────  ──────────────────────────────────
//   shell-vN     network-first         HTML navigations (fallback /offline)
//   static-vN    stale-while-revalidate  /_next/static, icons, fonts, css, js
//   (none)       network-only / bypass /api/*, /auth/*, /checkout/*, anything
//                                       non-GET, anything cross-origin
//
// Payment routes (/checkout/[token], /api/webhooks/paystack, /api/push/*)
// are NEVER cached and NEVER replayed offline. An offline user mid-
// checkout sees the clean /offline screen rather than a half-working
// cached form that would lie about whether their card was charged.
//
// Cache invalidation: every deploy gets a fresh CACHE_VERSION, and the
// activate handler deletes any cache whose key doesn't match the
// current generation. skipWaiting + clients.claim mean the new SW
// takes over the page on next navigation rather than waiting for
// every tab to close.

const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
  `dev-${Date.now()}`;

// The SW body. Template-literal'd into the route so BUILD_ID is
// baked at module init. The IIFE / `self` references read naturally
// in a SW runtime — the linter doesn't know that, hence the explicit
// quoting so this file remains lintable as plain server code.
const SW_BODY = String.raw`
'use strict';

// ─── Build identity (used as cache-name suffix) ────────────────────────
const BUILD_ID = '__BUILD_ID__';
const SHELL_CACHE  = 'betternow-shell-'  + BUILD_ID;
const STATIC_CACHE = 'betternow-static-' + BUILD_ID;

// What's pre-cached on install. Tiny on purpose — the offline page is
// the load-bearing one; everything else can be cached on first fetch.
const SHELL_PRECACHE = [
  '/offline',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
];

// Paths the SW MUST NOT touch — always go straight to the network,
// never cache the response. Payment + auth + push subscription
// surfaces, and the webhook endpoint Paystack hits server-side.
const BYPASS_PREFIXES = [
  '/api/',
  '/checkout/',
  '/auth/',
  '/login',
  '/verify-email',
];

function isBypassed(url) {
  return BYPASS_PREFIXES.some(p => url.pathname.startsWith(p));
}

function isStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/')
      || url.pathname.startsWith('/_next/image')
      || url.pathname.match(/\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|ico)$/);
}

// ─── install ───────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  // skipWaiting so a newly-installed SW becomes active immediately
  // rather than waiting for all tabs to close. Combined with
  // clients.claim() in activate, this means a fresh deploy reaches
  // the user on their NEXT page navigation, not whenever they happen
  // to fully close the app.
  self.skipWaiting();

  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_PRECACHE))
      .catch((err) => {
        // Best-effort pre-cache. If the offline page can't be cached
        // (e.g. cold-deploy race), the runtime catch in fetch() still
        // returns SOMETHING for the navigation; nothing is fatal here.
        console.warn('[sw] pre-cache failed', err && err.message);
      }),
  );
});

// ─── activate ──────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache that doesn't match the current build.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n !== SHELL_CACHE && n !== STATIC_CACHE)
        .map(n => caches.delete(n)),
    );
    // Take control of any open tabs without a reload.
    await self.clients.claim();
  })());
});

// ─── fetch ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Non-GET (POST forms, the push subscribe call, etc.) — passthrough.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (Paystack, Supabase realtime, Resend, etc.) — pass.
  if (url.origin !== self.location.origin) return;

  // Payment + auth + push surfaces — never cache, never replay.
  if (isBypassed(url)) return;

  // Navigation requests (HTML pages): network-first, fall back to the
  // pre-cached offline page if the network is unavailable. We do NOT
  // serve a cached HTML page that may be stale — the offline page is
  // an explicit "you're offline" state, not a frozen snapshot of a
  // dashboard. That's deliberate: a patient's plan status, payment
  // schedule, etc. must reflect server truth or say "I can't load".
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match('/offline');
        if (cached) return cached;
        // Last-resort minimal HTML if pre-cache failed.
        return new Response(
          '<!doctype html><meta charset=utf-8><title>Offline</title><p>You are offline.',
          { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate. Serve from cache (fast),
  // refresh in the background. New build = new cache key (see
  // BUILD_ID above) so a stale asset can only outlive one navigation
  // before the new SW activates and the old cache is wiped.
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      const networkPromise = fetch(req).then((res) => {
        // Only cache successful, opaque-safe responses.
        if (res && res.status === 200 && res.type !== 'opaque') {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);
      return cached ?? (await networkPromise) ?? new Response('', { status: 504 });
    })());
    return;
  }

  // Anything else falls through to the network — including dynamic
  // page data fetches we don't recognise. Safe default.
});

// ─── push ──────────────────────────────────────────────────────────────
//
// Triggered when our backend sends a Web Push. The payload is JSON we
// send from lib/notifications/sendPush.ts. Layout:
//   { title, body, url?, tag? }
//
// We use tag to dedupe — a fresh "payment collected" replaces the
// previous one for the same plan, so the patient never sees a stack
// of identical notifications if the webhook redelivers.

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'BetterNow', body: event.data.text() };
  }
  const title = payload.title || 'BetterNow';
  const options = {
    body:    payload.body || '',
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    tag:     payload.tag,
    data:    { url: payload.url || '/patient' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── notificationclick ────────────────────────────────────────────────
//
// Focus the patient portal tab if one is open, otherwise open it.
// The URL the notification embeds (payload.url) wins over the default.

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/patient';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      const u = new URL(client.url);
      if (u.origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) await client.navigate(url);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
`.replace('__BUILD_ID__', BUILD_ID);

export async function GET() {
  return new NextResponse(SW_BODY, {
    status: 200,
    headers: {
      // SW files MUST be served as JavaScript MIME.
      'Content-Type':           'application/javascript; charset=utf-8',
      // Allow the SW to control the whole origin (not just /sw.js).
      'Service-Worker-Allowed': '/',
      // Don't let CDNs serve a cached SW response across deploys —
      // the body is build-stamped, but the URL is stable; we rely on
      // the browser's own SW update check (24h max, or on navigation)
      // to pick up changes, and we don't want a CDN sitting in the
      // middle returning yesterday's body.
      'Cache-Control':           'no-cache, no-store, must-revalidate',
    },
  });
}
