import { sendEmail, type SendEmailResult } from '../resend';

// ─── Existing-patient bill-ready email ─────────────────────────────────────
//
// Sent by createBill when the patient email DOES match a confirmed
// BetterNow account. The patient does NOT go through the anonymous
// checkout — the bill appears on their dashboard, and this email
// just nudges them to log in.

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

export type ExistingPatientBillInput = {
  to:            string;
  practiceName:  string;
  amount:        number;
  /** URL to the patient's bill — typically /patient/orders/[planId]/confirm or /patient. */
  dashboardUrl:  string;
};

export async function sendExistingPatientBillEmail(
  input: ExistingPatientBillInput,
): Promise<SendEmailResult> {
  const { to, practiceName, amount, dashboardUrl } = input;

  const safePractice = escapeHtml(practiceName);
  const safeAmount   = escapeHtml(formatRand(amount));
  const safeUrl      = escapeHtml(dashboardUrl);

  const subject = `You have a new bill from ${practiceName}`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f7fbfb;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7fbfb;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid rgba(19,41,75,0.08);">
        <tr><td style="padding:32px;">

          <div style="font-size:20px;font-weight:700;margin-bottom:24px;">
            <span style="color:#13294B;">better</span><span style="color:#15A89E;">now</span>
          </div>

          <h1 style="font-size:20px;font-weight:600;color:#111827;margin:0 0 12px;">
            New bill from ${safePractice}
          </h1>

          <p style="font-size:32px;font-weight:700;color:#13294B;margin:0 0 8px;letter-spacing:-0.02em;">
            ${safeAmount}
          </p>
          <p style="font-size:14px;color:#6b7280;margin:0 0 24px;">
            Log in to review and choose 2 or 3 instalments.
          </p>

          <a href="${safeUrl}" style="display:inline-block;background:linear-gradient(135deg,#13294B 0%,#15A89E 145%);color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">
            Log in to view →
          </a>

        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;

  return sendEmail({ to, subject, html });
}
