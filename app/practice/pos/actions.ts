'use server';

import crypto from 'crypto';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  isAllowedBillAmount,
  MIN_BILL_AMOUNT,
  MAX_BILL_AMOUNT,
  formatRandLimit,
} from '@/lib/config/billAmountLimits';
import { checkTradingGate } from '@/lib/practice/tradingGate';
import { normalizePhoneZA } from '@/lib/validation';
import { captureBillIdentity } from '@/lib/patients/billIdentityCapture';
import type { DeliveryMethod } from '@/lib/patients/billIdentity';
import { CHECKOUT_SESSION_TTL_MS } from '@/lib/checkout/sessionTtl';
import { sendPatientInvitationEmail } from '@/lib/email/templates/patientInvitation';
import { sendExistingPatientBillEmail } from '@/lib/email/templates/existingPatientBill';
import {
  requireUnlockedDevice,
  hashTillSecret,
  generateDeviceSecret,
  PIN_MAX_ATTEMPTS,
  PIN_LOCKOUT_MS,
} from '@/lib/auth/tillDevice';
import {
  providerMemberName,
  type ProviderMemberRef,
} from '@/lib/practice/providerIdentity';
import {
  resolveTodaysTillActivity,
  type TillActivity,
} from '@/lib/practice/tillActivity';

// ─── /practice/pos server actions — device-gated, no user session ─────
//
// Every action in this file authenticates via a till device credential
// (lib/auth/tillDevice.ts's requireUnlockedDevice) instead of a normal
// Supabase user JWT — there is NO supabase.auth.getUser() anywhere in
// this file. The device resolves practice_id the same way an
// authenticated user's practice_members row would; the checks below
// (trading gate, provider membership) are unchanged in substance, just
// re-scoped to that resolved practiceId and run via the service-role
// client since there's no user session to drive RLS with.
//
// Manager actions (generate code / revoke / set PIN) are a SEPARATE
// file (./devices/actions.ts) on the NORMAL per-user login model —
// unchanged auth, unaffected by anything here.

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ─── redeemDeviceRegistrationCode ──────────────────────────────────────
//
// Anon-reachable (the till registration screen, by definition, has no
// device and no user session yet). Generates the device's own secret
// HERE in Node — never in SQL — hashes both the entered code and the
// new secret, and calls the atomic RPC. The plaintext secret is
// returned to the caller exactly once; the caller (the register page)
// is responsible for storing it in localStorage.

export type RedeemCodeResult =
  | { error: string;  deviceSecret?: undefined }
  | { error: null;    deviceSecret: string };

// Friendly device name is REQUIRED at registration (the till identifies
// itself); the raw user-agent is captured so a manager can see the model.
const MAX_LABEL_LEN      = 60;
const MAX_USER_AGENT_LEN = 512;

export async function redeemDeviceRegistrationCode(
  code:      string,
  label:     string,
  userAgent: string,
): Promise<RedeemCodeResult> {
  const trimmed = code.trim();
  if (!/^\d{8}$/.test(trimmed)) {
    return { error: 'Enter the 8-digit code exactly as shown on the manager\'s screen.' };
  }

  const cleanLabel = (label ?? '').trim();
  if (!cleanLabel) {
    return { error: 'Enter a name for this till (e.g. "Front desk PC").' };
  }
  if (cleanLabel.length > MAX_LABEL_LEN) {
    return { error: `Device name must be ${MAX_LABEL_LEN} characters or fewer.` };
  }
  const cleanUserAgent = (userAgent ?? '').trim().slice(0, MAX_USER_AGENT_LEN) || null;

  const codeHash    = hashTillSecret(trimmed);
  const deviceSecret = generateDeviceSecret();
  const secretHash   = hashTillSecret(deviceSecret);

  const client = svc();
  const { data, error } = await client.rpc('redeem_till_registration_code', {
    p_code_hash:   codeHash,
    p_secret_hash: secretHash,
  });
  if (error) return { error: 'Could not verify the code. Please try again.' };

  const row    = Array.isArray(data) ? data[0] : data;
  const result = row?.result as string | undefined;

  if (result === 'invalid_code') return { error: 'That code is not valid.' };
  if (result === 'already_used') return { error: 'That code has already been used.' };
  if (result === 'expired')      return { error: 'That code has expired. Ask your manager for a new one.' };
  if (result !== 'ok')           return { error: 'Could not register this till. Please try again.' };

  // Stamp the name + captured model onto the freshly-minted row. Cosmetic
  // metadata, not the credential — so a failure here must NOT strand a
  // successfully-registered till (the secret is what matters, and a
  // manager can rename it later via relabelDevice). Best-effort: on error
  // we still return the secret; the device is usable, just unnamed until
  // relabelled.
  const deviceId = row?.device_id as string | undefined;
  if (deviceId) {
    await client
      .from('till_devices')
      .update({ label: cleanLabel, user_agent: cleanUserAgent })
      .eq('id', deviceId);
  }

  return { error: null, deviceSecret };
}

// ─── unlockTill — daily/idle PIN unlock ────────────────────────────────
//
// Brute-force guard: 5 wrong attempts locks the till for 15 minutes
// (PIN_LOCKOUT_MS) — checked BEFORE the PIN comparison, so a locked-out
// till rejects even a subsequently-CORRECT PIN until the cooldown
// elapses. A correct PIN resets pin_attempts to 0.

export async function unlockTill(deviceSecret: string, pin: string): Promise<{ error: string | null }> {
  if (!deviceSecret) return { error: 'No device registered on this till.' };
  if (!pin)           return { error: 'Enter the till PIN.' };

  const client = svc();
  const secretHash = hashTillSecret(deviceSecret);

  const { data: device } = await client
    .from('till_devices')
    .select('id, practice_id, revoked_at, pin_attempts, pin_locked_until')
    .eq('secret_hash', secretHash)
    .maybeSingle();
  if (!device) return { error: 'This till is not registered. Please register it again.' };
  if (device.revoked_at) return { error: 'This device has been revoked. Contact your practice manager.' };

  const now = new Date();
  if (device.pin_locked_until && new Date(device.pin_locked_until as string) > now) {
    return { error: 'Too many incorrect attempts. Please wait before trying again.' };
  }

  const { data: practice } = await client
    .from('practices')
    .select('till_pin_hash')
    .eq('id', device.practice_id as string)
    .maybeSingle();
  if (!practice?.till_pin_hash) {
    return { error: 'No till PIN has been set for this practice yet. Ask your manager to set one.' };
  }

  if (hashTillSecret(pin) !== practice.till_pin_hash) {
    const attempts = ((device.pin_attempts as number | null) ?? 0) + 1;
    const patch: Record<string, unknown> = { pin_attempts: attempts };
    if (attempts >= PIN_MAX_ATTEMPTS) {
      patch.pin_locked_until = new Date(Date.now() + PIN_LOCKOUT_MS).toISOString();
    }
    await client.from('till_devices').update(patch).eq('id', device.id as string);
    return {
      error: attempts >= PIN_MAX_ATTEMPTS
        ? 'Too many incorrect attempts. This till is locked for 15 minutes.'
        : 'Incorrect PIN.',
    };
  }

  await client.from('till_devices').update({
    unlocked_at:      now.toISOString(),
    last_activity_at: now.toISOString(),
    pin_attempts:     0,
    pin_locked_until: null,
  }).eq('id', device.id as string);

  return { error: null };
}

// ─── checkDeviceStatus — the ONLY practice-data-bearing call ──────────
//
// Every state BEFORE 'unlocked' returns NOTHING practice-scoped — no
// practice_id, no practice name, no providers. The page (Build D) never
// fetches or renders practice data until this call itself confirms
// 'unlocked'; there is no separate path that could leak it earlier.

// Membership-keyed since 0094, matching the desktop bill form's option shape:
// a roster-only practitioner has no auth user, and a plan is attributed to the
// membership either way.
export type ProviderOption = { memberId: string; name: string };

export type DeviceStatus =
  | { state: 'no_device' }
  | { state: 'revoked' }
  | { state: 'locked' }
  | { state: 'unlocked'; practiceId: string; practiceName: string; providers: ProviderOption[] };

export async function checkDeviceStatus(deviceSecret: string | null): Promise<DeviceStatus> {
  if (!deviceSecret) return { state: 'no_device' };

  const result = await requireUnlockedDevice(deviceSecret);
  if (!result.ok) {
    if (result.code === 'no_device') return { state: 'no_device' };
    if (result.code === 'revoked')   return { state: 'revoked' };
    return { state: 'locked' };
  }

  const client = svc();
  const [{ data: practice }, { data: providerRows }] = await Promise.all([
    client.from('practices').select('name').eq('id', result.practiceId).maybeSingle(),
    client
      .from('practice_members')
      .select('id, user_id, provider_first_name, provider_last_name, specialty, profiles(first_name, last_name)')
      .eq('practice_id', result.practiceId)
      .eq('active', true)
      .eq('role', 'provider'),
  ]);

  // Membership-keyed since 0094, and roster-only practitioners are included:
  // the till must be able to raise a bill for the same people the desktop
  // form can.
  const providers: ProviderOption[] = ((providerRows ?? []) as unknown as ProviderMemberRef[])
    .map((m) => ({ memberId: m.id, name: providerMemberName(m) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    state:        'unlocked',
    practiceId:   result.practiceId,
    practiceName: (practice?.name as string | undefined) ?? 'Practice',
    providers,
  };
}

// ─── issueCounterSession — POS/counter bill issuance ─────────────────
//
// The till-side counterpart to createBill (app/practice/bills/new/
// actions.ts). Same amount/trading-gate/provider checks; the auth
// model is now the device credential, not a logged-in user, and the
// identity captured at issuance is a patient SA ID NUMBER (teller-
// typed, cell optional) minting a short-TTL checkout_sessions row
// rendered as an on-screen QR (migration 0085).
//
// The SA ID is encrypted immediately and returned to NOTHING — the
// till only ever gets back the opaque token + expiry. It never lands
// in the response payload, so it can't end up in till/reception
// client state, logs, or a browser autocomplete cache.

export type IssueCounterSessionInput = {
  deviceSecret: string;
  billAmount:   number;
  saIdNumber:   string;
  cellNumber?:  string;
  providerMemberId: string;
  /** Defaults to 'qr' — the till's original and still-default behaviour. */
  delivery?:    DeliveryMethod;
  /** REQUIRED under email delivery, and not collected under QR. */
  patientEmail?: string;
};

export type IssueCounterSessionResult = {
  error:      string | null;
  /** QR delivery only — the scannable secret. */
  token?:     string;
  /** QR delivery only. */
  expiresAt?: string;
  planId?:    string;
  /**
   * Email delivery only. Whether the bill actually reached the address —
   * a silent send failure would leave the teller thinking the patient has
   * a bill they will never see.
   */
  emailSent?: boolean;
};

export async function issueCounterSession(
  data: IssueCounterSessionInput,
): Promise<IssueCounterSessionResult> {
  const { billAmount, providerMemberId, deviceSecret } = data;
  const delivery: DeliveryMethod = data.delivery === 'email' ? 'email' : 'qr';

  const auth = await requireUnlockedDevice(deviceSecret);
  if (!auth.ok) return { error: auth.error };
  const practiceId = auth.practiceId;

  if (!isAllowedBillAmount(billAmount)) {
    return {
      error: `Bill amount must be between ${formatRandLimit(MIN_BILL_AMOUNT)} and ${formatRandLimit(MAX_BILL_AMOUNT)}.`,
    };
  }
  if (!providerMemberId) {
    return { error: 'A healthcare provider must be selected.' };
  }

  let normalizedCell: string | null = null;
  if (data.cellNumber && data.cellNumber.trim()) {
    normalizedCell = normalizePhoneZA(data.cellNumber);
    if (!normalizedCell) return { error: 'Enter a valid South African cellphone number, or leave it blank.' };
  }

  const client = svc();

  const gate = await checkTradingGate(client, practiceId);
  if (!gate.ok) return { error: gate.message };

  // Membership-keyed since 0094 so a roster-only practitioner can be billed
  // for at the till too. practice_id is still asserted alongside the id.
  const { data: providerMember } = await client
    .from('practice_members')
    .select('id, user_id')
    .eq('id', providerMemberId)
    .eq('practice_id', practiceId)
    .eq('active', true)
    .eq('role', 'provider')
    .maybeSingle();
  if (!providerMember) return { error: 'Selected provider is not a provider on this practice.' };

  // ── Identity ───────────────────────────────────────────────────────────
  //
  // The SAME capture the dashboard runs: validation, the 18+ gate, both
  // lookups, and the five-case conflict rule. The till used to validate
  // and encrypt inline and never look the ID up at all, which is why a
  // returning patient's plan stayed unbound until they scanned.
  const identity = await captureBillIdentity({
    svc:          client,
    saIdNumber:   data.saIdNumber,
    patientEmail: data.patientEmail ?? null,
    delivery,
  });
  if (!identity.ok) return { error: identity.error };

  const { data: invoiceNumber, error: invoiceError } = await client.rpc('next_invoice_number');
  if (invoiceError || !invoiceNumber) {
    return { error: 'Failed to generate invoice number. Please try again.' };
  }

  const encryptedSaId = identity.encryptedSaId;

  // ── Create the plan the same way createBill does. patient_id is now
  // stamped AT ISSUANCE when the ID already has an account — that is what
  // makes the SA ID the customer key rather than something matched later
  // at checkout. It stays null only when the ID belongs to nobody yet, in
  // which case claimUnboundSessionPlan still binds it at scan time. All
  // writes below go through the service-role client — there is no user
  // session in this path to drive RLS with. ──────────────────────────
  const applicationId = crypto.randomUUID();
  const { error: appError } = await client.from('applications').insert({
    id:          applicationId,
    patient_id:  identity.patientId,
    practice_id: practiceId,
    bill_amount: billAmount,
    status:      'pending',
  });
  if (appError) return { error: `Failed to create application: ${appError.message}` };

  const planId = crypto.randomUUID();
  const { error: planError } = await client.from('plans').insert({
    id:                 planId,
    application_id:     applicationId,
    patient_id:         identity.patientId,
    practice_id:        practiceId,
    provider_member_id: providerMemberId,
    total_amount:       billAmount,
    status:             'pending_acceptance',
    invoice_number:     invoiceNumber,
  });
  if (planError) {
    await client.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to create plan: ${planError.message}` };
  }

  // ── Delivery: email ────────────────────────────────────────────────────
  //
  // Bills get issued when the patient is not standing there, and some
  // patients cannot or will not scan. The till gets the same choice the
  // dashboard has; only the way the link travels differs.
  if (delivery === 'email') {
    const toEmail = identity.normalizedEmail;
    if (!toEmail) {
      // Unreachable: captureBillIdentity refuses email delivery with no
      // address. Narrowed rather than asserted so a reshuffle fails here.
      await client.from('plans').delete().eq('id', planId);
      await client.from('applications').delete().eq('id', applicationId);
      return { error: 'Enter the patient’s email address.' };
    }

    const { data: practiceRow } = await client
      .from('practices')
      .select('name')
      .eq('id', practiceId)
      .maybeSingle();
    const practiceName = (practiceRow?.name as string | undefined) ?? 'your practice';
    const appUrl       = process.env.NEXT_PUBLIC_APP_URL ?? '';

    // Bound: the bill is already on their dashboard, so the email points
    // there. Unbound: an invitation carrying the checkout link, exactly as
    // createBill's own new-patient branch does.
    if (identity.patientId) {
      const sent = await sendExistingPatientBillEmail({
        to:           toEmail,
        practiceName,
        amount:       billAmount,
        dashboardUrl: `${appUrl}/patient/orders/${planId}/confirm`,
      });
      if (!sent.ok) console.error('[issueCounterSession] existing-patient bill email failed', sent.error);
      return { error: null, planId, emailSent: sent.ok };
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteExp   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: inviteError } = await client.from('patient_invitations').insert({
      id:          crypto.randomUUID(),
      email:       toEmail,
      plan_id:     planId,
      practice_id: practiceId,
      // No logged-in user in this flow, and provider_id references
      // profiles(id) — a roster-only practitioner has none either.
      provider_id: providerMember.user_id ?? null,
      token:       inviteToken,
      expires_at:  inviteExp,
    });
    if (inviteError) {
      await client.from('plans').delete().eq('id', planId);
      await client.from('applications').delete().eq('id', applicationId);
      return { error: `Failed to create invitation: ${inviteError.message}` };
    }

    const sent = await sendPatientInvitationEmail({
      to:          toEmail,
      practiceName,
      amount:      billAmount,
      checkoutUrl: `${appUrl}/checkout/${inviteToken}`,
      expiresAt:   inviteExp,
    });
    if (!sent.ok) console.error('[issueCounterSession] invitation email failed', sent.error);
    return { error: null, planId, emailSent: sent.ok };
  }

  // ── Delivery: QR — the till's original path, unchanged ─────────────────
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CHECKOUT_SESSION_TTL_MS).toISOString();

  const { error: sessionError } = await client.from('checkout_sessions').insert({
    token,
    practice_id:          practiceId,
    plan_id:              planId,
    sa_id_number:         encryptedSaId,
    cell_e164:            normalizedCell,
    expires_at:           expiresAt,
    // Audit trail (Build D): which device issued this bill. Never a
    // user id — there is no logged-in user in this flow.
    issued_via_device_id: auth.deviceId,
  });
  if (sessionError) {
    await client.from('plans').delete().eq('id', planId);
    await client.from('applications').delete().eq('id', applicationId);
    return { error: `Failed to create checkout session: ${sessionError.message}` };
  }

  return { error: null, token, expiresAt, planId };
}

// ─── Shared guard — device scoped to a session's own practice ─────────
//
// expire/getStage/acknowledge all need the SAME check: a currently-
// unlocked device whose OWN practice_id matches the session's
// practice_id — a device must not be able to touch another practice's
// session even if it somehow obtained that session's token.
async function requireDeviceForSession(
  deviceSecret: string,
  token:        string,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ ok: true; svc: any } | { ok: false; error: string }> {
  const auth = await requireUnlockedDevice(deviceSecret);
  if (!auth.ok) return { ok: false, error: auth.error };

  const client = svc();
  const { data: session } = await client
    .from('checkout_sessions')
    .select('practice_id')
    .eq('token', token)
    .maybeSingle();
  if (!session) return { ok: false, error: 'Session not found.' };
  if ((session.practice_id as string) !== auth.practiceId) {
    return { ok: false, error: 'This session does not belong to this till.' };
  }

  return { ok: true, svc: client };
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
  deviceSecret: string,
  token:        string,
  opts?:        { force?: boolean },
): Promise<{ error: string | null }> {
  if (!token) return { error: 'Missing token.' };

  const auth = await requireDeviceForSession(deviceSecret, token);
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
export type CounterSessionStage =
  | 'created' | 'scanned' | 'completed' | 'declined' | 'expired' | 'payment_failed';

export async function getCounterSessionStage(
  deviceSecret: string,
  token:        string,
): Promise<{ error: string | null; stage?: CounterSessionStage }> {
  if (!token) return { error: 'Missing token.' };

  const auth = await requireDeviceForSession(deviceSecret, token);
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

// ─── getTodaysCounterSessions — the today's-activity strip's read ──────
//
// The till renders one session at a time and "Start next patient" throws
// it away, so "did that bill go through?" — the question a front desk is
// asked all day, in person and on the phone — had no answer anywhere on
// this screen. This is that answer.
//
// AUTH: the SAME path as every other action in this file, deliberately
// and with nothing added. requireUnlockedDevice proves a registered,
// unlocked, unrevoked device and RESOLVES the practice id; the read is
// then scoped to that resolved id. Three things follow, and each of them
// is the point:
//
//   • practiceId is never a parameter. The till cannot ask for another
//     practice's day, because it cannot name one — the only thing it
//     sends is its own secret.
//   • no new auth path exists. This introduces no RPC, no policy, and no
//     token; it is the fourth caller of a guard that already had three.
//   • nothing is read from the client. checkout_sessions' own RLS policy
//     (practice_biller_select, 0085) is keyed on is_practice_biller and
//     therefore on auth.uid(), which the till does not have — a
//     client-side query would return zero rows even if one were written,
//     and writing one would mean granting anon access to a table holding
//     encrypted SA IDs. So the read lives here, server-side, behind the
//     device credential.
//
// A locked or revoked till gets the SAME error strings requireUnlockedDevice
// already returns, which TillShell's DEVICE_AUTH_ERROR_MESSAGES set
// recognises — so the strip failing over to the PIN screen is existing
// behaviour reused, not new handling.
export type TodaysCounterSessionsResult =
  | { error: string; activity?: undefined }
  | { error: null;   activity: TillActivity };

export async function getTodaysCounterSessions(
  deviceSecret: string,
): Promise<TodaysCounterSessionsResult> {
  const auth = await requireUnlockedDevice(deviceSecret);
  if (!auth.ok) return { error: auth.error };

  const activity = await resolveTodaysTillActivity(svc(), auth.practiceId);
  return { error: null, activity };
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
// checkout_sessions.confirmed_by (profiles FK, from the pre-device-auth
// design) is deliberately left NULL here — there is no logged-in staff
// member in this flow to attribute it to. The row's own
// issued_via_device_id already carries device-level attribution;
// confirmed_at alone is enough to prove SOMEONE at the till
// acknowledged it, at that timestamp.
//
// Idempotent: the UPDATE only matches a session that is stage='completed'
// AND not yet acknowledged, so a second call (already confirmed_at IS
// NOT NULL) safely no-ops rather than erroring or double-writing. An
// attempt on a session that never reached 'completed' is rejected with
// a real error, distinct from the idempotent-already-acknowledged case.
export async function acknowledgeCounterSession(
  deviceSecret: string,
  token:        string,
): Promise<{ error: string | null }> {
  if (!token) return { error: 'Missing token.' };

  const auth = await requireDeviceForSession(deviceSecret, token);
  if (!auth.ok) return { error: auth.error };

  const { data: updated, error } = await auth.svc
    .from('checkout_sessions')
    .update({ confirmed_at: new Date().toISOString() })
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
