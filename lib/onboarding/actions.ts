'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { normalizePhoneZA, validateSaId, saIdAge } from '@/lib/validation';
import { isAllowedSalaryDay } from '@/lib/salaryDates';
import { isValidSalaryAmount } from '@/lib/salaryAmount';
import { currentFlags } from '@/lib/featureFlags';
import { computeOnboarding, type ProfileForOnboarding, type UserForOnboarding } from './state';
import { createDiditSession, createDhaFaceMatchSession, diditAppBaseUrl } from '@/lib/didit/client';
import { resolveIdentityRouteForProvider } from '@/lib/onboarding/identityProvider';
import { encryptId, hashIdForLookup, decryptId } from '@/lib/idEncryption';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';
import {
  gateIdentityOnBureauScore,
  SCORE_DECLINE_MESSAGE,
  ASSESSMENT_PENDING_MESSAGE,
  ASSESSMENT_REVIEW_MESSAGE,
  cooldownMessage,
  assessAffordability,
} from '@/lib/onboarding/creditAssessment';
import type { ScorecardBand } from '@/lib/underwriting/coefficients';
import { readSnapshot } from '@/lib/underwriting/assessmentStore';
import { isStale, isInCooldown } from '@/lib/underwriting/assessmentState';

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
  /**
   * `pending` marks a failure that is OURS, not a decision about the
   * patient — a bureau we could not reach, a timeout, a service that is
   * not activated. The step is not satisfied and the message is not a
   * refusal, so the UI renders it as a "try again in a moment" state
   * rather than in the red error treatment. Getting this wrong tells
   * someone they were rejected for credit when no such decision exists.
   */
  | { error: string; nextPath?: string; pending?: boolean };

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

  // Bound out of `loaded` before the closure below: the narrowing from the
  // `if (!loaded.ok) return` guard at the top does not survive into a
  // nested function declaration, so the closure would otherwise see every
  // field as possibly-undefined.
  const { userId, claimedFirstName, claimedLastName } = loaded;

  // ─── The billable identity ceremony, as a callback ───────────────────
  //
  // Everything below — the registry lookup AND the Didit face-match
  // session — costs money per call. It is packaged as a function rather
  // than run inline so that the score gate can decide whether it happens
  // at all, and so the not-called guarantee is enforced by the pipeline
  // instead of by a `return` someone might later move.
  async function startIdentityCeremony(): Promise<SubmitIdentityResult> {
    const { provider, route } = await resolveIdentityRouteForProvider(cleanedId, userId);

    if (route.kind === 'dha') {
      let session;
      try {
        session = await createDhaFaceMatchSession({
          vendorData:          userId,
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

      const mismatch = givenNamesMismatch(claimedFirstName, route.dhaFirstName)
        || surnameMismatch(claimedLastName, route.dhaLastName);

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
        .eq('id', userId);
      if (error) return { error: error.message };

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
        .eq('id', userId);
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
        userId: userId, provider, reason: route.reason,
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
        .eq('id', userId);
      return { error: null, outcome: 'review' };
    }

    // route.kind === 'error' — our own request was rejected by DHA. Not a
    // decision about the applicant: identity_verification_status is left
    // untouched, deliberately not written as 'declined' or 'in_review'.
    console.error('[onboarding] ALERT DHA request_error — integration bug, not an applicant decision', {
      userId: userId, status: route.status, detail: route.detail,
    });
    return { error: 'We could not verify your identity right now. Please try again shortly.' };
  }

  // ─── STEP 1: the bureau score, before anything billable ──────────────
  //
  // The cheap gate. A below-average-risk applicant is refused here having
  // cost one score enquiry, rather than a score PLUS a registry lookup
  // PLUS a face-match session.
  //
  // The ID reaching this point is checksum-valid, belongs to someone 18 or
  // over, and carries explicit consent recorded a few lines above — but it
  // is NOT yet confirmed as the applicant's own. That is the deliberate
  // trade of running the score first, and it means a typo or a fraudulent
  // registration can put an enquiry footprint on a third party's file.
  // The checksum check bounds the damage; the remaining exposure is why
  // the enquiry TYPE matters (see lib/experian/config.ts — there is no
  // parameter for it on this operation, so it is an Experian account
  // setting).
  //
  // Flag off → no bureau call at all, and the ceremony runs exactly as it
  // did before this pipeline existed.
  if (!currentFlags().creditCheck) {
    return startIdentityCeremony();
  }

  const scoreGate = await gateIdentityOnBureauScore<SubmitIdentityResult>(
    { svc: svc(), userId: loaded.userId, idNumber: cleanedId, trigger: 'signup' },
    startIdentityCeremony,
  );

  switch (scoreGate.kind) {
    case 'identity_started':
      return scoreGate.result;

    case 'declined':
      // A substantive refusal. The applicant is now in the cooldown, which
      // recordScore has already written.
      return { error: SCORE_DECLINE_MESSAGE };

    case 'pending':
      // We could not get an answer. NOT a refusal: no cooldown, and the
      // copy says to come back rather than that they were turned down.
      return {
        error: scoreGate.decision.kind === 'pending' && scoreGate.decision.review
          ? ASSESSMENT_REVIEW_MESSAGE
          : ASSESSMENT_PENDING_MESSAGE,
      };

    case 'blocked':
      return { error: cooldownMessage(scoreGate.until) };
  }
}

// ─── runCreditCheck (affordability step) ───────────────────────────────
//
// Steps 3-6 of the assessment: the declared income already collected on
// the salary step, then the BILLABLE affordability enquiry, then the pure
// limit calculation, then persistence.
//
// The stub this replaces (lib/underwriting/stubAffordabilityPolicy) granted
// an unconditional R5,000 with no bureau call and no assessment of any
// kind. Its own banner said to replace the whole module before any real
// customer was onboarded; it is now unreferenced by any production path.
//
// ─── WHAT GUARDS THE SPEND ─────────────────────────────────────────────
//
// Two gates, both upstream and both already passed by the time a patient
// reaches this screen:
//
//   • the SCORE gate, at the identity step — a below-average-risk
//     applicant never got a Didit session, let alone this
//   • IDENTITY, re-read here rather than assumed. The onboarding step
//     order makes it true in practice; `gateAffordabilityOnIdentity`
//     checks it anyway, because "two gates disagree about whether you may
//     borrow" is how F-05 turned into a financial hole.
//
// ─── THE THREE OUTCOMES ────────────────────────────────────────────────
//
// approved  limit persisted, step satisfied, onboarding advances
// declined  a substantive refusal — cooldown set, step marked failed
// pending   we could not reach the bureau. NOT a refusal: no cooldown, no
//           limit cleared, step left unsatisfied so the patient can retry.
//           The copy says so.

export async function runCreditCheck(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  // ── Rate limit (audit A-11's second half) ────────────────────────
  //
  // This surface now genuinely bills per call, which is what the limiter
  // was put here in anticipation of. A patient needs one check; the
  // retries a real person makes are for a failed lookup, not for a second
  // opinion — and a second opinion is exactly what an unlimited endpoint
  // would let them shop for, since the policy is not deterministic.
  //
  // Placed after the profile load so the account key is a real user id,
  // and before the flag check so a flag flip cannot uncover an unlimited
  // path.
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

  // ── Already assessed? Then do not pay for it again ───────────────
  //
  // A refresh, a back-button, or a double tap would otherwise spend a
  // second billable enquiry to re-derive a limit we already hold. The
  // rate limiter bounds that at five a day; this makes the common case
  // cost nothing at all.
  //
  // Only a CURRENT approval short-circuits. A stale one falls through and
  // is re-assessed, and a declined or pending one is not an assessment to
  // reuse.
  const existing = await readSnapshot(svc(), loaded.userId);
  if (existing !== null
      && existing.status === 'active'
      && existing.limit !== null
      && !isStale(existing, new Date())) {
    const already: ProfileForOnboarding = {
      ...loaded.profile,
      credit_check_status: 'passed',
    };
    const done = await maybeFinalize(loaded.userId, loaded.user, already);
    return { error: null, nextPath: done.nextPath };
  }

  // ── Inside a decline cooldown? Then spend nothing ────────────────
  //
  // A decline at the LIMIT stage (the arithmetic came out under R1,000)
  // leaves credit_check_status = 'failed', which leaves the onboarding
  // step unsatisfied — so the patient lands back on this screen with a
  // working button. Without this check every tap buys another
  // affordability enquiry until the daily rate limit trips, which is
  // precisely what the cooldown exists to stop.
  //
  // A score-stage decline cannot reach here (identity never started), but
  // the check is not conditional on which gate refused: the cooldown is a
  // property of the applicant, not of the stage.
  if (existing !== null && isInCooldown(existing, new Date())) {
    return { error: cooldownMessage(new Date(existing.cooldownUntil as string)) };
  }

  // ── The ID, and the band the score gate produced ─────────────────
  //
  // sa_id_number is written by the identity webhook on approval, so its
  // presence is itself evidence identity passed. It is stored encrypted;
  // the plaintext never leaves this function except into the SOAP body.
  const state = await svc()
    .from('profiles')
    .select('sa_id_number, liveness_verified_at, scorecard_band, salary_amount')
    .eq('id', loaded.userId)
    .maybeSingle();

  const row = state.data as {
    sa_id_number: string | null;
    liveness_verified_at: string | null;
    scorecard_band: string | null;
    salary_amount: number | string | null;
  } | null;

  if (!row?.sa_id_number) {
    // No verified identity on file. Not a decline — the patient simply is
    // not at this step yet.
    return { error: 'Please finish verifying your identity first.' };
  }

  let idNumber: string;
  try {
    idNumber = decryptId(row.sa_id_number);
  } catch {
    console.error('[onboarding] ALERT could not decrypt a stored SA ID for affordability', {
      userId: loaded.userId,
    });
    return { error: ASSESSMENT_PENDING_MESSAGE, pending: true };
  }

  // The band the score produced at the identity step. Absent only if the
  // score never ran (flag flipped on mid-journey) — treated as thin file,
  // which caps rather than refuses.
  const band = (row.scorecard_band as ScorecardBand | null) ?? 'thin_file';

  // Declared gross, from the salary step. It can only ever LOWER the
  // limit, and it is never sent to Experian — see the affordability
  // client's header.
  const declaredIncome = row.salary_amount === null ? null : Number(row.salary_amount);

  const result = await assessAffordability(
    { svc: svc(), userId: loaded.userId, idNumber, trigger: 'signup' },
    {
      scoreDecision: null,
      band,
      // Read, not assumed. Both columns are written by the webhook on
      // approval, in one update — the same pair lib/onboarding/state.ts
      // treats as "identity satisfied".
      identityStatus: async () =>
        row.sa_id_number && row.liveness_verified_at ? 'passed' : 'pending',
      declaredIncomeRands: declaredIncome !== null && Number.isFinite(declaredIncome)
        ? declaredIncome
        : null,
    },
  );

  if (result.kind === 'identity_not_passed') {
    return { error: 'Please finish verifying your identity first.' };
  }

  if (result.kind === 'pending') {
    // A bureau we could not reach. The step stays unsatisfied so the
    // patient can retry, and neither the copy nor the treatment says they
    // were refused.
    return { error: ASSESSMENT_PENDING_MESSAGE, pending: true };
  }

  if (result.limit.decision === 'declined') {
    return { error: SCORE_DECLINE_MESSAGE };
  }

  // assessAffordability has already written the limit and the log row.
  const nextProfile: ProfileForOnboarding = {
    ...loaded.profile,
    credit_check_status: 'passed',
  };
  const finalize = await maybeFinalize(loaded.userId, loaded.user, nextProfile);
  return { error: null, nextPath: finalize.nextPath };
}

export async function refreshOnboardingState(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };
  const finalize = await maybeFinalize(loaded.userId, loaded.user, loaded.profile);
  return { error: null, nextPath: finalize.nextPath };
}
