import { sendEmail } from './resend';

// ─── Notify admin: new practice awaiting approval ─────────────────────────
//
// Fired from the practice signup server action AFTER the practice +
// member rows have been inserted. Best-effort: failure is logged but
// never blocks the signup return path. The recipient is the platform
// admin set via ADMIN_NOTIFICATION_EMAIL — if that env var is missing
// the send is silently skipped (with a console warning).
//
// Why not query profiles for role='admin' instead of using an env var?
// Two reasons:
//   1. The notification is operational — it should arrive even if the
//      admin profiles table is misconfigured / empty / RLS-blocked.
//   2. Each new admin onboarded shouldn't auto-subscribe to signup
//      notifications without explicit configuration.
//
// The email is intentionally minimal — name, specialty, city, plus a
// deep link to the approval queue.

type PracticeSummary = {
  id:        string;
  name:      string;
  specialty: string;
  city:      string;
};

export async function notifyAdminOfPracticeSignup(practice: PracticeSummary): Promise<void> {
  const to = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!to) {
    console.warn('[notifyAdminOfPracticeSignup] ADMIN_NOTIFICATION_EMAIL not set — notification skipped.', {
      practice_id: practice.id,
    });
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const link   = `${appUrl}/admin/practices?status=pending`;

  const subject = `New practice awaiting approval: ${practice.name}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #13294B; max-width: 560px;">
      <h2 style="margin: 0 0 16px;">New practice signup</h2>
      <p style="margin: 0 0 8px;"><strong>Name:</strong> ${escape(practice.name)}</p>
      <p style="margin: 0 0 8px;"><strong>Specialty:</strong> ${escape(practice.specialty)}</p>
      <p style="margin: 0 0 24px;"><strong>City:</strong> ${escape(practice.city)}</p>
      <p style="margin: 0 0 24px;">
        <a href="${link}" style="display: inline-block; background: #15A89E; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600;">
          Review pending practices →
        </a>
      </p>
      <p style="margin: 0; color: #6b7280; font-size: 12px;">
        BetterNow admin notification. Reply to discuss internally — this address is unmonitored.
      </p>
    </div>
  `;

  const result = await sendEmail({ to, subject, html });
  if (!result.ok) {
    console.warn('[notifyAdminOfPracticeSignup] send failed', {
      practice_id: practice.id,
      error:       result.error,
    });
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
