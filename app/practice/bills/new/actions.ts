'use server';

import crypto from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { calculateFee } from '@/lib/finance';
import {
  isAllowedBillAmount,
  MIN_BILL_AMOUNT,
  MAX_BILL_AMOUNT,
  formatRandLimit,
} from '@/lib/config/billAmountLimits';
import { checkTradingGate } from '@/lib/practice/tradingGate';
import { sendPatientInvitationEmail } from '@/lib/email/templates/patientInvitation';
import { sendExistingPatientBillEmail } from '@/lib/email/templates/existingPatientBill';
import { isDuplicateBill, RECENT_BILL_WINDOW_MS } from './_lib/idempotency';
import { captureBillIdentity } from '@/lib/patients/billIdentityCapture';
import type { DeliveryMethod } from '@/lib/patients/billIdentity';
import { CHECKOUT_SESSION_TTL_MS } from '@/lib/checkout/sessionTtl';
import { maskId } from '@/lib/idEncryption';

// ─── Public surface ──────────────────────────────────────────────────────────
//
// IDENTITY vs DELIVERY
//   The SA ID number is the CUSTOMER key. QR and email are DELIVERY
//   methods. This action used to conflate the two: it took an email, never
//   asked for an ID, and decided who the bill belonged to from the email
//   lookup alone — while the till took an ID and no email. The whole
//   decision now lives in lib/patients/billIdentityCapture.ts, which both
//   surfaces call, and this file only issues what it is told to.
//
// DELIVERY = 'qr' (default)
//   A checkout_sessions row + an on-screen QR, exactly as the till issues.
//   Nothing is sent anywhere; the patient scans the code in front of them.
//
// DELIVERY = 'email'
//   Unchanged in shape, and it forks on whether the bill got bound:
//
//   • Bound (the ID resolved to an account) → the bill appears on their
//     dashboard as a pending_acceptance plan; we email "you have a new
//     bill, log in to review and pay". They never see anonymous checkout.
//
//   • Unbound → a patient_invitations row + the checkout link emailed
//     DIRECTLY to that address. The link is NEVER returned to the
//     provider — proving the patient controls the inbox is our email
//     verification, replacing OTP.
//
// If the email send fails (e.g. typo'd address), the provider sees
// the failure in the returned summary and can re-issue with the
// correct address. Silent failure is not OK — the email is the only
// door into the anonymous checkout.

export type CreateBillInput = {
  /**
   * REQUIRED under email delivery, and not collected under QR — the QR is
   * handed to the person standing there, so there is no address to send to
   * and no reason to ask for one.
   */
  patientEmail?:      string;
  /** REQUIRED on every bill. The customer key. */
  saIdNumber:         string;
  /** Defaults to 'qr' — the delivery method, chosen by the practice. */
  delivery?:          DeliveryMethod;
  billAmount:         number;
  practiceReference?: string;
  providerMemberId:   string;
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

// ─── User-facing failure copy ────────────────────────────────────────────
//
// The email provider's own error is operationally useful but must NEVER
// reach the screen. It shipped verbatim to practice users, e.g.:
//   Resend 422: {"statusCode":422,"name":"validation_error","message":"Invalid `to` field..."}
// — the raw provider payload, in front of a receptionist. Every raw
// provider/database string is now logged server-side and replaced with one
// of these before it crosses the 'use server' boundary.
const EMAIL_FAILED_MESSAGE =
  'We couldn\'t send this bill by email. Please check the address and try again.';
const BILL_SAVE_FAILED_MESSAGE =
  'We couldn\'t save this bill. Please try again — if it keeps happening, contact support.';

/** Outcome of the auto-sent email. */
export type InvitationEmailResult = {
  sent:    boolean;
  /**
   * Present when sent=false. ALWAYS plain-language copy written here —
   * never the provider's raw message/JSON. The raw text goes to the
   * server log only (see the console.error calls at each send site).
   */
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
  /**
   * Set ONLY under QR delivery. The token is the scannable secret and is
   * rendered as a QR on the practice's own screen — the same shape the
   * till issues, and like the till it carries no patient identity back.
   */
  counterSession?:    {
    token:     string;
    expiresAt: string;
  };
};

export type CreateBillResult = {
  error:    string | null;
  summary?: CreateBillSummary;
};

// ─── createBill ──────────────────────────────────────────────────────────────

export async function createBill(data: CreateBillInput): Promise<CreateBillResult> {
  const { patientEmail, billAmount, practiceReference, providerMemberId } = data;
  const delivery: DeliveryMethod = data.delivery === 'email' ? 'email' : 'qr';

  if (delivery === 'email' && (!patientEmail || typeof patientEmail !== 'string')) {
    return { error: 'Patient email is required.' };
  }
  if (!isAllowedBillAmount(billAmount)) {
    return {
      error: `Bill amount must be between ${formatRandLimit(MIN_BILL_AMOUNT)} and ${formatRandLimit(MAX_BILL_AMOUNT)}.`,
    };
  }
  if (!providerMemberId) {
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
  //
  // Keyed on the membership row id since 0094. practice_id is still asserted
  // alongside it: the id alone would let a caller attribute a bill to another
  // practice's practitioner, which the previous user_id form also guarded
  // against and which matters more now that the id is client-supplied.
  //
  // user_id is selected but deliberately NOT required — a roster-only
  // practitioner has none, and refusing them here is exactly the gap this
  // change closes. It is read because patient_invitations.provider_id still
  // references profiles(id) and can only carry a real auth user.
  const { data: providerMember } = await supabase
    .from('practice_members')
    .select('id, user_id')
    .eq('id', providerMemberId)
    .eq('practice_id', practiceId)
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

  // ── Identity ───────────────────────────────────────────────────────────
  //
  // One capture for both surfaces: validates the ID (checksum + date), the
  // 18+ gate the till has always applied, both lookups, and the five-case
  // conflict rule. A refusal here is a practice-facing message naming the
  // field to re-check — never anything about the account we matched.
  const identity = await captureBillIdentity({
    svc,
    saIdNumber:   data.saIdNumber,
    patientEmail: patientEmail ?? null,
    delivery,
  });
  if (!identity.ok) return { error: identity.error };

  const boundPatientId = identity.patientId;
  const normalizedEmail = identity.normalizedEmail;

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

  //
  // An UNBOUND QR bill has neither key, so it gets no guard — the same
  // position the till has always been in, and its UI issues one session at
  // a time. A bound QR bill does get the patient_id guard.
  let dupCandidates: Array<{ created_at: string; total_amount: number | string }> = [];
  if (boundPatientId) {
    const { data } = await svc
      .from('plans')
      .select('created_at, total_amount')
      .eq('patient_id', boundPatientId)
      .eq('practice_id', practiceId)
      .gte('created_at', windowStart);
    dupCandidates = (data ?? []) as typeof dupCandidates;
  } else if (normalizedEmail) {
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
    // Stamped from the ID lookup now, not the email lookup. This is what
    // makes the SA ID the key rather than a thing matched at checkout.
    patient_id:  boundPatientId,
    practice_id: practiceId,
    bill_amount: billAmount,
    status:      'pending',
  });
  if (appError) {
    console.error('[createBill] Failed to create application', appError.message);
    return { error: BILL_SAVE_FAILED_MESSAGE };
  }

  const planId = crypto.randomUUID();
  const { error: planError } = await supabase.from('plans').insert({
    id:                 planId,
    application_id:     applicationId,
    patient_id:         boundPatientId,
    practice_id:        practiceId,
    provider_member_id: providerMemberId,
    total_amount:       billAmount,
    status:             'pending_acceptance',
    invoice_number:     invoiceNumber,
    practice_reference: practiceReference?.trim() || null,
  });
  if (planError) {
    await supabase.from('applications').delete().eq('id', applicationId);
    console.error('[createBill] Failed to create plan', planError.message);
    return { error: BILL_SAVE_FAILED_MESSAGE };
  }

  const trimmedRef = practiceReference?.trim() || undefined;
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL ?? '';

  // ── Delivery: QR ───────────────────────────────────────────────────────
  //
  // The same checkout_sessions row the till mints, with the same TTL and
  // the same encrypted SA ID. issued_via_device_id is NULL here — the
  // column is nullable precisely because it records WHICH till issued a
  // bill, and this one came from a logged-in user on the dashboard, whose
  // authorisation was already established above.
  //
  // Nothing about the patient goes back to the caller: the response
  // carries the token and the expiry, exactly as issueCounterSession's
  // does. If the ID matched an account we bound the plan, but the practice
  // is told only that the bill exists.
  if (delivery === 'qr') {
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CHECKOUT_SESSION_TTL_MS).toISOString();

    const { error: sessionError } = await svc.from('checkout_sessions').insert({
      token,
      practice_id:          practiceId,
      plan_id:              planId,
      sa_id_number:         identity.encryptedSaId,
      expires_at:           expiresAt,
      issued_via_device_id: null,
    });
    if (sessionError) {
      await supabase.from('plans').delete().eq('id', planId);
      await supabase.from('applications').delete().eq('id', applicationId);
      console.error('[createBill] Failed to create checkout session', sessionError.message);
      return { error: BILL_SAVE_FAILED_MESSAGE };
    }

    return {
      error: null,
      summary: {
        gross,
        fee,
        net,
        // Masked, never a name. Under QR the practice proved it knows the
        // ID and nothing else, so the ID is all it gets back.
        patientName:       maskId(identity.saIdPlain),
        invoiceNumber,
        practiceReference: trimmedRef,
        planId,
        counterSession:    { token, expiresAt },
      },
    };
  }

  // ── Delivery: email, to an account we bound ────────────────────────────
  // Bill appears on their dashboard. Email them "log in to review".
  if (boundPatientId && normalizedEmail) {
    // Read the name only HERE. Reaching this branch means the typed
    // address belongs to the bound account (case B, or case C where the
    // address matched), so the practice has already demonstrated it knows
    // who this is — displaying the name tells it nothing new. Under any
    // other case we never get here and never read the name.
    const { data: boundProfile } = await svc
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', boundPatientId)
      .maybeSingle();

    const dashboardUrl = `${appUrl}/patient/orders/${planId}/confirm`;
    const emailResult  = await sendExistingPatientBillEmail({
      to:           normalizedEmail,
      practiceName,
      amount:       billAmount,
      dashboardUrl,
    });
    if (!emailResult.ok) {
      // Raw provider text stays here, in the log, where it's useful.
      console.error('[createBill] existing-patient bill email failed', emailResult.error);
    }

    return {
      error: null,
      summary: {
        gross,
        fee,
        net,
        patientName:       `${boundProfile?.first_name ?? ''} ${boundProfile?.last_name ?? ''}`.trim() || normalizedEmail,
        invoiceNumber,
        practiceReference: trimmedRef,
        planId,
        existingAccount: {
          email:         normalizedEmail,
          emailDelivery: {
            sent:  emailResult.ok,
            error: emailResult.ok ? undefined : EMAIL_FAILED_MESSAGE,
            to:    normalizedEmail,
          },
        },
      },
    };
  }

  // ── Delivery: email, to a patient with no account yet (case A) ─────────
  //
  // Unreachable with a null address: captureBillIdentity refuses email
  // delivery without one, and the QR branch above has already returned.
  // Narrowed rather than asserted with `!` so a future reshuffle that
  // breaks the invariant fails here instead of emailing `null`.
  if (!normalizedEmail) {
    console.error('[createBill] email delivery reached the invitation branch with no address');
    return { error: BILL_SAVE_FAILED_MESSAGE };
  }

  const token        = crypto.randomBytes(32).toString('hex');
  const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const invitationId = crypto.randomUUID();

  const { error: inviteError } = await supabase.from('patient_invitations').insert({
    id:          invitationId,
    email:       normalizedEmail,
    plan_id:     planId,
    practice_id: practiceId,
    provider_id: providerMember.user_id ?? null,
    token,
    expires_at:  expiresAt,
  });

  if (inviteError) {
    console.error('[createBill] Failed to create invitation', inviteError.message);
    return { error: BILL_SAVE_FAILED_MESSAGE };
  }

  const checkoutUrl = `${appUrl}/checkout/${token}`;
  const emailResult = await sendPatientInvitationEmail({
    to:           normalizedEmail,
    practiceName,
    amount:       billAmount,
    checkoutUrl,
    expiresAt,
  });
  if (!emailResult.ok) {
    // Raw provider text stays here, in the log, where it's useful.
    console.error('[createBill] invitation email failed', emailResult.error);
  }

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
          error: emailResult.ok ? undefined : EMAIL_FAILED_MESSAGE,
          to:    normalizedEmail,
        },
      },
    },
  };
}
