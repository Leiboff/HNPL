import { sendEmail, type SendEmailResult } from '../resend';

// ─── Abandoned-onboarding nudge ─────────────────────────────────────────
//
// Sent by app/api/cron/onboarding-nudge to a patient who confirmed their
// email and then stopped part-way through the application. Two at most:
// the first once they have been idle a few minutes, the second a day
// later. The second says it is the last one, and means it — the cron caps
// onboarding_nudge_count at 2.
//
// ─── COLOURS ARE LITERAL HERE, ON PURPOSE ───────────────────────────────
//
// The rest of the app moved onto --brand-*/--portal-* custom properties.
// Email clients do not support them (Outlook and most webmail strip or
// ignore custom properties, and Gmail's inliner will not resolve them), so
// every template in this directory states brand hex directly. app/
// portal-tokens.test.ts scopes its no-raw-hex guard to the app trees for
// exactly this reason. The values still have to MATCH the brand, so they
// are pinned by this template's test rather than by the token guard.

const NAVY = '#13294B';
const TEAL = '#15A89E';

function escapeHtml(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export type OnboardingNudgeInput = {
  to:         string;
  firstName:  string | null;
  /** What the patient sees the remaining step called. */
  stepLabel:  string;
  /** 1 = first reminder, 2 = final. */
  nudgeNumber: number;
};

/**
 * Subject lines.
 *
 * Neither one says "you failed" or "your application is incomplete" — this
 * is a health-finance application and the patient may be part-way through
 * because they were waiting for a bill, not because they lost interest.
 */
export function nudgeSubject(input: Pick<OnboardingNudgeInput, 'stepLabel' | 'nudgeNumber'>): string {
  return input.nudgeNumber >= 2
    ? 'Your BetterNow application is still waiting'
    : `One more step: ${input.stepLabel}`;
}

export function renderOnboardingNudge(input: OnboardingNudgeInput): string {
  const safeName = escapeHtml(input.firstName?.trim() || '');
  const safeStep = escapeHtml(input.stepLabel);
  const greeting = safeName ? `Hi ${safeName},` : 'Hi there,';
  const isFinal  = input.nudgeNumber >= 2;

  // /login?next=/onboarding rather than /onboarding directly: the click may
  // arrive with no session (they are being nudged precisely because they
  // left), and the onboarding router redirects an anonymous visitor to
  // /login anyway. Sending them there first keeps one hop and lands them
  // back on the right step afterwards.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  const safeUrl = escapeHtml(`${appUrl}/login?next=/onboarding`);

  const lead = isFinal
    ? `We're holding your application — you stopped at ${safeStep}. This is the last
       reminder we'll send; you can pick it up whenever you're ready.`
    : `You're nearly done. All that's left is ${safeStep}, which takes a minute.`;

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f7fbfb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7fbfb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid rgba(19,41,75,0.08);">
        <tr><td style="padding:32px;">

          <div style="font-size:20px;font-weight:700;margin-bottom:24px;">
            <span style="color:${NAVY};">better</span><span style="color:${TEAL};">now</span>
          </div>

          <h1 style="font-size:20px;font-weight:600;color:#111827;margin:0 0 12px;">
            ${isFinal ? 'Still there?' : 'You&rsquo;re one step away'}
          </h1>

          <p style="font-size:15px;line-height:1.55;color:#374151;margin:0 0 24px;">
            ${greeting} ${lead}
          </p>

          <a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,${NAVY} 0%,${TEAL} 145%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">
            Finish my application &rarr;
          </a>

          <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:24px 0 0;">
            Nothing you&rsquo;ve entered is lost &mdash; you&rsquo;ll come back to exactly
            where you stopped.
          </p>

        </td></tr>
      </table>
      <p style="font-size:12px;color:#9ca3af;margin:16px 0 0;">
        You&rsquo;re receiving this because you started a BetterNow application.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Send it. Never throws — a nudge is the least important email the system
 * sends, and a Resend timeout must not fail the cron run or stop the other
 * patients in the batch from being processed.
 */
export async function sendOnboardingNudge(
  input: OnboardingNudgeInput,
): Promise<SendEmailResult> {
  try {
    return await sendEmail({
      to:      input.to,
      subject: nudgeSubject(input),
      html:    renderOnboardingNudge(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[onboardingNudge] send threw', message);
    return { ok: false, error: message };
  }
}
