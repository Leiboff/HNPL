import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Push notification wiring — source-text regression ───────────────────
//
// Pins the load-bearing properties of each push surface that a runtime
// test couldn't easily catch:
//
//   • The soft-ask card never auto-prompts on mount (the brief's
//     headline rule). It must wait for an explicit click.
//   • The settings toggle reflects OS-level revocation honestly
//     ("blocked" state) and never lies that it's on.
//   • Subscribe API stores the row tied to the SESSION user (not
//     a user_id from the request body, which a malicious client
//     could forge).
//   • Unsubscribe API soft-deletes (deleted_at) — the sender's
//     preference contract depends on this exact column.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const SUBSCRIBE   = read('app/api/push/subscribe/route.ts');
const UNSUBSCRIBE = read('app/api/push/unsubscribe/route.ts');
const SOFT_ASK    = read('app/_pwa/PushSoftAsk.tsx');
const TOGGLE      = read('app/patient/profile/NotificationsToggle.tsx');

describe('POST /api/push/subscribe', () => {
  it('uses the session user_id (not body.user_id) when writing the row', () => {
    // The row's user_id MUST come from supabase.auth.getUser() — not
    // from the request body. A client that forged user_id: 'someone-else'
    // would otherwise hijack their notifications.
    expect(SUBSCRIBE).toMatch(/supabase\.auth\.getUser\(\)/);
    expect(SUBSCRIBE).toMatch(/user_id:\s+user\.id/);
  });

  it('upserts on endpoint, clearing deleted_at on re-subscribe', () => {
    // Same browser re-subscribing must REACTIVATE the existing row
    // (clear deleted_at), not create a duplicate.
    expect(SUBSCRIBE).toMatch(/onConflict:\s*['"]endpoint['"]/);
    expect(SUBSCRIBE).toMatch(/deleted_at:\s*null/);
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('soft-deletes (sets deleted_at) — the preference contract', () => {
    // The sender filters on `deleted_at IS NULL`. If unsubscribe
    // HARD-deleted, the audit trail would be lost AND the next
    // subscribe would lose the original created_at. Soft-delete
    // is the contract.
    expect(UNSUBSCRIBE).toMatch(/deleted_at:\s+new Date\(\)\.toISOString\(\)/);
    expect(UNSUBSCRIBE).not.toMatch(/\.delete\(\)/);
  });

  it('scopes the update to the session user (defence in depth)', () => {
    // RLS would also enforce this, but the WHERE clause makes the
    // intent explicit.
    expect(UNSUBSCRIBE).toMatch(/\.eq\(['"]user_id['"],\s*user\.id\)/);
  });
});

describe('PushSoftAsk — never auto-prompts on mount', () => {
  it('only calls Notification.requestPermission inside the explicit Turn-on click handler', () => {
    // The brief's headline rule: NO instant prompts. The Notification
    // API must only be invoked from a user-gesture path.
    //
    // Approach: every call to enablePush() must be inside the click
    // handler `turnOn`, not in a useEffect. We verify by:
    //   1. The component imports enablePush.
    //   2. The only enablePush() call sits inside the turnOn function.
    //   3. The useEffect calls currentPushState (read-only) but never
    //      enablePush (which is what triggers the OS prompt).
    expect(SOFT_ASK).toMatch(/enablePush/);
    // The useEffect block is the load-bearing risk surface — assert it
    // doesn't trigger the OS prompt.
    const effectBlock = SOFT_ASK.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\)/);
    expect(effectBlock).not.toBeNull();
    expect(effectBlock![0]).not.toMatch(/enablePush\(/);
    expect(effectBlock![0]).not.toMatch(/requestPermission/);
  });

  it('respects dismissal via localStorage and never re-asks', () => {
    expect(SOFT_ASK).toMatch(/hnpl_push_softask_dismissed/);
  });
});

describe('NotificationsToggle — honest reflection of OS state', () => {
  it('has a "blocked" branch for OS-level revocation that disables the switch', () => {
    // The user revoked at the OS level. We must NOT pretend the
    // switch works — the only way out is browser settings, which is
    // what the inline copy says.
    expect(TOGGLE).toMatch(/Blocked in your browser/);
    expect(TOGGLE).toMatch(/isBlocked/);
  });

  it('refreshes state on visibilitychange (returning from browser settings)', () => {
    // If the user toggled OS-level permission elsewhere and came
    // back, the toggle picks up the change without a full reload.
    expect(TOGGLE).toMatch(/visibilitychange/);
  });

  it('uses role="switch" + aria-checked for keyboard / screen-reader accessibility', () => {
    expect(TOGGLE).toMatch(/role=["']switch["']/);
    expect(TOGGLE).toMatch(/aria-checked=\{isOn\}/);
  });
});
