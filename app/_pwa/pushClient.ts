// ─── Browser-side push helpers ───────────────────────────────────────────
//
// Tiny, framework-free helpers used by both the soft-ask card and the
// settings toggle. Everything here runs in the browser only — callers
// must guard with `typeof window !== 'undefined'` themselves OR use
// these inside a useEffect.
//
// Three things to know:
//
//   1. ALL push paths require the service worker to be registered
//      first. registration() awaits navigator.serviceWorker.ready —
//      a SW that's still installing rejects subscribe() with a
//      DOMException, which would surface as a confusing error.
//
//   2. The browser's permission state and our own server-stored
//      subscription state can diverge:
//        • permission='granted' + no server row = "we lost it, re-subscribe"
//        • permission='granted' + server row    = "fully on"
//        • permission='denied'                  = "user revoked at OS level"
//        • permission='default'                 = "never asked"
//      The settings toggle reads currentPushState() to render honestly.
//
//   3. VAPID public key arrives via NEXT_PUBLIC_VAPID_PUBLIC_KEY env
//      and is converted to the Uint8Array format PushManager.subscribe
//      requires.

export type PushState =
  /** Browser has no push/notification API (e.g. iOS Safari not installed yet). */
  | { kind: 'unsupported' }
  /** Permission is 'default' — we haven't asked. */
  | { kind: 'idle' }
  /** Permission denied at OS level. Toggle should explain how to re-enable. */
  | { kind: 'blocked' }
  /** Permission granted, server subscription present and active. */
  | { kind: 'subscribed'; endpoint: string }
  /** Permission granted but the browser has no active subscription (uninstalled, cleared). */
  | { kind: 'granted-not-subscribed' };

export function pushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return 'serviceWorker'  in navigator
      && 'PushManager'    in window
      && 'Notification'   in window;
}

export async function currentPushState(): Promise<PushState> {
  if (!pushSupported()) return { kind: 'unsupported' };
  const perm = Notification.permission;
  if (perm === 'denied')  return { kind: 'blocked' };
  if (perm === 'default') return { kind: 'idle' };

  // 'granted' — check if we actually have a subscription. The patient
  // may have granted permission previously and then cleared site data;
  // the browser-side subscription is gone, but they're still 'granted'.
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { kind: 'granted-not-subscribed' };
  return { kind: 'subscribed', endpoint: sub.endpoint };
}

function urlBase64ToBufferSource(base64: string): BufferSource {
  // VAPID public keys are base64url. Pad to a multiple of 4 and swap
  // url-safe chars back to standard before atob(). Allocates a fresh
  // ArrayBuffer (not ArrayBufferLike) because the PushManager's
  // applicationServerKey type wants a concrete ArrayBuffer-backed
  // view — recent TS lib.dom updates made that distinction strict.
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const std    = padded.replace(/-/g, '+').replace(/_/g, '/');
  const bin    = atob(std);
  const buf    = new ArrayBuffer(bin.length);
  const view   = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return view;
}

/**
 * Request permission (if not already granted) and subscribe at the
 * browser + server. Returns the resulting state.
 *
 * Throws if VAPID public key is missing or subscribe fails for a
 * reason other than user denial — the caller decides whether to
 * surface the error or just reflect the new state via currentPushState.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return { kind: 'unsupported' };

  // Ask for permission. If permission is already 'granted', this
  // resolves immediately to 'granted' without re-prompting; if it's
  // 'denied', it resolves to 'denied' without re-prompting either —
  // that's a browser-level lock-out we can't undo from JS.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return perm === 'denied' ? { kind: 'blocked' } : { kind: 'idle' };
  }

  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapid) {
    throw new Error('VAPID public key is not configured (NEXT_PUBLIC_VAPID_PUBLIC_KEY).');
  }

  const reg = await navigator.serviceWorker.ready;

  // Re-use an existing subscription if there is one — getSubscription()
  // returns the live one for this browser+origin, otherwise null. We
  // call subscribe() only when there's nothing to reuse, because
  // calling subscribe() while one already exists is a guaranteed
  // InvalidStateError on some browsers.
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToBufferSource(vapid),
    });
  }

  // Persist on our side. If the server can't store it, unsubscribe
  // locally too — we never want a live browser subscription that the
  // server doesn't know about, because the user would get pushes
  // forever once we DO learn about it via some other path.
  const subJson = sub.toJSON();
  const res = await fetch('/api/push/subscribe', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(subJson),
  });
  if (!res.ok) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    throw new Error(`Failed to store subscription (${res.status})`);
  }

  return { kind: 'subscribed', endpoint: sub.endpoint };
}

/**
 * Disable push: unsubscribe the browser AND soft-delete the server row.
 * Idempotent — safe to call when already off.
 */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return { kind: 'unsupported' };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();

  if (sub) {
    // Tell our server first — if the server-side soft-delete fails,
    // we'd rather keep the browser subscription so we don't end up
    // with a live device the user thinks is opted-out.
    try {
      await fetch('/api/push/unsubscribe', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ endpoint: sub.endpoint }),
      });
    } catch {
      // Network glitch — better to leave both states in sync rather
      // than unsubscribe the browser and have the server still
      // think they're subscribed.
      throw new Error('Could not reach the server. Please try again.');
    }
    try { await sub.unsubscribe(); } catch { /* ignore */ }
  }

  return Notification.permission === 'denied' ? { kind: 'blocked' } : { kind: 'idle' };
}
