import { sendEmail, type SendEmailResult } from '../resend';

// ─── Patient invitation email — NEW EMAIL (no existing account) ────────────
//
// Sent by createBill when the patient email doesn't match any
// confirmed BetterNow account. Contains the ONLY copy of the
// checkout link — the provider never sees the URL; proving the
// patient controls this email IS our verification (no OTP).
//
// If this send fails, createBill surfaces the failure clearly so the
// provider can fix a typo'd email and retry. There is no fallback
// "copy this link" affordance — email is the only door into checkout.

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function escapeHtml(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export type PatientInvitationInput = {
  to:           string;
  practiceName: string;
  amount:       number;
  checkoutUrl:  string;
  expiresAt:    string;  // ISO timestamp
};

export async function sendPatientInvitationEmail(
  input: PatientInvitationInput,
): Promise<SendEmailResult> {
  const { to, practiceName, amount, checkoutUrl, expiresAt } = input;

  const safePractice = escapeHtml(practiceName);
  const safeAmount   = escapeHtml(formatRand(amount));
  const safeUrl      = escapeHtml(checkoutUrl);
  const expiryDate   = new Date(expiresAt).toLocaleDateString('en-ZA', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const subject = `Your bill from ${practiceName} is ready`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f7fbfb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7fbfb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid rgba(19,41,75,0.08);">
        <tr><td style="padding:32px;">

          <div style="font-size:20px;font-weight:700;margin-bottom:24px;">
            <span style="color:#13294B;">better</span><span style="color:#15A89E;">now</span>
          </div>

          <h1 style="font-size:20px;font-weight:600;color:#111827;margin:0 0 12px;">
            ${safePractice} sent you a bill
          </h1>

          <p style="font-size:32px;font-weight:700;color:#13294B;margin:0 0 8px;letter-spacing:-0.02em;">
            ${safeAmount}
          </p>
          <p style="font-size:14px;color:#6b7280;margin:0 0 24px;">
            Pay over 2 or 3 months interest-free.
          </p>

          <a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,#13294B 0%,#15A89E 145%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">
            Review and pay →
          </a>

          <p style="font-size:13px;color:#6b7280;margin:24px 0 0;">
            This link is for you only — please don't forward it.
            It expires on <strong>${expiryDate}</strong>.
          </p>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />

          <p style="font-size:12px;color:#9ca3af;margin:0;">
            BetterNow is a South African medical payment-plan provider.
            We collect each instalment automatically on your nominated salary date —
            no interest, no surprises.
          </p>

        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;

  return sendEmail({ to, subject, html });
}
