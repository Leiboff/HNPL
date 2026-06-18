// ─── sendPushToUser ──────────────────────────────────────────────────────
//
// Server-side fan-out: given a user_id and a notification payload, look
// up every active push_subscriptions row for that user and deliver via
// the Web Push protocol. Used by the Paystack webhook and any future
// cron job that wants to notify the patient about a payment event.
//
// The patient's "notifications on / off" preference is encoded by the
// presence of an active (deleted_at IS NULL) row — turn off in the
// settings toggle = the row is soft-deleted = this function returns
// without sending. That's the sole gate. No second column to drift.
//
// Failure handling:
//   • 410 Gone / 404 Not Found → the subscription is dead (patient
//     uninstalled the app, browser data cleared, OS revoked). Soft-
//     delete the row so we don't waste a roundtrip next time.
//   • 5xx / network → log, don't propagate. Notifications are
//     informational — they must NEVER fail the originating webhook
//     or cron run. The caller wraps this in try/catch out of habit
//     but even an uncaught throw here is non-fatal upstream.
//
// VAPID keys come from env. Missing keys = silent no-op + a single
// warning per cold start so dev mode doesn't spam logs.

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

export type PushPayload = {
  /** Required — appears as the bold first line on the OS toast. */
  title: string;
  /** Required — the body line. Keep < ~100 chars for iOS / Android. */
  body:  string;
  /** Where to navigate when the user taps the notification. */
  url?:  string;
  /**
   * Deduplication key. A second push with the same tag REPLACES the
   * earlier one in the OS notification tray rather than stacking.
   * Use something like `payment:${planId}:collected:${instalmentNumber}`
   * so a redelivered webhook doesn't pile up identical toasts.
   */
  tag?:  string;
};

type SubRow = {
  id:        string;
  endpoint:  string;
  p256dh:    string;
  auth:      string;
};

let vapidConfigured = false;
let vapidWarned     = false;

function configureVapidIfNeeded(): boolean {
  if (vapidConfigured) return true;

  const pub  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subj) {
    if (!vapidWarned) {
      vapidWarned = true;
      console.warn(
        '[push] VAPID keys missing — set NEXT_PUBLIC_VAPID_PUBLIC_KEY, '
        + 'VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:… or https://…) to send pushes',
      );
    }
    return false;
  }
  webpush.setVapidDetails(subj, pub, priv);
  vapidConfigured = true;
  return true;
}

function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type PushSendResult = {
  /** Subscriptions found for this user (active only). */
  total:    number;
  /** Successful deliveries (HTTP 2xx). */
  sent:     number;
  /** Subscriptions retired during this send (HTTP 404 / 410). */
  retired:  number;
  /** Transient failures (5xx / network). The subs stay active. */
  failed:   number;
};

export async function sendPushToUser(
  userId:  string,
  payload: PushPayload,
): Promise<PushSendResult> {
  const result: PushSendResult = { total: 0, sent: 0, retired: 0, failed: 0 };

  if (!configureVapidIfNeeded()) return result;

  const svc = createServiceClient();

  // The patient's preference IS the existence of an active row.
  // deleted_at IS NULL filters out the rows the in-app toggle has
  // marked as opted-out. No additional preference column is read here
  // because no such column exists, by design.
  const { data: subs, error } = await svc
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId)
    .is('deleted_at', null);

  if (error) {
    console.error('[push] failed to load subscriptions', { userId, error: error.message });
    return result;
  }

  const rows = (subs ?? []) as SubRow[];
  result.total = rows.length;
  if (rows.length === 0) return result;

  const body = JSON.stringify(payload);
  const nowIso = new Date().toISOString();

  // Fan out in parallel. Each send is independent; one failure must
  // not block another patient device receiving the same payload.
  await Promise.all(rows.map(async (sub) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
      );
      result.sent += 1;
    } catch (err) {
      // web-push throws an object with a `statusCode`. Treat 404 and
      // 410 as a permanent "this subscription is dead" — soft-delete.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await svc
          .from('push_subscriptions')
          .update({ deleted_at: nowIso })
          .eq('id', sub.id);
        result.retired += 1;
        return;
      }
      // Transient — leave the row, log, move on.
      result.failed += 1;
      console.warn('[push] send failed', {
        userId,
        endpoint: sub.endpoint.slice(0, 60),
        status,
        message: (err as Error).message,
      });
    }
  }));

  return result;
}
