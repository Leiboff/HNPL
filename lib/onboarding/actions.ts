'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { normalizePhoneZA, validateSaId, saIdAge } from '@/lib/validation';
import { isAllowedSalaryDay } from '@/lib/salaryDates';
import { isValidSalaryAmount } from '@/lib/salaryAmount';
import { currentFlags } from '@/lib/featureFlags';
import { computeOnboarding, type ProfileForOnboarding, type UserForOnboarding } from './state';
import { stubAffordabilityPolicy } from '@/lib/underwriting/stubAffordabilityPolicy';
import { createDiditSession, createDhaFaceMatchSession, diditAppBaseUrl } from '@/lib/didit/client';
import { resolveIdentityRouteForProvider } from '@/lib/onboarding/identityProvider';
import { encryptId, hashIdForLookup } from '@/lib/idEncryption';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';
import { recordIdentitySignals } from '@/lib/security/identitySignals';
import { requestDeviceId, requestIp } from '@/lib/security/requestSignals';

// ─── Server actions for the stepped onboarding gate ───────────────────
//
// One action per step (plus a finalize + a credit-check stub).
// Each action:
//   • Requires the caller to be an authenticated patient.
//   • Validates its own input (client-side is convenience, this is authority).
//   • Writes the step-scoped field(s) to profiles via service-role so
//     the profile update never accidentally requires an RLS policy
//     specific to onboarding.
//   • Calls maybeFinalize() at the end — if every applicable step is
//     now satisfied, we set onboarding_completed=TRUE ourselves.
//   • Returns a small { error, nextPath } shape the client uses to
//     navigate.

type ActionResult =
  | { error: null; nextPath: string }
  | { error: string; nextPath?: string };

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// Small helper — the shape of the profile columns computeOnboarding reads,
// plus the Didit identity-verification columns (UI-display only — they
// don't feed computeOnboarding; sa_id_number/liveness_verified_at do that).
const PROFILE_SELECT =
  'phone_verified_at, sa_id_number, salary_day, salary_amount, credit_check_status, liveness_verified_at, ' +
  'onboarding_completed, identity_verification_status, didit_session_id, first_name, last_name';

async function loadUserAndProfile() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.' };

  const { data: profile } = await svc()
    .from('profiles')
    .select(`role, ${PROFILE_SELECT}`)
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) return { ok: false as const, error: 'Profile not found.' };
  if (profile.role !== 'patient') return { ok: false as const, error: 'Not a patient account.' };

  return {
    ok:      true as const,
    userId:  user.id,
    user:    {
      email_confirmed_at: user.email_confirmed_at ?? null,
      identity_providers: (user.identities ?? []).map((i) => i.provider),
    },
    profile: {
      phone_verified_at:    profile.phone_verified_at    as string | null,
      sa_id_number:         profile.sa_id_number         as string | null,
      salary_day:           profile.salary_day           as number | null,
      salary_amount:        profile.salary_amount        as number | null,
      credit_check_status:  profile.credit_check_status  as string | null,
      liveness_verified_at: profile.liveness_verified_at as string | null,
      onboarding_completed: profile.onboarding_completed as boolean,
    } satisfies ProfileForOnboarding,
    identityVerificationStatus: profile.identity_verification_status as string | null,
    claimedFirstName: profile.first_name as string | null,
    claimedLastName:  profile.last_name  as string | null,
  };
}

// Central "am I done? if so, flag it" helper. Called at the end of
// every step action. Uses the CURRENT flag values — a step that
// auto-passes due to a flag being off still lets us reach a done state.
async function maybeFinalize(
  userId: string,
  user:   UserForOnboarding,
  profile: ProfileForOnboarding,
): Promise<{ done: boolean; nextPath: string }> {
  const status = computeOnboarding(user, profile, currentFlags());
  if (status.done && !profile.onboarding_completed) {
    // Write-once-true. Persist so future flag flips can't retro-lock.
    await svc()
      .from('profiles')
      .update({
        onboarding_completed:    true,
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq('id', userId);
    revalidatePath('/patient', 'layout');
    return { done: true, nextPath: '/patient' };
  }
  if (status.done) return { done: true, nextPath: '/patient' };
  return { done: false, nextPath: status.path };
}

// ─── setPhoneForOnboarding ─────────────────────────────────────────────
//
// Google patients arrive with no phone on their profile. This action
// writes it (once) so the existing prepare_phone_verification_for_user
// RPC has something to send the OTP to. Email patients captured phone
// at signup — for them this action is a no-op (phone already set) and
// we forward straight to OTP request.

export async function setPhoneForOnboarding(phoneRaw: string): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  const phone = normalizePhoneZA(phoneRaw);
  if (!phone) return { error: 'Enter a valid South African cellphone number.' };

  const { error } = await svc()
    .from('profiles')
    .update({ phone })
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  return { error: null, nextPath: '/onboarding/phone' };
}

// ─── saveSalaryDetails ─────────────────────────────────────────────────
//
// Half of the identity step — salary day + amount. The other half (the
// SA ID number itself, plus liveness) now comes from a Didit-hosted
// verification session — see startIdentityVerification below and
// app/api/verification/didit/webhook/route.ts, which writes
// sa_id_number/sa_id_lookup_hash once Didit approves. The two halves can
// be completed in either order; the 'identity' step (lib/onboarding/
// state.ts) is satisfied only once both have landed.
//
// Formerly named saveIdAndSalaryDay and took saIdNumber too — renamed
// because it genuinely no longer touches the ID; the SA-ID validation,
// duplicate-account check, and encryption that used to live here moved
// to the webhook handler (same rules, same functions, different trigger).
//
// Credit-check seam: if ENABLE_CREDIT_CHECK is OFF, this action ALSO
// auto-passes the credit check (writes credit_check_status='passed'). If
// ON, credit_check_status stays NULL and the state model routes the user
// to the credit-check step next.

export type SaveSalaryDetailsInput = {
  salaryDay:    number;
  salaryAmount: number;
};

export async function saveSalaryDetails(input: SaveSalaryDetailsInput): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  if (!Number.isInteger(input.salaryDay) || !isAllowedSalaryDay(input.salaryDay)) {
    return { error: 'Please choose when your salary is paid.' };
  }

  if (!isValidSalaryAmount(input.salaryAmount)) {
    return { error: 'Please enter how much you earn a month.' };
  }

  const flags = currentFlags();

  const patch: Record<string, unknown> = {
    salary_day:    input.salaryDay,
    salary_amount: input.salaryAmount,
  };

  // Credit-check seam. Flag-off auto-passes so the state model can
  // reach a done state without rendering a dead screen. Flag-on
  // leaves credit_check_status NULL → state routes to /onboarding/credit-check
  // next, where the (future) integration will run.
  if (!flags.creditCheck) {
    patch.credit_check_status       = 'passed';
    patch.credit_check_completed_at = new Date().toISOString();
  }

  const { error } = await svc()
    .from('profiles')
    .update(patch)
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  const nextProfile: ProfileForOnboarding = {
    ...loaded.profile,
    salary_day:          input.salaryDay,
    salary_amount:        input.salaryAmount,
    credit_check_status:  flags.creditCheck ? loaded.profile.credit_check_status : 'passed',
  };

  const finalize = await maybeFinalize(loaded.userId, loaded.user, nextProfile);
  return { error: null, nextPath: finalize.nextPath };
}

// ─── startIdentityVerification ─────────────────────────────────────────
//
// Creates a Didit-hosted verification session (OCR document scan +
// liveness + face match, per DIDIT_WORKFLOW_ID) and returns its hosted
// URL for the client to redirect to. Didit's webhook
// (app/api/verification/didit/webhook/route.ts) applies the eventual
// decision — this action only kicks the session off and stamps
// identity_verification_status='pending' so the UI has something to show
// while the user is away on Didit's flow.
//
// vendor_data = our user id, echoed back on every webhook so the handler
// knows which profile to update. Didit's create-session call is
// idempotent per (workflow, vendor_data) for an unfinished session, so
// calling this again before the user completes a prior attempt safely
// returns the SAME session rather than creating a duplicate.

export type StartVerificationResult =
  | { error: null; url: string }
  | { error: string };

export async function startIdentityVerification(): Promise<StartVerificationResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  // ── Rate limit (audit F-17) ─────────────────────────────────────────
  //
  // EVERY call here spends a PAID Didit unit. It is the only surface in
  // the app where a single request has a direct per-call cost at a vendor,
  // and it had no limiter — so the bot-abuse chain the audit describes
  // (signup → KYC → credit → transaction, thousands of times) was billable
  // to us at this step regardless of whether anything downstream succeeded.
  //
  // Keyed per-account AND per-IP: per-account bounds one applicant's
  // retries (a bad photo is worth two or three attempts), per-IP bounds a
  // script that keeps making fresh accounts to get fresh per-account
  // budgets. The window is 24h rather than an hour — a verification
  // attempt is not something a real person repeats all afternoon.
  if (!await consumeAll('identity_session', [
    [await clientIp(), RATE_LIMITS.identity_session.ip],
    [loaded.userId,                 RATE_LIMITS.identity_session.account!],
  ])) {
    return { error: 'Too many verification attempts. Please try again tomorrow, or contact support.' };
  }

  let session;
  try {
    session = await createDiditSession({
      vendorData: loaded.userId,
      callback:   `${diditAppBaseUrl()}/onboarding/identity?didit=callback`,
    });
  } catch (err) {
    console.error('[onboarding] Didit session create failed:', err instanceof Error ? err.message : err);
    return { error: 'Could not start identity verification. Please try again.' };
  }

  const { error } = await svc()
    .from('profiles')
    .update({
      didit_session_id:                 session.session_id,
      identity_verification_status:     'pending',
      identity_verification_updated_at: new Date().toISOString(),
    })
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  return { error: null, url: session.url };
}

// ─── submitIdentityForVerification (DHA-photo-first, OCR fallback) ────
//
// The new PRIMARY entry point for the identity step, superseding a bare
// "click to verify" button. The patient types their SA ID and gives
// explicit consent; this action:
//
//   1. Runs the SAME local gates the old manual-entry path ran
//      (validateSaId, saIdAge 18+) — BEFORE any network call. An
//      invalid or under-18 ID never reaches the DHA lookup.
//   2. Requires consent — no consent, no DHA call either.
//   3. Persists the consent timestamp BEFORE calling DHA, so consent is
//      durable even if the DHA call itself subsequently fails.
//   4. Calls resolveIdentityRoute() (lib/onboarding/dhaVerification.ts)
//      — the routing table. See that module for the full reasoning;
//      the one invariant repeated here because it matters most: the
//      OCR fallback triggers ONLY on the DHA service being unavailable,
//      never on it answering "not a match".
//   5. Branches on the route:
//        'dha'          → creates a DHA face-match session (portrait
//                          from the registry). NEVER writes sa_id_number
//                          here — only pending_sa_id_number/_lookup_hash.
//                          The webhook promotes them to the canonical
//                          columns atomically, on Approved, exactly like
//                          the OCR path already does (0102) — the
//                          registry match alone is not sufficient; the
//                          live face-match binding still has to pass.
//        'ocr_fallback' → delegates to the EXISTING, UNMODIFIED
//                          startIdentityVerification() (the OCR path's
//                          behaviour does not change) and separately
//                          stamps identity_verification_path='ocr' plus
//                          the fallback reason, as a follow-up update —
//                          not folded into that function, to keep it
//                          byte-for-byte what it was before this task.
//        'reject'       → synchronous decline, no session created.
//        'review'       → synchronous in-review, no session created —
//                          note in the final report: this DHA lookup
//                          still cost money and ends with no automatic
//                          resolution; the review queue is unstaffed.
//        'error'        → our own integration bug (a non-timeout,
//                          non-5xx 4xx from DHA). Logged as an ALERT.
//                          identity_verification_status is left
//                          UNTOUCHED (this is not a decision about the
//                          applicant) and the patient sees a generic
//                          "try again shortly" message.

const DHA_CONSENT_VERSION = 'v1-placeholder'; // TODO: legal review — bump when the consent copy changes.

/**
 * Normalises a name for comparison: lowercase, collapse whitespace, and
 * strip punctuation that differs between a form field and a registry
 * record (hyphens, apostrophes, full stops in initials).
 */
function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.'’\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Do the applicant's claimed GIVEN names contradict the registry's?
 *
 * Not string equality. Identity registries store the full set of given
 * names in one field, while a signup form captures whatever the person
 * types — usually the one name they actually go by. Observed live:
 * Datanamix returned Names "Jess Nathan" for someone who signed up as
 * "Jess", and Didit's DHA endpoint returned "JESS NATHAN" for the same
 * person. Exact comparison flagged both as mismatches.
 *
 * That is not a mismatch, it is a subset. In South Africa two or three
 * given names is common, so exact matching would flag a large share of
 * legitimate applicants — and the registry value is the MORE correct
 * one, so treating the difference as suspicious is backwards.
 *
 * Rule: every token the applicant claimed must appear among the
 * registry's tokens. So "Jess" matches "Jess Nathan", and so does
 * "Nathan" (people do go by a middle name) and "Jess Nathan" itself.
 * "Sipho" does not. A claimed name with MORE names than the registry
 * holds still mismatches — that is a real discrepancy, not a subset.
 *
 * Single initials are matched as initials ("J" against "Jess") because a
 * form that captured "J Nathan" is not evidence of a different person.
 */
function givenNamesMismatch(claimed: string | null, registry: string | undefined): boolean {
  // Absent on either side is not evidence of a mismatch — same
  // conservative stance as before. It only ever sets a review flag, so
  // silence is better than a false positive.
  if (!claimed || !registry) return false;

  const claimedTokens  = normalizeName(claimed).split(' ').filter(Boolean);
  const registryTokens = normalizeName(registry).split(' ').filter(Boolean);
  if (claimedTokens.length === 0 || registryTokens.length === 0) return false;

  return !claimedTokens.every((token) =>
    registryTokens.some((r) => (token.length === 1 ? r.startsWith(token) : r === token)),
  );
}

/**
 * Surnames are compared exactly (after normalisation). Unlike given
 * names there is no subset relationship to allow for — a surname is a
 * single value on both sides, so a difference is a genuine discrepancy
 * worth flagging. Normalisation still handles case, double-barrelled
 * hyphens and apostrophes ("O'Brien" / "o brien").
 */
function surnameMismatch(claimed: string | null, registry: string | undefined): boolean {
  if (!claimed || !registry) return false;
  return normalizeName(claimed) !== normalizeName(registry);
}

// Declined reasons the applicant can plausibly do something about
// ("try again") vs ones that are not actionable by retrying at all —
// see IdentityStepClient's copy for the corresponding UI text.
const DECLINE_MESSAGE_BY_REASON: Record<string, string> = {
  dha_no_match:          'We couldn\'t verify your identity. Please try again.',
  dha_document_not_found: 'We couldn\'t verify your identity. Please try again.',
  dha_id_mismatch:        'We couldn\'t verify your identity. Please try again.',
  dha_deceased:            'We couldn\'t verify your identity. Please contact support.',
  dha_id_blocked:          'We couldn\'t verify your identity. Please contact support.',
  // Datanamix equivalents. Same user-facing wording as the DHA path —
  // the applicant does not need to know which registry we queried — but
  // the retryable/not-retryable split must be preserved, or we tell
  // someone with a blocked ID to "try again" and pay for the retry.
  dnx_no_match:            'We couldn\'t verify your identity. Please try again.',
  dnx_not_found:           'We couldn\'t verify your identity. Please try again.',
  dnx_id_mismatch:         'We couldn\'t verify your identity. Please try again.',
  dnx_deceased:            'We couldn\'t verify your identity. Please contact support.',
  dnx_id_blocked:          'We couldn\'t verify your identity. Please contact support.',
};

export type SubmitIdentityInput = {
  saIdNumber: string;
  consent:    boolean;
};

export type SubmitIdentityResult =
  | { error: null; outcome: 'redirect'; url: string }
  | { error: null; outcome: 'review' }
  | { error: string };

export async function submitIdentityForVerification(input: SubmitIdentityInput): Promise<SubmitIdentityResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  const cleanedId = input.saIdNumber.replace(/\s+/g, '');
  const check = validateSaId(cleanedId);
  if (!check.valid) {
    // Same deliberately generic surface the old manual-entry path used
    // — never leak which sub-check failed.
    return { error: 'Please enter a valid SA ID number.' };
  }

  const age = saIdAge(cleanedId);
  if (age === null || age < 18) {
    return { error: 'You must be 18 or older to use BetterNow.' };
  }

  if (!input.consent) {
    return { error: 'Please provide consent to continue.' };
  }

  // ── Rate limit (audit F-17) ─────────────────────────────────────────
  //
  // The same paid-vendor budget startIdentityVerification spends, shared
  // deliberately: this path costs MORE per call (a DHA registry lookup and
  // then a Didit face-match session), and two entry points onto one
  // vendor bill with two separate allowances would be a limiter that
  // bounds neither.
  //
  // Spent after the local checks — an invalid or under-18 ID is refused
  // for free, exactly as it is refused before any network call today —
  // and before the first outbound request.
  if (!await consumeAll('identity_session', [
    [await clientIp(), RATE_LIMITS.identity_session.ip],
    [loaded.userId,                 RATE_LIMITS.identity_session.account!],
  ])) {
    return { error: 'Too many verification attempts. Please try again tomorrow, or contact support.' };
  }

  const callback = `${diditAppBaseUrl()}/onboarding/identity?didit=callback`;

  // Consent is durable from here regardless of what the DHA call does.
  await svc()
    .from('profiles')
    .update({
      dha_consent_at:      new Date().toISOString(),
      dha_consent_version: DHA_CONSENT_VERSION,
    })
    .eq('id', loaded.userId);

  const { provider, route } = await resolveIdentityRouteForProvider(cleanedId, loaded.userId);

  if (route.kind === 'dha') {
    let session;
    try {
      session = await createDhaFaceMatchSession({
        vendorData:          loaded.userId,
        callback,
        portraitImageBase64: route.photoBase64,
      });
    } catch (err) {
      console.error('[onboarding] DHA session create failed:', err instanceof Error ? err.message : err);
      return { error: 'Could not start identity verification. Please try again.' };
    }

    let encrypted: string;
    let lookupHash: string;
    try {
      encrypted  = encryptId(cleanedId);
      lookupHash = hashIdForLookup(cleanedId);
    } catch {
      return { error: 'Encryption error — please contact support.' };
    }

    const mismatch = givenNamesMismatch(loaded.claimedFirstName, route.dhaFirstName)
      || surnameMismatch(loaded.claimedLastName, route.dhaLastName);

    const { error } = await svc()
      .from('profiles')
      .update({
        didit_session_id:                 session.session_id,
        identity_verification_status:     'pending',
        identity_verification_path:       'dha',
        identity_verification_updated_at: new Date().toISOString(),
        dha_lookup_request_id:            route.requestId ?? null,
        dha_lookup_outcome_code:          route.outcomeCode,
        dha_first_name:                   route.dhaFirstName ?? null,
        dha_last_name:                    route.dhaLastName  ?? null,
        dha_name_mismatch:                mismatch,
        identity_verification_provider:   provider,
        identity_source_offline:          route.sourceOffline ?? null,
        identity_source_last_updated:     route.sourceLastUpdated ?? null,
        pending_sa_id_number:             encrypted,
        pending_sa_id_lookup_hash:        lookupHash,
      })
      .eq('id', loaded.userId);
    if (error) return { error: error.message };

    // ─── The richest observation the ledger ever gets ──────────────────
    //
    // The applicant is in front of us, in a browser, about to be verified.
    // Recorded with NO identity: the pending hash above is a CLAIM, not a
    // verified fact, and writing it here would let anyone spray identity
    // submissions carrying other people's ID numbers into the ledger. The
    // Didit webhook promotes these rows once a registry and a biometric
    // check agree (migration 0137).
    await recordIdentitySignals({
      profileId:    loaded.userId,
      identityHash: null,
      surface:      'identity',
      raw: {
        deviceId: await requestDeviceId(),
        ip:       await requestIp(),
      },
    });

    return { error: null, outcome: 'redirect', url: session.url };
  }

  // The 'ocr_fallback' branch that used to sit here has been REMOVED.
  //
  // It called startIdentityVerification() to spin up a document-scan
  // session whenever the registry failed to answer. That silently
  // substituted weaker evidence (a selfie matched against a photo of a
  // plastic card) for stronger evidence (a selfie matched against the
  // registry's own biometric) — on a vendor timeout, without telling
  // anyone. Those cases are now { kind: 'review' } with reason
  // 'registry_unavailable' or 'biometric_image_unusable' and fall
  // through to the review handler below.
  //
  // It also masked bugs: a failure inside the fallback threw over
  // whatever caused the fallback in the first place, which is exactly
  // how a missing DIDIT_WORKFLOW_ID came to hide a portrait-resize
  // failure in production.

  if (route.kind === 'reject') {
    const now = new Date().toISOString();
    await svc()
      .from('profiles')
      .update({
        identity_verification_status:     'declined',
        identity_verification_reason:     route.reason,
        identity_verification_updated_at: now,
        // Provenance matters most on a DECLINE: "which source refused
        // this person, and how current was it" is the first question in
        // any dispute or complaint.
        identity_verification_provider:   provider,
      })
      .eq('id', loaded.userId);
    return { error: DECLINE_MESSAGE_BY_REASON[route.reason] ?? 'We couldn\'t verify your identity. Please try again.' };
  }

  if (route.kind === 'review') {
    const now = new Date().toISOString();

    // Logged at WARN because two of these reasons — registry_unavailable
    // and biometric_image_unusable — used to complete silently via the
    // OCR fallback. Now they park a real applicant in a queue, so a rise
    // in either is an OUTAGE signal, not routine business. Without this
    // line a provider going down looks like a quiet drop in signups.
    console.warn('[onboarding] identity routed to review', {
      userId: loaded.userId, provider, reason: route.reason,
    });

    await svc()
      .from('profiles')
      .update({
        identity_verification_status:     'in_review',
        identity_verification_reason:     route.reason,
        identity_verification_updated_at: now,
        identity_verification_provider:   provider,
        // Record the path even on review: the webhook resolves its
        // handler from this column, and leaving it NULL would make any
        // later event for this profile unresolvable.
        identity_verification_path:       'dha',
      })
      .eq('id', loaded.userId);
    return { error: null, outcome: 'review' };
  }

  // route.kind === 'error' — our own request was rejected by DHA. Not a
  // decision about the applicant: identity_verification_status is left
  // untouched, deliberately not written as 'declined' or 'in_review'.
  console.error('[onboarding] ALERT DHA request_error — integration bug, not an applicant decision', {
    userId: loaded.userId, status: route.status, detail: route.detail,
  });
  return { error: 'We could not verify your identity right now. Please try again shortly.' };
}

// ─── runCreditCheck (affordability step) ───────────────────────────────
//
// Integration seam. The pass/fail decision AND the granted limit come
// from ONE isolated policy module — lib/underwriting/stubAffordabilityPolicy
// — which currently STUBS an unconditional R5,000 grant with no bureau
// call and no affordability computation (see that module's banner). A real
// underwriting integration replaces that module; this action needs no
// change because it already persists whatever the policy returns.
//
// On approval we persist BOTH:
//   • approved_credit_limit  (rands = limitCents/100) — the granted test
//     balance the dashboard reads. Written via service-role so the 0065
//     column-lock permits it. The amount is NEVER hardcoded here — it is
//     read from the policy's limitCents.
//   • credit_check_status='passed' — satisfies the onboarding step.
// A non-approval (the stub never returns one today, but the real policy
// will) records 'failed' and does not advance — proving the decision is
// genuinely load-bearing and swappable.

export async function runCreditCheck(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  // ── Rate limit (audit A-11's second half) ────────────────────────
  //
  // Today this calls stubAffordabilityPolicy and costs nothing, which is
  // exactly why the limit goes in NOW: the stub is a placeholder for a
  // credit-bureau call that bills per enquiry, and the surface that spends
  // real money at a vendor should not acquire its first limiter on the same
  // day it acquires the cost.
  //
  // A patient needs one check. The retries a real person makes are for a
  // failed lookup, not for a second opinion — and a second opinion is what
  // an unlimited endpoint would let them shop for, since the policy that
  // replaces the stub will not be deterministic.
  //
  // Placed after the profile load so the account key is a real user id, and
  // before the flag check so a flag flip cannot uncover an unlimited path.
  if (!await consumeAll('credit_check', [
    [await clientIp(),  RATE_LIMITS.credit_check.ip],
    [loaded.userId,     RATE_LIMITS.credit_check.account!],
  ])) {
    return { error: 'Too many affordability checks today. Please try again tomorrow, or contact support.' };
  }

  if (!currentFlags().creditCheck) {
    // Flag off — should be unreachable but never fail on it.
    return { error: null, nextPath: '/onboarding' };
  }

  const decision = stubAffordabilityPolicy();
  const now = new Date().toISOString();

  if (!decision.approved) {
    await svc()
      .from('profiles')
      .update({ credit_check_status: 'failed', credit_check_completed_at: now })
      .eq('id', loaded.userId);
    return { error: 'We could not approve an amount right now.' };
  }

  const { error } = await svc()
    .from('profiles')
    .update({
      // Granted test balance — amount comes from the policy, not a literal.
      approved_credit_limit:     decision.limitCents / 100,
      credit_check_status:       'passed',
      credit_check_completed_at: now,
    })
    .eq('id', loaded.userId);
  if (error) return { error: error.message };

  const nextProfile: ProfileForOnboarding = {
    ...loaded.profile,
    credit_check_status: 'passed',
  };
  const finalize = await maybeFinalize(loaded.userId, loaded.user, nextProfile);
  return { error: null, nextPath: finalize.nextPath };
}

// ─── refreshOnboardingState ───────────────────────────────────────────
//
// The phone step uses the existing `verifyPhoneOtpForUser` RPC to set
// phone_verified_at. That code path doesn't know about the onboarding
// finalize helper, so after a successful OTP the client calls THIS
// action to re-run maybeFinalize and get its next redirect target.

export async function refreshOnboardingState(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };
  const finalize = await maybeFinalize(loaded.userId, loaded.user, loaded.profile);
  return { error: null, nextPath: finalize.nextPath };
}
