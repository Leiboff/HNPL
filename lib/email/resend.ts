// ─── Minimal Resend wrapper ────────────────────────────────────────────────
//
// Posts to Resend's HTTP API directly — avoids pulling in the Resend SDK
// for the handful of use cases we have (admin notifications, patient
// invitations, and the public contact form). One file, no dependency change
// to package.json / pnpm-lock.yaml.
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

// Hard ceiling on how long a single send may take. Resend normally
// responds in well under a second; anything past ~8 s is a stall and
// will exceed Vercel's Hobby function timeout if we wait it out.
// Bounded here so a slow Resend can never hang the surrounding server
// action — the AbortError gets caught and returned as ok:false, so
// callers can treat it the same as any other email-send failure.
const DEFAULT_TIMEOUT_MS = 8_000;

export type SendEmailInput = {
  to:      string | string[];
  subject: string;
  html:    string;
  /** Override RESEND_FROM if needed for a specific call. */
  from?:   string;
  /**
   * Address a reply should go to instead of `from`.
   *
   * Added for the public contact form (app/contact/contactAction.ts): the
   * enquiry is SENT BY our verified sender — it has to be, since RESEND_FROM
   * is the only domain Resend will accept — but a reply has to reach the
   * person who wrote it. Without this, answering an enquiry meant
   * copy-pasting the address out of the body.
   *
   * NOT a from-address override, and deliberately kept separate from `from`:
   * putting a visitor-supplied address in `from` would be sender spoofing,
   * would fail SPF/DKIM for our domain, and would train spam filters against
   * us. Reply-To carries no such authority, which is exactly why it is the
   * right header for untrusted input.
   */
  replyTo?: string;
  /** Override the 8s default. Useful for tests. */
  timeoutMs?: number;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from,
        to:      input.to,
        subject: input.subject,
        html:    input.html,
        // Omitted entirely when unset — Resend rejects an explicit null,
        // and every existing caller passes no replyTo.
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id ?? '' };
  } catch (err) {
    // AbortError from the timeout, network error, JSON parse — all
    // funneled into the same ok:false shape so callers don't have to
    // distinguish "Resend slow" from "Resend down".
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    if (isAbort) {
      return { ok: false, error: `Resend timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` };
    }
    return {
      ok:    false,
      error: err instanceof Error ? err.message : 'Unknown network error',
    };
  } finally {
    clearTimeout(timer);
  }
}
