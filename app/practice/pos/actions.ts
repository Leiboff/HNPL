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

// ─── Shared auth guard — practice biller scoped to a session's practice ──
//
// Every action below (expire, read stage, acknowledge) needs the SAME
// check: the caller is an authenticated, active practice_members row on
// the SPECIFIC practice the session belongs to — not merely "some
// practice". This is the real server-side authorization boundary; the
// till UI hiding a button is not a substitute for it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

async function requireBillerForSession(
  token: string,
): Promise<
  | { ok: true;  userId: string; practiceId: string; svc: Svc }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Session expired. Please log in again.' };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: session } = await svc
    .from('checkout_sessions')
    .select('practice_id')
    .eq('token', token)
    .maybeSingle();
  if (!session) return { ok: false, error: 'Session not found.' };

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id')
    .eq('user_id',     user.id)
    .eq('practice_id', session.practice_id as string)
    .eq('active',      true)
    .maybeSingle();
  if (!membership) return { ok: false, error: 'You are not an active member of that practice.' };

  return { ok: true, userId: user.id, practiceId: session.practice_id as string, svc };
}

// ─── expireCounterSession — first-timer hard-stop trigger ─────────────
//
// Called from the till at the two natural abandonment points: the
// countdown reaching zero (force=false — only acts if actually past
// expires_at) and "Start next patient" clicked on a non-terminal
// session (force=true — the teller moving on IS abandonment,
// independent of the clock). The actual decline logic is the single
// canonical expire_stale_checkout_session SQL function (migration
// 0085) — also called as a lazy fail-safe from get_checkout_session_by_
// token, stamp_checkout_session_scanned, and resolveCheckoutToken, so a
// session can never be left dangling even if this call is missed
// (dropped request, closed tab).
export async function expireCounterSession(
  token: string,
  opts?: { force?: boolean },
): Promise<{ error: string | null }> {
  if (!token) return { error: 'Missing token.' };

  const auth = await requireBillerForSession(token);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.svc.rpc('expire_stale_checkout_session', {
    p_token: token,
    p_force: opts?.force ?? false,
  });
  if (error) return { error: error.message };
  return { error: null };
}

// ─── getCounterSessionStage — minimal till-side status read ────────────
//
// Lets the till know when a session reaches 'completed' so it can show
// the acknowledge action (Build D) — the till otherwise has no live
// connection to the session's server-side state at all (it only shows a
// client-side countdown). Deliberately minimal (a single column, no
// realtime subscription) — the full multi-session board is a separate,
// later piece.
export type CounterSessionStage = 'created' | 'scanned' | 'completed' | 'declined' | 'expired';

export async function getCounterSessionStage(
  token: string,
): Promise<{ error: string | null; stage?: CounterSessionStage }> {
  if (!token) return { error: 'Missing token.' };

  const auth = await requireBillerForSession(token);
  if (!auth.ok) return { error: auth.error };

  const { data: session, error } = await auth.svc
    .from('checkout_sessions')
    .select('stage')
    .eq('token', token)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!session) return { error: 'Session not found.' };
  return { error: null, stage: session.stage as CounterSessionStage };
}

// ─── acknowledgeCounterSession — teller's own record-keeping step ──────
//
// Distinct from the patient's payment confirmation, which already
// happened automatically when the session reached 'completed' (via the
// checkout completion route). This is the teller's OWN acknowledgment —
// never a gate on anything else. "Start next patient" works regardless
// of whether the previous session was ever acknowledged (a missed
// acknowledgment must never block the till — see CounterSessionForm).
//
// Idempotent: the UPDATE only matches a session that is stage='completed'
// AND not yet acknowledged, so a second call (already confirmed_at IS
// NOT NULL) safely no-ops rather than erroring or double-writing. An
// attempt on a session that never reached 'completed' is rejected with
// a real error, distinct from the idempotent-already-acknowledged case.
export async function acknowledgeCounterSession(
  token: string,
): Promise<{ error: string | null }> {
  if (!token) return { error: 'Missing token.' };

  const auth = await requireBillerForSession(token);
  if (!auth.ok) return { error: auth.error };

  const { data: updated, error } = await auth.svc
    .from('checkout_sessions')
    .update({ confirmed_by: auth.userId, confirmed_at: new Date().toISOString() })
    .eq('token', token)
    .eq('stage', 'completed')
    .is('confirmed_at', null)
    .select('id')
    .maybeSingle();
  if (error) return { error: error.message };
  if (updated) return { error: null };

  // The UPDATE matched 0 rows — figure out why so the till gets an
  // accurate message instead of a blanket failure.
  const { data: current } = await auth.svc
    .from('checkout_sessions')
    .select('confirmed_at')
    .eq('token', token)
    .maybeSingle();
  if (current?.confirmed_at) return { error: null }; // already acknowledged — safe no-op
  return { error: 'This session is not ready to acknowledge yet.' };
}
