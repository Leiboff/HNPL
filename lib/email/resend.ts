// ─── Minimal Resend wrapper ────────────────────────────────────────────────
//
// Posts to Resend's HTTP API directly — avoids pulling in the Resend SDK
// for the single use case we have today (admin notifications). One file,
// no dependency change to package.json / pnpm-lock.yaml.
//
// Required env vars (read at call time, not at import time, so a missing
// var doesn't crash the build):
//   RESEND_API_KEY            — already present in .env.local; unwired
//                               until this file existed.
//   RESEND_FROM               — verified sender address. For testing,
//                               'onboarding@resend.dev' works without
//                               domain verification but ONLY delivers
//                               to the Resend account owner's email.
//                               For production, verify a domain in the
//                               Resend dashboard and set this to
//                               e.g. 'noreply@betternow.co.za'.
//
// Behaviour: never throws. Returns { ok: true } on a 2xx response or
// { ok: false, error: ... } otherwise. Callers that wrap signup or
// other user-facing flows must treat email failure as non-fatal —
// never let a missing/broken sender block the primary action.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type SendEmailInput = {
  to:      string | string[];
  subject: string;
  html:    string;
  /** Override RESEND_FROM if needed for a specific call. */
  from?:   string;
};

export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY not set — email send skipped.' };
  }

  const from = input.from ?? process.env.RESEND_FROM;
  if (!from) {
    return { ok: false, error: 'RESEND_FROM not set — email send skipped.' };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from,
        to:      input.to,
        subject: input.subject,
        html:    input.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id ?? '' };
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : 'Unknown network error',
    };
  }
}
