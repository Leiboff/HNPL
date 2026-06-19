// ─── SMSPortal REST sender ───────────────────────────────────────────────
//
// One-shot send via SMSPortal's /bulkmessages endpoint. Mirrors the
// bounded-fetch discipline of lib/email/resend.ts and lib/paystack.ts:
//
//   • 8-second AbortController timeout. An SMS provider that hangs
//     must NEVER hang the checkout — the patient is standing at the
//     till waiting for an OTP and a 30-second blocker would feel
//     broken. After 8s we give up, surface "couldn't send", and let
//     the patient hit Resend.
//   • try/catch wrapping the whole fetch + JSON path so a network
//     failure or malformed response is a clear { ok:false } not a
//     thrown rejection up the call stack.
//   • testMode flag (server-config, never user-controllable) so we
//     can integration-test the gate without burning SMS credit or
//     hammering real phone numbers. SMS_TEST_MODE=true ⇒ SMSPortal
//     accepts the request, validates the payload, returns success,
//     but doesn't actually push the SMS.
//   • No-op + warn-once when SMSPORTAL_CLIENT_ID / SMSPORTAL_CLIENT
//     _SECRET are absent. Same pattern as web-push: dev environments
//     without creds don't crash; they just don't send.
//
// SMS body discipline (enforced at the call site, not here):
//   • Plain text only, no URLs. SA carriers (MTN, Vodacom, CellC,
//     Telkom) aggressively flag SMS containing http:// or https:// as
//     smishing — link-bearing OTPs frequently never arrive at all.
//     The format "Your BetterNow code is 123456. It expires in
//     10 minutes." is what the request action sends.
//   • "code is" phrasing is the iOS/Android autofill heuristic. Don't
//     reword without checking the autofill still triggers.

export const SMSPORTAL_FETCH_TIMEOUT_MS = 8_000;
const SMSPORTAL_BASE_URL                = 'https://rest.smsportal.com';

export type SmsResult = { ok: true } | { ok: false; error: string };

let warnedMissingCreds = false;

export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const id     = process.env.SMSPORTAL_CLIENT_ID;
  const secret = process.env.SMSPORTAL_CLIENT_SECRET;

  if (!id || !secret) {
    if (!warnedMissingCreds) {
      warnedMissingCreds = true;
      console.warn(
        '[sms] SMSPORTAL_CLIENT_ID / SMSPORTAL_CLIENT_SECRET missing — '
        + 'sender is a documented no-op. Set both env vars to enable.',
      );
    }
    return { ok: false, error: 'sms_not_configured' };
  }

  const senderId = process.env.SMSPORTAL_SENDER_ID;
  const testMode = process.env.SMS_TEST_MODE === 'true';

  // Per-message shape: { content, destination, from? }
  const message: Record<string, string> = {
    content:     body,
    destination: to,
  };
  if (senderId) message.from = senderId;

  // SMSPortal accepts testMode at the top of the request envelope.
  // When set, the API validates the payload + returns a successful
  // response shape, but no SMS is dispatched. Used by CI + dev.
  const payload = {
    messages: [message],
    ...(testMode ? { testMode: true } : {}),
  };

  // Basic auth: base64("CLIENT_ID:CLIENT_SECRET"). Buffer.from is the
  // standard server-side path; this file is server-only (no 'use client').
  const auth = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), SMSPORTAL_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${SMSPORTAL_BASE_URL}/bulkmessages`, {
      method:  'POST',
      headers: {
        'Authorization': auth,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });

    if (!res.ok) {
      // Read up to 200 chars of the error body for diagnostics, then
      // throw it away — we never propagate provider error verbiage to
      // the patient (they get a clean "couldn't send code"); the
      // detail lives in server logs.
      const detail = await res.text().catch(() => '');
      console.warn('[sms] SMSPortal non-2xx', {
        status:  res.status,
        snippet: detail.slice(0, 200),
        to:      to.slice(0, 5) + '…',  // partial-mask in logs
      });
      return { ok: false, error: `sms_provider_${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      console.warn('[sms] SMSPortal timeout', { to: to.slice(0, 5) + '…' });
      return { ok: false, error: 'sms_timeout' };
    }
    console.warn('[sms] SMSPortal fetch failed', {
      to:      to.slice(0, 5) + '…',
      message: (err as Error).message,
    });
    return { ok: false, error: 'sms_network' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildOtpSmsBody(code: string): string {
  // EXACT phrasing — "code is N" triggers iOS Messages and Android
  // Messages autofill. Plain text, no URL. 10-minute expiry mirrors
  // the RPC's expires_at calculation.
  return `Your BetterNow code is ${code}. It expires in 10 minutes.`;
}
