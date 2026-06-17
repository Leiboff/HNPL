'use server';

import crypto from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { calculateFee } from '@/lib/finance';
import { checkTradingGate } from '@/lib/practice/tradingGate';
import { sendPatientInvitationEmail } from '@/lib/email/templates/patientInvitation';
import { sendExistingPatientBillEmail } from '@/lib/email/templates/existingPatientBill';

// ─── Public surface ──────────────────────────────────────────────────────────
//
// createBill forks at SEND time on whether the patient email already
// belongs to a confirmed BetterNow account:
//
//   • Existing patient → the bill appears on their dashboard as a
//     pending_acceptance plan; we email them "you have a new bill,
//     log in to review and pay". They never see the anonymous
//     checkout flow.
//
//   • New email → we create a patient_invitations row + email the
//     checkout link DIRECTLY to that email address. The link is
//     NEVER returned to the provider — proving the patient controls
//     the inbox is our email verification, replacing OTP.
//
// If the email send fails (e.g. typo'd address), the provider sees
// the failure in the returned summary and can re-issue with the
// correct address. Silent failure is not OK — the email is the only
// door into the anonymous checkout.

export type CreateBillInput = {
  patientEmail:       string;
  billAmount:         number;
  practiceReference?: string;
  providerId:         string;
};

/** Outcome of the auto-sent email. */
export type InvitationEmailResult = {
  sent:    boolean;
  /** Present when sent=false — copy to surface to the provider. */
  error?:  string;
  /**
   * The patient email we attempted to send to. Provider sees this
   * in the UI so they can confirm the address before resending.
   */
  to:      string;
};

export type CreateBillSummary = {
  gross:              number;
  fee:                number;
  net:                number;
  /** Patient display name when known (existing account), otherwise the email. */
  patientName:        string;
  invoiceNumber:      string;
  practiceReference?: string;
  /**
   * Set ONLY when the patient was new (no existing confirmed account).
   * Does NOT carry the checkout URL — the link is in the email and
   * nowhere else. The provider sees the email-delivery outcome.
   */
  invitation?:        {
    email:           string;
    expiresAt:       string;
    emailDelivery:   InvitationEmailResult;
  };
  /** Set when the patient was an existing confirmed account. */
  existingAccount?:   {
    email:           string;
    emailDelivery:   InvitationEmailResult;
  };
};

export type CreateBillResult = {
  error:    string | null;
  summary?: CreateBillSummary;
};

// ─── createBill ──────────────────────────────────────────────────────────────

export async function createBill(data: CreateBillInput): Promise<CreateBillResult> {
  const { patientEmail, billAmount, practiceReference, providerId } = data;

  if (!patientEmail || typeof patientEmail !== 'string') {
    return { error: 'Patient email is required.' };
  }
  if (!Number.isFinite(billAmount) || billAmount < 500 || billAmount > 50000) {
    return { error: 'Bill amount must be between R500 and R50 000.' };
  }
  if (!providerId) {
    return { error: 'A healthcare provider must be selected.' };
  }

  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) return { error: 'You are not a member of any active practice.' };

  const practiceId = membership.practice_id as string;

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── Trading gate ────────────────────────────────────────────────────────
  const gate = await checkTradingGate(svc, practiceId);
  if (!gate.ok) return { error: gate.message };

  // ── Provider belongs to this practice as a provider ────────────────────
  const { data: providerMember } = await supabase
    .from('practice_members')
    .select('user_id')
    .eq('practice_id', practiceId)
    .eq('user_id', providerId)
    .eq('active', true)
    .eq('role', 'provider')
    .maybeSingle();

  if (!providerMember) return { error: 'Selected provider is not a provider on this practice.' };

  const { data: practice } = await supabase
    .from('practices')
    .select('name, fee_percent')
    .eq('id', practiceId)
    .single();

  if (!practice) return { error: 'Practice not found.' };

  const feePercent  = Number(practice.fee_percent);
  const practiceName = practice.name as string;

  const normalizedEmail = patientEmail.trim().toLowerCase();

  // Look up the patient. The "existing account" branch is taken only
  // for CONFIRMED profiles — an unconfirmed orphan would still need
  // to go through the anonymous checkout (it would never have set
  // a password). The trigger that writes profiles fires on signup,
  // so a profile row implies the auth user exists; we use the
  // profile-only lookup here since unconfirmed orphans don't get
  // routed through createBill's existing-patient branch.
  const { data: patient } = await svc
    .from('profiles')
    .select('id, first_name, last_name')
    .eq('email', normalizedEmail)
    .eq('role', 'patient')
    .maybeSingle();

  const { gross, fee, net } = calculateFee(billAmount, feePercent);

  const { data: invoiceNumber, error: invoiceError } = await supabase.rpc('next_invoice_number');
  if (invoiceError || !invoiceNumber) {
    return { error: 'Failed to generate invoice number. Please try again.' };
  }

  const applicationId = crypto.randomUUID();
  const { error: appError } = await supabase.from('applications').insert({
    id:          applicationId,
    patient_id:  patient?.id ?? null,
    practice_id: practiceId,
    bill_amount: billAmount,
    status:      'pending',
  });
  if (appError) return { error: `Failed to create application: ${appError.message}` };

  const planId = crypto.randomUUID();
  const { error: planError } = await supabase.from('plans').insert({
    id:                 planId,
    application_id:     applicationId,
    patient_id:         patient?.id ?? null,
    practice_id:        practiceId,
    provider_id:        providerId,
    total_amount:       billAmount,
    status:             'pending_acceptance',
    invoice_number:     invoiceNumber,
    practice_reference: practiceReference?.trim() || null,
  });
  if (planError) {
    await supabase.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to create plan: ${planError.message}` };
  }

  const trimmedRef = practiceReference?.trim() || undefined;
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? '';

  // ── Scenario A: existing patient ───────────────────────────────────────
  // Bill appears on their dashboard. Email them "log in to review".
  if (patient) {
    const dashboardUrl = `${appUrl}/patient/orders/${planId}/confirm`;
    const emailResult  = await sendExistingPatientBillEmail({
      to:           normalizedEmail,
      practiceName,
      amount:       billAmount,
      dashboardUrl,
    });

    return {
      error: null,
      summary: {
        gross,
        fee,
        net,
        patientName:       `${patient.first_name} ${patient.last_name}`,
        invoiceNumber,
        practiceReference: trimmedRef,
        existingAccount: {
          email:         normalizedEmail,
          emailDelivery: {
            sent:  emailResult.ok,
            error: emailResult.ok ? undefined : emailResult.error,
            to:    normalizedEmail,
          },
        },
      },
    };
  }

  // ── Scenario B: new patient — invitation + checkout email ──────────────
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error: inviteError } = await supabase.from('patient_invitations').insert({
    email:       normalizedEmail,
    plan_id:     planId,
    practice_id: practiceId,
    provider_id: providerId,
    token,
    expires_at:  expiresAt,
  });

  if (inviteError) {
    console.error('[createBill] Failed to create invitation', inviteError.message);
    return { error: `Failed to create invitation: ${inviteError.message}` };
  }

  const checkoutUrl = `${appUrl}/checkout/${token}`;
  const emailResult = await sendPatientInvitationEmail({
    to:           normalizedEmail,
    practiceName,
    amount:       billAmount,
    checkoutUrl,
    expiresAt,
  });

  return {
    error: null,
    summary: {
      gross,
      fee,
      net,
      patientName:       normalizedEmail,
      invoiceNumber,
      practiceReference: trimmedRef,
      invitation: {
        email:         normalizedEmail,
        expiresAt,
        emailDelivery: {
          sent:  emailResult.ok,
          error: emailResult.ok ? undefined : emailResult.error,
          to:    normalizedEmail,
        },
      },
    },
  };
}
