import { sendEmail, type SendEmailResult } from '../resend';
import { SUPPORT_EMAIL } from '@/lib/config/contact';

// ─── "Someone you know uses betternow" ────────────────────────────────────
//
// Sent by referAFriend (app/patient/refer/actions.ts) to an address a
// customer typed. The recipient is a STRANGER to this platform: they have no
// account, have never heard from us, and did not ask for this. Every decision
// below follows from that.
//
// ─── WHAT IT SAYS, AND WHAT IT MUST NOT ──────────────────────────────────
//
//   • It NAMES the person who referred them, first name only. An invitation
//     that will not say who it is from is indistinguishable from spam, and
//     the name is the only reason the recipient will read past the subject.
//     First name only because the surname is not needed for that and is more
//     of somebody's identity than this email needs to spend.
//
//   • It promises NOTHING. There is no incentive programme (see
//     docs/REFERRALS.md), so there is no reward to mention — not to the
//     recipient and not on the referrer's behalf. This email is the most
//     forwardable artefact the referral system produces; a promise made here
//     is a promise made in writing to someone who is not even a customer.
//
//   • It carries no personal information ABOUT the referrer beyond that first
//     name, and none at all about the recipient other than the address it was
//     sent to. Nothing about bills, practices, plans or amounts.
//
//   • It says how to make it stop. A referral invitation is lawful under
//     POPIA as a legitimate interest, and an unsubscribe route is part of
//     what makes it defensible — so the footer names the support mailbox
//     rather than pretending there is a preference centre for somebody who
//     has no account to hold preferences on.
//
// ─── FAILURE IS NOT FATAL TO THE REFERRAL ────────────────────────────────
//
// This returns a result and never throws. The referral row is written before
// the send and stays written if the send fails: a referral we recorded and
// failed to deliver is recoverable (the customer can share their link
// instead), and one we refused to record because Resend was down is not.

function escapeHtml(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export type ReferralInviteInput = {
  to: string;
  /** The referrer's first name. Never their surname, and never their email. */
  referrerFirstName: string;
  /** The invitee's first name, if they gave us one. Optional by design. */
  inviteeFirstName?: string | null;
  /** The share link, already carrying the code. */
  link: string;
};

export async function sendReferralInviteEmail(
  input: ReferralInviteInput,
): Promise<SendEmailResult> {
  const { to, referrerFirstName, inviteeFirstName, link } = input;

  const safeReferrer = escapeHtml(referrerFirstName.trim()) || 'A friend';
  const safeInvitee  = escapeHtml((inviteeFirstName ?? '').trim());
  const safeLink     = escapeHtml(link);
  const greeting     = safeInvitee ? `Hi ${safeInvitee},` : 'Hi there,';

  const subject = `${referrerFirstName.trim() || 'A friend'} thought betternow might help`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f7fbfb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7fbfb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid rgba(19,41,75,0.08);">
        <tr><td style="padding:32px;">

          <div style="font-size:20px;font-weight:700;margin-bottom:24px;">
            <span style="color:#13294B;">better</span><span style="color:#15A89E;">now</span>
          </div>

          <p style="font-size:15px;color:#374151;margin:0 0 12px;">${greeting}</p>

          <h1 style="font-size:20px;font-weight:600;color:#111827;margin:0 0 12px;">
            ${safeReferrer} uses betternow to pay for medical care
          </h1>

          <p style="font-size:14px;color:#4b5563;margin:0 0 24px;line-height:1.6;">
            betternow splits a medical bill into 2 or 3 interest-free instalments,
            timed around your salary date. Your practice is paid up front; you pay
            us back over the following months.
          </p>

          <a href="${safeLink}" style="display:inline-block;background:linear-gradient(135deg,#13294B 0%,#15A89E 145%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">
            See how it works →
          </a>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

          <p style="font-size:12px;color:#9ca3af;margin:0 0 8px;">
            betternow is a South African medical payment-plan provider.
          </p>
          <p style="font-size:12px;color:#9ca3af;margin:0;">
            You received this because ${safeReferrer} entered your email address.
            We have not created an account for you. To have your address removed
            from our records, email
            <a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" style="color:#6b7280;">${escapeHtml(SUPPORT_EMAIL)}</a>.
          </p>

        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;

  return sendEmail({ to, subject, html });
}
