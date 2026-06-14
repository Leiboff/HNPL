'use server';

import crypto from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { calculateFee } from '@/lib/finance';
import { checkTradingGate } from '@/lib/practice/tradingGate';

// ─── Public surface ──────────────────────────────────────────────────────────

export type CreateBillInput = {
  patientEmail:       string;
  billAmount:         number;
  practiceReference?: string;
  providerId:         string;
};

export type InvitationSummary = {
  email:     string;
  token:     string;
  expiresAt: string;
  shareUrl:  string;
};

export type CreateBillSummary = {
  gross:              number;
  fee:                number;
  net:                number;
  patientName:        string;
  invoiceNumber:      string;
  practiceReference?: string;
  invitation?:        InvitationSummary;
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

  // Service-role client for both the trading-gate check and the patient
  // lookup. Trading gate must be enforced regardless of RLS, and the patient
  // lookup must not be silenced by RLS into a null result (which would
  // create the plan with patient_id=null and orphan the bill).
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── Trading gate ────────────────────────────────────────────────────────
  // Must pass before any application/plan rows are inserted. The two
  // conditions and their user-facing messages live in lib/practice/tradingGate.
  const gate = await checkTradingGate(svc, practiceId);
  if (!gate.ok) return { error: gate.message };

  // ── Verify the selected provider belongs to this practice as a provider ─
  // The gate already proved >=1 provider exists; this check is about the
  // SPECIFIC providerId the form submitted. role='provider' is required —
  // admins and non-clinician staff cannot be attached to bills.
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
    .select('fee_percent')
    .eq('id', practiceId)
    .single();

  if (!practice) return { error: 'Practice not found.' };

  const feePercent = Number(practice.fee_percent);

  const { data: patient } = await svc
    .from('profiles')
    .select('id, first_name, last_name')
    .eq('email', patientEmail.trim().toLowerCase())
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

  // ── Scenario A: existing patient ───────────────────────────────────────
  if (patient) {
    return {
      error: null,
      summary: {
        gross,
        fee,
        net,
        patientName:       `${patient.first_name} ${patient.last_name}`,
        invoiceNumber,
        practiceReference: trimmedRef,
      },
    };
  }

  // ── Scenario B: new patient — create invitation ────────────────────────
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error: inviteError } = await supabase.from('patient_invitations').insert({
    email:       patientEmail.trim().toLowerCase(),
    plan_id:     planId,
    practice_id: practiceId,
    provider_id: providerId,
    token,
    expires_at:  expiresAt,
  });

  if (inviteError) {
    console.error('[createBill] Failed to create invitation', inviteError.message);
  }

  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const shareUrl = `${appUrl}/signup/patient?token=${token}`;

  return {
    error: null,
    summary: {
      gross,
      fee,
      net,
      patientName:       patientEmail.trim().toLowerCase(),
      invoiceNumber,
      practiceReference: trimmedRef,
      invitation: { email: patientEmail.trim().toLowerCase(), token, expiresAt, shareUrl },
    },
  };
}
