'use server';

import crypto from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import {
  isAllowedBillAmount,
  MIN_BILL_AMOUNT,
  MAX_BILL_AMOUNT,
  formatRandLimit,
} from '@/lib/config/billAmountLimits';
import { checkTradingGate } from '@/lib/practice/tradingGate';
import { encryptId } from '@/lib/idEncryption';
import { validateSaId, saIdAge, normalizePhoneZA } from '@/lib/validation';

// ─── issueCounterSession — POS/counter bill issuance ─────────────────
//
// The till-side counterpart to createBill (app/practice/bills/new/
// actions.ts). Same auth/scope/amount/trading-gate checks; the
// difference is the identity captured at issuance:
//
//   • createBill takes a patient EMAIL and mints a 7-day
//     patient_invitations row emailed to that address.
//   • issueCounterSession takes a patient SA ID NUMBER (teller-typed,
//     cell optional) and mints a short-TTL checkout_sessions row
//     rendered as an on-screen QR — see migration 0085.
//
// The SA ID is encrypted immediately and returned to NOTHING — the
// till only ever gets back the opaque token + expiry. It never lands
// in the response payload, so it can't end up in till/reception
// client state, logs, or a browser autocomplete cache.
//
// Reuses the existing spine: the plan is created the same way
// createBill creates one (applications + plans, patient_id null until
// the patient completes the phone-side checkout), so downstream
// activation (activateFirstInstalment) needs no POS-specific branch.

const SESSION_TTL_MS = 2 * 60 * 1000; // ~2 minutes

export type IssueCounterSessionInput = {
  billAmount:  number;
  saIdNumber:  string;
  cellNumber?: string;
  providerId:  string;
  practiceId?: string;
};

export type IssueCounterSessionResult = {
  error:      string | null;
  token?:     string;
  expiresAt?: string;
  planId?:    string;
};

export async function issueCounterSession(
  data: IssueCounterSessionInput,
): Promise<IssueCounterSessionResult> {
  const { billAmount, providerId } = data;

  if (!isAllowedBillAmount(billAmount)) {
    return {
      error: `Bill amount must be between ${formatRandLimit(MIN_BILL_AMOUNT)} and ${formatRandLimit(MAX_BILL_AMOUNT)}.`,
    };
  }
  if (!providerId) {
    return { error: 'A healthcare provider must be selected.' };
  }

  const saIdResult = validateSaId(data.saIdNumber);
  if (!saIdResult.valid) {
    return { error: 'Enter a valid 13-digit SA ID number.' };
  }
  const age = saIdAge(data.saIdNumber);
  if (age === null || age < 18) {
    return { error: 'The patient must be 18 or older.' };
  }

  let normalizedCell: string | null = null;
  if (data.cellNumber && data.cellNumber.trim()) {
    normalizedCell = normalizePhoneZA(data.cellNumber);
    if (!normalizedCell) return { error: 'Enter a valid South African cellphone number, or leave it blank.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  // ── Practice scope resolution — identical to createBill's rule ──────
  let practiceId: string;
  if (data.practiceId) {
    const { data: scopedMembership } = await supabase
      .from('practice_members')
      .select('practice_id')
      .eq('user_id',     user.id)
      .eq('practice_id', data.practiceId)
      .eq('active',      true)
      .maybeSingle();
    if (!scopedMembership) return { error: 'You are not an active member of that practice.' };
    practiceId = scopedMembership.practice_id as string;
  } else {
    const { data: memberships } = await supabase
      .from('practice_members')
      .select('practice_id, created_at')
      .eq('user_id', user.id)
      .eq('active',  true)
      .order('created_at', { ascending: true })
      .limit(1);
    if (!memberships || memberships.length === 0) {
      return { error: 'You are not a member of any active practice.' };
    }
    practiceId = memberships[0].practice_id as string;
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const gate = await checkTradingGate(svc, practiceId);
  if (!gate.ok) return { error: gate.message };

  const { data: providerMember } = await supabase
    .from('practice_members')
    .select('user_id')
    .eq('practice_id', practiceId)
    .eq('user_id', providerId)
    .eq('active', true)
    .eq('role', 'provider')
    .maybeSingle();
  if (!providerMember) return { error: 'Selected provider is not a provider on this practice.' };

  const { data: invoiceNumber, error: invoiceError } = await svc.rpc('next_invoice_number');
  if (invoiceError || !invoiceNumber) {
    return { error: 'Failed to generate invoice number. Please try again.' };
  }

  let encryptedSaId: string;
  try {
    encryptedSaId = encryptId(data.saIdNumber.trim());
  } catch {
    return { error: 'Encryption error — please contact support.' };
  }

  // ── Create the plan the same way createBill does — patient_id is
  // null until the phone-side checkout resolves who's paying. ──────────
  const applicationId = crypto.randomUUID();
  const { error: appError } = await supabase.from('applications').insert({
    id:          applicationId,
    patient_id:  null,
    practice_id: practiceId,
    bill_amount: billAmount,
    status:      'pending',
  });
  if (appError) return { error: `Failed to create application: ${appError.message}` };

  const planId = crypto.randomUUID();
  const { error: planError } = await supabase.from('plans').insert({
    id:                 planId,
    application_id:     applicationId,
    patient_id:         null,
    practice_id:        practiceId,
    provider_id:        providerId,
    total_amount:       billAmount,
    status:             'pending_acceptance',
    invoice_number:     invoiceNumber,
  });
  if (planError) {
    await supabase.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to create plan: ${planError.message}` };
  }

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  const { error: sessionError } = await supabase.from('checkout_sessions').insert({
    token,
    practice_id:  practiceId,
    plan_id:      planId,
    sa_id_number: encryptedSaId,
    cell_e164:    normalizedCell,
    expires_at:   expiresAt,
  });
  if (sessionError) {
    await supabase.from('plans').delete().eq('id', planId);
    await supabase.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to create checkout session: ${sessionError.message}` };
  }

  return { error: null, token, expiresAt, planId };
}
