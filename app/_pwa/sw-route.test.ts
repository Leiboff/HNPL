import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /sw.js source-text regression ───────────────────────────────────────
//
// The service worker is too unwieldy to runtime-test from vitest (it
// needs a service-worker global, a registration, a navigator). What
// we CAN do is pin its source text — the load-bearing properties of
// the route handler and the inlined SW body. A refactor that drops
// any of these would silently regress the PWA:
//
//   • The handler returns a build-stamped SW body — different per
//     deploy so the browser fetches a new worker. The classic
//     "PWA serves stale JS forever after deploy" bug is exactly
//     what stamping prevents.
//   • The SW pre-caches /offline so the navigation fallback works
//     when the device is offline.
//   • The SW bypasses /api/, /checkout/, /auth/ entirely — payment
//     flows are never cached or replayed.
//   • skipWaiting + clients.claim so a fresh deploy takes over on
//     next navigation, not whenever the patient happens to close
//     all tabs.
//   • Response headers: application/javascript MIME, Service-Worker-
//     Allowed root scope, no-cache so a CDN doesn't serve yesterday's
//     SW body.

const ROOT = resolve(process.cwd());
const SW_ROUTE = readFileSync(resolve(ROOT, 'app/sw.js/route.ts'), 'utf8');

describe('SW route handler', () => {
  it('build-stamps the SW body so every deploy invalidates the worker', () => {
    // The body contains a __BUILD_ID__ placeholder that's replaced with
    // a per-deploy identifier. Without this, the route would always
    // return identical bytes and the browser would never update.
    expect(SW_ROUTE).toMatch(/__BUILD_ID__/);
    expect(SW_ROUTE).toMatch(/VERCEL_GIT_COMMIT_SHA/);
  });

  it('emits the response with the right MIME + scope + no-cache headers', () => {
    expect(SW_ROUTE).toMatch(/Content-Type[\s\S]*?application\/javascript/);
    expect(SW_ROUTE).toMatch(/Service-Worker-Allowed[\s\S]*?['"]\/['"]/);
    expect(SW_ROUTE).toMatch(/Cache-Control[\s\S]*?no-cache/);
  });
});

describe('SW body — caching contract', () => {
  it('pre-caches the /offline page (the on-brand offline fallback)', () => {
    expect(SW_ROUTE).toMatch(/'\/offline'/);
  });

  it('bypasses every payment / auth / push surface', () => {
    // The BYPASS_PREFIXES list is the load-bearing safety net for
    // "no cached half-charged checkout". Each entry below MUST be
    // present — losing /api would be the worst regression.
    expect(SW_ROUTE).toMatch(/'\/api\/'/);
    expect(SW_ROUTE).toMatch(/'\/checkout\/'/);
    expect(SW_ROUTE).toMatch(/'\/auth\/'/);
  });

  it('skips POSTs entirely (subscribe / unsubscribe / form actions)', () => {
    expect(SW_ROUTE).toMatch(/req\.method !== ['"]GET['"]/);
  });

  it('uses skipWaiting + clients.claim so deploys reach the user promptly', () => {
    expect(SW_ROUTE).toMatch(/self\.skipWaiting\(\)/);
    expect(SW_ROUTE).toMatch(/self\.clients\.claim\(\)/);
  });

  it('navigation fallback serves the pre-cached /offline page on network failure', () => {
    expect(SW_ROUTE).toMatch(/req\.mode === ['"]navigate['"]/);
    expect(SW_ROUTE).toMatch(/cache\.match\(['"]\/offline['"]\)/);
  });

  it('activate handler deletes caches that do not match the current build', () => {
    // The whole point of stamping cache names with BUILD_ID: a new
    // build = new cache name = old caches purged on activate.
    expect(SW_ROUTE).toMatch(/caches\.delete/);
  });

  it('registers push + notificationclick listeners (the OS toast pathway)', () => {
    expect(SW_ROUTE).toMatch(/addEventListener\(['"]push['"]/);
    expect(SW_ROUTE).toMatch(/addEventListener\(['"]notificationclick['"]/);
  });
});
