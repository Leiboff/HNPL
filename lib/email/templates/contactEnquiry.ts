import { sendEmail, type SendEmailResult } from '../resend';
import { SUPPORT_EMAIL } from '@/lib/config/contact';

// ─── Contact-form enquiry — public, unauthenticated submission ─────────
//
// Sent by app/contact/contactAction.ts when a visitor submits the enquiry
// form on /contact. Goes to SUPPORT_EMAIL, with Reply-To set to the
// submitter so answering it is one click rather than a copy-paste out of
// the body.
//
// ─── EVERY FIELD HERE IS ATTACKER-CONTROLLED ──────────────────────────
//
// This is the only email template in the repo whose entire body comes from
// an anonymous public form. The others interpolate values that passed
// through an authenticated surface first (a practice's own name, an amount
// we computed). So escaping is not hygiene here, it is the point:
//
//   • every interpolated value goes through escapeHtml, with no exceptions,
//     including the ones that were format-validated — isValidEmail is a
//     shape check, not a sanitiser, and "a@b.c<script>" would pass a
//     looser reading of it;
//   • the submitter's address is rendered as TEXT, never as a mailto: href,
//     so a crafted value cannot become a clickable link in our own inbox;
//   • the message is rendered inside a <pre>-style block with preserved
//     whitespace rather than as HTML, so newlines survive without any
//     markup being interpreted.
//
// The caller enforces the length caps. They matter for the same reason:
// they bound what can be pushed into an inbox we read.

function escapeHtml(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Who the enquiry says they are. Drives the subject line so a small
 *  support inbox can triage without opening the message. */
export type EnquirerKind = 'patient' | 'practice';

const KIND_LABEL: Record<EnquirerKind, string> = {
  patient:  'Patient',
  practice: 'Practice',
};

export type ContactEnquiryInput = {
  kind:    EnquirerKind;
  name:    string;
  email:   string;
  phone:   string;
  message: string;
};

export async function sendContactEnquiryEmail(
  input: ContactEnquiryInput,
): Promise<SendEmailResult> {
  const { kind, name, email, phone, message } = input;

  const safeName    = escapeHtml(name);
  const safeEmail   = escapeHtml(email);
  const safePhone   = escapeHtml(phone);
  const safeMessage = escapeHtml(message);
  const safeKind    = escapeHtml(KIND_LABEL[kind] ?? 'Unspecified');

  // The subject carries the triage signal and the name, so the inbox list
  // is readable without opening anything.
  const subject = `Contact form — ${KIND_LABEL[kind] ?? 'Enquiry'}: ${name}`;

  const row = (label: string, value: string) => `
      <tr>
        <td style="padding: 6px 16px 6px 0; color: #5b6b80; font-size: 13px; vertical-align: top; white-space: nowrap;">${label}</td>
        <td style="padding: 6px 0; color: #13294B; font-size: 14px; font-weight: 500;">${value}</td>
      </tr>`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #13294B; max-width: 620px;">
      <h2 style="margin: 0 0 4px; font-size: 18px;">New contact-form enquiry</h2>
      <p style="margin: 0 0 20px; color: #5b6b80; font-size: 13px;">
        Submitted from the betternow website contact form. Reply directly to this
        email to answer ${safeName} &mdash; Reply-To is set to their address.
      </p>

      <table style="border-collapse: collapse; margin: 0 0 20px;">
        ${row('They are a', safeKind)}
        ${row('Name', safeName)}
        ${row('Email', safeEmail)}
        ${row('Contact number', safePhone || '&mdash;')}
      </table>

      <div style="color: #5b6b80; font-size: 13px; margin: 0 0 6px;">Message</div>
      <div style="border: 1px solid rgba(19,41,75,.12); border-radius: 10px; padding: 14px 16px; background: #f7fbfb; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${safeMessage}</div>

      <p style="margin: 20px 0 0; color: #6b7280; font-size: 12px;">
        Sent by the betternow contact form. The sender's address is unverified &mdash;
        it is whatever they typed, so treat it as a claim rather than an identity.
      </p>
    </div>
  `;

  return sendEmail({
    to:      SUPPORT_EMAIL,
    subject,
    html,
    // The whole reason lib/email/resend.ts gained replyTo. The visitor's
    // address goes HERE and never in `from`: a visitor-supplied `from` would
    // be spoofing our own domain and would fail SPF/DKIM.
    replyTo: email,
  });
}
