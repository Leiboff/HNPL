// ─── Dunning-ladder notifications — email always, SMS on Day-0 ─────────
//
// Centralises every notification fired by the failed-instalment recovery
// flow. Three events:
//
//   • notifyAttemptFailed       — email always; SMS on the first-fail
//                                 (consecutiveFailedAttemptsBefore === 0).
//                                 Fee-applied + next-attempt copy when a
//                                 fee attached on this attempt.
//   • notifyRecoverySucceeded   — email when an instalment that was in
//                                 the ladder finally collects (either
//                                 via cron retry or self-settle).
//   • notifyDefaulted           — email when the cap is reached and the
//                                 instalment turns terminal-defaulted.
//
// Discipline:
//   • Every function is `try`-wrapped — a sender throwing or timing out
//     MUST NOT propagate. The webhook + cron + settle action all wrap
//     calls in try/catch out of habit, but the inner try here is the
//     real guarantee. A logged warn is the worst case.
//   • SMS bodies contain NO URL — anti-smishing discipline matching the
//     OTP sender. The patient is told to log in.
//   • `testMode` is honoured by the underlying senders (SMS_TEST_MODE)
//     and by RESEND_API_KEY absence — nothing here special-cases it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

import { sendEmail }   from '@/lib/email/resend';
import { sendSms }     from '@/lib/sms/smsportal';

// ─── Shared helpers ─────────────────────────────────────────────────────

function formatRandCents(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function formatRand(amount: number): string {
  const [integer, decimal] = amount.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;
function formatISODate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

type RecipientContext = {
  email:        string;
  firstName:    string;
  phone:        string | null;
  practiceName: string;
  totalAmount:  number;
  planId:       string;
};

async function loadRecipientContext(svc: SvcClient, paymentId: string): Promise<RecipientContext | null> {
  const { data: row } = await svc
    .from('payments')
    .select(`
      id, plan_id, patient_id,
      plans!inner(id, total_amount, practice_id),
      patient:profiles!payments_patient_id_fkey(email, first_name, phone)
    `)
    .eq('id', paymentId)
    .maybeSingle();

  if (!row) return null;

  // Embedded relations can come as object OR single-element array — guard.
  type PlanEmbed     = { id: string; total_amount: number; practice_id: string };
  type PatientEmbed  = { email: string; first_name: string | null; phone: string | null };
  const plan    = (Array.isArray(row.plans)   ? row.plans[0]   : row.plans)   as PlanEmbed    | undefined;
  const patient = (Array.isArray(row.patient) ? row.patient[0] : row.patient) as PatientEmbed | undefined;
  if (!plan || !patient || !patient.email) return null;

  const { data: practice } = await svc
    .from('practices')
    .select('name')
    .eq('id', plan.practice_id)
    .maybeSingle();
  const practiceName = (practice?.name as string | undefined) ?? 'your practice';

  return {
    email:        patient.email,
    firstName:    patient.first_name ?? 'there',
    phone:        patient.phone ?? null,
    practiceName,
    totalAmount:  Number(plan.total_amount),
    planId:       plan.id,
  };
}

// ─── notifyAttemptFailed ────────────────────────────────────────────────

export type AttemptFailedInput = {
  paymentId: string;
  /** Pre-attempt counter. Determines whether this is the Day-0 SMS-eligible failure. */
  consecutiveFailedAttemptsBefore: number;
  /** Cents of fee attached on THIS attempt (0 if no fee). */
  feeAppliedCents:        number;
  /** Cumulative fees AFTER this attempt (cents). */
  dunningFeesCentsAfter:  number;
  /** Charge amount that was attempted (cents) — what we tried to collect. */
  attemptedAmountCents:   number;
  /** Next attempt date (ISO) or null if the ladder terminated this attempt. */
  nextAttemptDate:        string | null;
};

export async function notifyAttemptFailed(
  svc: SvcClient,
  input: AttemptFailedInput,
): Promise<void> {
  try {
    const ctx = await loadRecipientContext(svc, input.paymentId);
    if (!ctx) return;

    const feeLine = input.feeAppliedCents > 0
      ? `<p style="margin:12px 0;">A <strong>${formatRandCents(input.feeAppliedCents)}</strong> default fee was added. Your outstanding balance for this instalment is now <strong>${formatRandCents(input.attemptedAmountCents + input.feeAppliedCents)}</strong>.</p>`
      : '';

    const nextLine = input.nextAttemptDate
      ? `<p style="margin:12px 0;">We'll automatically try again on <strong>${formatISODate(input.nextAttemptDate)}</strong>.</p>`
      : '';

    const subject = input.feeAppliedCents > 0
      ? `BetterNow — payment didn't go through (${formatRandCents(input.feeAppliedCents)} fee added)`
      : `BetterNow — payment didn't go through`;

    const html = `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #13294B; max-width: 560px;">
        <p>Hi ${ctx.firstName},</p>
        <p>We tried to collect <strong>${formatRandCents(input.attemptedAmountCents)}</strong> for your plan with ${ctx.practiceName} today, but the payment didn't go through.</p>
        ${feeLine}
        ${nextLine}
        <p style="margin:18px 0;">You can settle this now by logging in and tapping <strong>Pay now</strong> on your instalment. Settling immediately stops further attempts and avoids any additional fees.</p>
        <p style="font-size:12px; color:#6b7280; margin-top:22px;">Reply to this email if you need help.</p>
      </div>
    `.trim();

    await sendEmail({ to: ctx.email, subject, html });

    // Day-0 SMS (first failure of the ladder): the highest-urgency
    // touch. Plain text, no URL — anti-smishing.
    const isDayZero = input.consecutiveFailedAttemptsBefore === 0;
    if (isDayZero && ctx.phone) {
      const body =
        `BetterNow: we couldn't collect ${formatRandCents(input.attemptedAmountCents)} ` +
        `for your plan with ${ctx.practiceName}. Log in to settle now and avoid further fees.`;
      await sendSms(ctx.phone, body);
    }
  } catch (err) {
    console.warn('[dunningNotifications] notifyAttemptFailed failed (non-fatal)', {
      paymentId: input.paymentId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── notifyRecoverySucceeded ───────────────────────────────────────────

export type RecoverySucceededInput = {
  paymentId: string;
  /** Total cents collected (instalment + any accrued fees). */
  collectedAmountCents: number;
  /** Was this a patient-initiated self-settle (vs cron retry)? Tunes subject copy. */
  viaSelfSettle: boolean;
};

export async function notifyRecoverySucceeded(
  svc: SvcClient,
  input: RecoverySucceededInput,
): Promise<void> {
  try {
    const ctx = await loadRecipientContext(svc, input.paymentId);
    if (!ctx) return;

    const subject = input.viaSelfSettle
      ? `BetterNow — payment received, thank you`
      : `BetterNow — payment collected, thank you`;

    const html = `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #13294B; max-width: 560px;">
        <p>Hi ${ctx.firstName},</p>
        <p>We've ${input.viaSelfSettle ? 'received' : 'collected'} <strong>${formatRandCents(input.collectedAmountCents)}</strong> for your plan with ${ctx.practiceName}. Your account is up to date.</p>
        <p style="font-size:12px; color:#6b7280; margin-top:22px;">Reply to this email if you need help.</p>
      </div>
    `.trim();

    await sendEmail({ to: ctx.email, subject, html });
  } catch (err) {
    console.warn('[dunningNotifications] notifyRecoverySucceeded failed (non-fatal)', {
      paymentId: input.paymentId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── notifyDefaulted ───────────────────────────────────────────────────

export type DefaultedInput = {
  paymentId:           string;
  outstandingAmountCents: number;
};

export async function notifyDefaulted(
  svc: SvcClient,
  input: DefaultedInput,
): Promise<void> {
  try {
    const ctx = await loadRecipientContext(svc, input.paymentId);
    if (!ctx) return;

    const subject = `BetterNow — your instalment needs attention`;

    const html = `
      <div style="font-family: system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif; color: #13294B; max-width: 560px;">
        <p>Hi ${ctx.firstName},</p>
        <p>Despite several attempts, we haven't been able to collect this instalment for your plan with ${ctx.practiceName}. Your outstanding balance is <strong>${formatRandCents(input.outstandingAmountCents)}</strong>.</p>
        <p>No further retries or fees will be applied. To clear this balance, log in and tap <strong>Pay now</strong> on the instalment, or reply to this email and we'll help you arrange settlement.</p>
        <p style="font-size:12px; color:#6b7280; margin-top:22px;">${formatRand(ctx.totalAmount)} plan · planId ${ctx.planId.slice(0, 8)}</p>
      </div>
    `.trim();

    await sendEmail({ to: ctx.email, subject, html });
  } catch (err) {
    console.warn('[dunningNotifications] notifyDefaulted failed (non-fatal)', {
      paymentId: input.paymentId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
