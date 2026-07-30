'use server';

import crypto from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { calculateFee } from '@/lib/finance';
import { checkTradingGate } from '@/lib/practice/tradingGate';
import { sendPatientInvitationEmail } from '@/lib/email/templates/patientInvitation';
import { sendExistingPatientBillEmail } from '@/lib/email/templates/existingPatientBill';
import { isDuplicateBill, RECENT_BILL_WINDOW_MS } from './_lib/idempotency';

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
  /**
   * Which practice this bill is being issued for. REQUIRED when the
   * caller has more than one active practice_members row (any brand-
   * admin who's created multiple branches, and any staff member who
   * happens to work at multiple practices in a brand). When absent,
   * the server picks the caller's oldest active membership — the
   * solo-practice case only.
   *
   * The server ALWAYS re-verifies that the caller has an active
   * membership on the resolved practice, so this parameter is a scope
   * selector, NOT an authorisation bypass. A brand-admin with 3
   * branches cannot pass a practiceId belonging to some OTHER brand
   * — the guard rejects it as "not a member".
   */
  practiceId?:        string;
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
   * The plan we just created. The client uses this to subscribe to
   * realtime updates on the plan row (status → active = "Paid" signal).
   * Returned for BOTH scenarios.
   */
  planId:             string;
  /**
   * Set ONLY when the patient was new (no existing confirmed account).
   * Does NOT carry the checkout URL — the link is in the email and
   * nowhere else. The provider sees the email-delivery outcome.
   * `invitationId` is exposed so the practice's "waiting" panel can
   * subscribe to viewed_at on the row (it is NOT the secret token).
   */
  invitation?:        {
    email:           string;
    expiresAt:       string;
    invitationId:    string;
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

  // ── Practice scope resolution — group→practice acting context ────
  //
  // Pre-0062 there was one practice per user. Post-0062 a brand-admin
  // routinely has N practice_members rows (one per branch they
  // created + one per branch they were invited into). The original
  // `.single()` here threw a 406 for N≥2 and surfaced as "You are not
  // a member of any active practice." — the mis-diagnosed cause of
  // "group→practice bill issue never confirmed working".
  //
  // Rule now: caller passes data.practiceId (from the ?practiceId=
  // scope on the practice dashboard); we verify they have an ACTIVE
  // membership on that specific practice. Absent input → pick the
  // caller's oldest active membership (backward-compat for the solo
  // case). Guard rejects any practice the caller isn't a member of —
  // a brand-admin cannot bill a practice in someone else's brand
  // because they wouldn't have a practice_members row there.
  let practiceId: string;

  if (data.practiceId) {
    const { data: scopedMembership } = await supabase
      .from('practice_members')
      .select('practice_id')
      .eq('user_id',     user.id)
      .eq('practice_id', data.practiceId)
      .eq('active',      true)
      .maybeSingle();

    if (!scopedMembership) {
      return { error: 'You are not an active member of that practice.' };
    }
    practiceId = scopedMembership.practice_id as string;
  } else {
    // No scope supplied — use the caller's oldest active membership.
    // Matches the /practice dashboard's own fallback so a solo user
    // (N=1) sees the same practice on both pages.
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

  // ── Idempotency: short-window dup-create guard ──────────────────────────
  // Catches the hang-then-resubmit pattern (slow outbound call stalled
  // the action, provider refreshes, server work nevertheless succeeded,
  // second submit would create a duplicate bill+invitation). Window is
  // RECENT_BILL_WINDOW_MS (8s, matches the outbound-fetch timeout) — too
  // short to block a legitimate "bill the same patient the same amount
  // a second time" (repeat procedure, correction).
  //
  // Scope: same practice + same patient identity (patient_id for an
  // existing-account match; invitation.email for a new patient) +
  // same total_amount.
  const now = Date.now();
  const windowStart = new Date(now - RECENT_BILL_WINDOW_MS).toISOString();

  let dupCandidates: Array<{ created_at: string; total_amount: number | string }> = [];
  if (patient) {
    const { data } = await svc
      .from('plans')
      .select('created_at, total_amount')
      .eq('patient_id', patient.id)
      .eq('practice_id', practiceId)
      .gte('created_at', windowStart);
    dupCandidates = (data ?? []) as typeof dupCandidates;
  } else {
    // New-patient case: plans don't have patient_id yet. Match via
    // any recent invitation row for this email + practice and pull
    // its plan's amount.
    const { data: recentInvites } = await svc
      .from('patient_invitations')
      .select('plan_id, plans!inner(created_at, total_amount)')
      .eq('email', normalizedEmail)
      .eq('practice_id', practiceId)
      .gte('invited_at', windowStart);
    dupCandidates = (recentInvites ?? []).flatMap((r: { plans: unknown }) => {
      const planRow = Array.isArray(r.plans)
        ? r.plans[0] as { created_at?: string; total_amount?: number | string } | undefined
        : r.plans as { created_at?: string; total_amount?: number | string } | null;
      if (!planRow?.created_at) return [];
      return [{
        created_at:   planRow.created_at,
        total_amount: planRow.total_amount ?? 0,
      }];
    });
  }

  if (isDuplicateBill(dupCandidates, billAmount, now)) {
    return {
      error: 'This bill was just created. Refresh this page to see the confirmation — do not submit again.',
    };
  }

  // Service-role: migration 0056 (2026-06-22) revoked next_invoice_number
  // EXECUTE from the authenticated role to stop any logged-in caller
  // from burning sequence numbers. Bill creation is the sole
  // legitimate caller and routes through svc here.
  const { data: invoiceNumber, error: invoiceError } = await svc.rpc('next_invoice_number');
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
        planId,
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
  const token        = crypto.randomBytes(32).toString('hex');
  const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const invitationId = crypto.randomUUID();

  const { error: inviteError } = await supabase.from('patient_invitations').insert({
    id:          invitationId,
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
      planId,
      invitation: {
        email:         normalizedEmail,
        expiresAt,
        invitationId,
        emailDelivery: {
          sent:  emailResult.ok,
          error: emailResult.ok ? undefined : emailResult.error,
          to:    normalizedEmail,
        },
      },
    },
  };
}
