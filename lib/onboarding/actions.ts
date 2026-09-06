'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { normalizePhoneZA, validateSaId, saIdAge } from '@/lib/validation';
import { isAllowedSalaryDay } from '@/lib/salaryDates';
import { isValidSalaryAmount } from '@/lib/salaryAmount';
import { currentFlags } from '@/lib/featureFlags';
import { computeOnboarding, type ProfileForOnboarding, type UserForOnboarding } from './state';
import { assessAffordability } from '@/lib/underwriting/affordabilityPolicy';
import type { AssessmentDeps } from '@/lib/experian/assessAtSignup';
import { createDiditSession, createDhaFaceMatchSession, diditAppBaseUrl } from '@/lib/didit/client';
import { resolveIdentityRouteForProvider } from '@/lib/onboarding/identityProvider';
import { encryptId, decryptId, hashIdForLookup } from '@/lib/idEncryption';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';
import { evaluateRisk, mayProceed } from '@/lib/risk/evaluate';
import { hasBureauConsent, type BureauConsentRow } from '@/lib/legal/bureauConsent';
import { enquiryStoreDeps } from '@/lib/experian/enquiryStore';
import { experianConfig, experianConfigured } from '@/lib/experian/config';

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
  'onboarding_completed, identity_verification_status, didit_session_id, first_name, last_name, ' +
  // Correlation inputs for the aggregate fraud controls (audit S-07). The
  // blind index is read rather than the ID itself: lib/risk never sees a
  // plaintext SA ID, and the index is what the duplicate-identity rule
  // compares. Everything here is re-tokenised under the risk key before it
  // reaches the correlation store (lib/risk/tokens.ts).
  'sa_id_lookup_hash, phone, email, ' +
  // The recorded terms acceptance, for the credit-bureau consent gate.
  //
  // These columns were NOT read here before, and their absence was a real
  // gap rather than an oversight nobody had reached yet: runCreditCheck is a
  // server action any patient can invoke directly, and it is the surface that
  // makes a billable enquiry against a real person's credit file. The
  // credit-check PAGE calls requireTermsAccepted; the ACTION did not check at
  // all. Reading them here costs nothing — same row, same round trip — and
  // lib/legal/bureauConsent.ts turns them into the gate.
  'terms_accepted_at, terms_version';

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
    // Kept OUT of `profile` above: that object is `satisfies
    // ProfileForOnboarding`, which is the onboarding state model's input and
    // must not grow fields the state model does not read.
    riskFacts: {
      identityHash:  profile.sa_id_lookup_hash as string | null,
      phone:         profile.phone             as string | null,
      email:         profile.email             as string | null,
      kycSessionRef: profile.didit_session_id  as string | null,
    },
    // Also kept OUT of `profile` above, for the same reason riskFacts is: the
    // onboarding state model deliberately does not model terms acceptance
    // (see ProfileForOnboarding), and it must not start.
    consent: {
      terms_accepted_at: profile.terms_accepted_at as string | null,
      terms_version:     profile.terms_version     as string | null,
    } satisfies BureauConsentRow,
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
// Credit-check seam: if ENABLE_CREDIT_CHECK is OFF, the credit-check step
// does not exist, so this action marks it not-applicable
// (credit_check_status='passed') to let the state model reach a done state.
// That grants NO limit — it never did, and since the R5,000 stub was
// removed neither does the flag-on path until the real check is
// configured. If ON, credit_check_status stays NULL and the state model
// routes the user to the credit-check step next.

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

  // Credit-check seam. Flag-off marks the step not-applicable so the state
  // model can reach a done state without rendering a dead screen; it grants
  // no limit, and never did. Flag-on leaves credit_check_status NULL →
  // state routes to /onboarding/credit-check next, where the real
  // integration will run.
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

  // ── Aggregate risk + the daily KYC budget (audit S-07) ──────────────
  //
  // The bucket above bounds ONE account and ONE address. It cannot see the
  // shape the audit describes: many accounts, each with its own budget,
  // each spending one paid unit, all from one device or one subnet — nor
  // can it see that today's platform-wide KYC bill has already reached the
  // ceiling. Both are decided here.
  //
  // Spent AFTER the bucket and BEFORE the vendor call, so a caller who is
  // already over their per-account budget never reaches the expensive
  // evaluation, and a caller the evaluation refuses never reaches the
  // vendor. That ordering is the whole point: the budget is only meaningful
  // if it is checked while the money is still ours.
  const risk = await evaluateRisk({
    event:         'kyc_session',
    accountId:     loaded.userId,
    identityHash:  loaded.riskFacts.identityHash,
    phone:         loaded.riskFacts.phone,
    email:         loaded.riskFacts.email,
    kycSessionRef: loaded.riskFacts.kycSessionRef,
  });
  if (!mayProceed(risk)) return { error: risk.refusalMessage! };

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

  // ── Aggregate risk, on the ID the caller just typed (audit S-07) ─────
  //
  // The sharpest placement of the duplicate-identity control in the whole
  // system, and the reason this call passes `hashIdForLookup(cleanedId)`
  // rather than the profile's stored hash: at this point the ID is a CLAIM
  // and nothing has been written. The 0097 unique index would eventually
  // refuse a second profile carrying it — but only after a DHA registry
  // lookup and a Didit face-match session have both been paid for, and
  // 0103's `pending_sa_id_lookup_hash` deliberately carries no uniqueness
  // constraint at all, so on that path nothing refuses it until approval.
  //
  // Deciding here means a ring working through a list of leaked SA IDs
  // stops at the first one already on the platform, before the first cent
  // is spent at either vendor.
  const risk = await evaluateRisk({
    event:        'kyc_session',
    accountId:    loaded.userId,
    identityHash: hashIdForLookup(cleanedId),
    phone:        loaded.riskFacts.phone,
    email:        loaded.riskFacts.email,
  });
  if (!mayProceed(risk)) return { error: risk.refusalMessage! };

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
// The one call site that writes profiles.approved_credit_limit, and it
// writes whatever lib/underwriting/affordabilityPolicy returns and nothing
// else. No amount is hardcoded here, and none is computed here.
//
// The R5,000 stub this used to call is GONE. It granted a fixed limit to
// every applicant with no bureau call and no assessment, which is what made
// the fraud chain in audit S-07 worth running: every synthetic identity that
// reached this step was handed real spendable credit for free. The real
// credit check will determine the amount; until it is configured the policy
// returns `unavailable` and nobody receives a limit.
//
// Three outcomes, and keeping them distinct is the point:
//
//   approved     → persist the limit (rands = limitCents/100) and
//                  credit_check_status='passed'. Written via service-role so
//                  the 0065 column-lock permits it.
//   declined     → credit_check_status='failed'. A decision on the
//                  applicant's file.
//   unavailable  → credit_check_status='pending'. NOT a refusal: a provider
//                  outage, or the policy not being configured yet, must
//                  never be recorded against someone's name.
//
// 'pending' satisfies the onboarding step (see stepIsSatisfied) because the
// step means "we have taken your application", not "you have been
// approved". The two are different facts and conflating them would either
// strand every applicant on a spinner or write 'passed' when nothing
// passed. What a pending applicant cannot do is accept a plan —
// claim_credit_for_plan refuses with no_limit, whose copy says an
// assessment is pending.

export async function runCreditCheck(): Promise<ActionResult> {
  const loaded = await loadUserAndProfile();
  if (!loaded.ok) return { error: loaded.error };

  // ── Rate limit (audit A-11's second half) ────────────────────────
  //
  // The policy behind this call is not live yet and so costs nothing today,
  // which is exactly why the limit is here NOW: it is the seam a
  // credit-bureau call that bills per enquiry lands in, and the surface that
  // spends real money at a vendor should not acquire its first limiter on
  // the same day it acquires the cost.
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

  // ── Aggregate risk + the daily bureau budget (audit S-07) ────────────
  //
  // Same argument as the KYC surface, and the same placement: after the
  // per-account bucket, before the decision. It costs nothing today, which
  // is precisely why the ceiling goes in now — the surface that will bill
  // per enquiry should not acquire its first aggregate control on the day it
  // acquires the cost.
  //
  // Note this sits BEFORE the feature-flag check below, for the reason the
  // rate limit does: a flag flip must not uncover an unmeasured path.
  const risk = await evaluateRisk({
    event:        'credit_check',
    accountId:    loaded.userId,
    identityHash: loaded.riskFacts.identityHash,
    phone:        loaded.riskFacts.phone,
    email:        loaded.riskFacts.email,
  });
  if (!mayProceed(risk)) return { error: risk.refusalMessage! };

  if (!currentFlags().creditCheck) {
    // Flag off — should be unreachable but never fail on it.
    return { error: null, nextPath: '/onboarding' };
  }

  // ── The bureau dependencies ───────────────────────────────────────────
  //
  // Built here rather than inside the policy because this function already
  // owns the service-role client and has already read the profile row that
  // answers the consent question. Passing a closure over that row means the
  // POPIA §71 consent gate costs NO additional round trip — the same argument
  // lib/legal/termsGate.ts makes for taking a row instead of reading one.
  //
  // The consent predicate is lib/legal/bureauConsent.ts, NOT the shared
  // hasAcceptedTerms: the shared one grandfathers a NULL terms_accepted_at
  // for accounts that finished onboarding before acceptance was recorded, and
  // "this account finished onboarding" is not evidence of consent to a credit
  // enquiry. See that file for why the divergence is deliberate.
  //
  // With no deps the policy returns `unavailable` and NO CALL IS MADE. That
  // is the state production is in today.
  let bureauDeps: AssessmentDeps | undefined;
  let saIdNumber: string | null = null;

  if (experianConfigured()) {
    try {
      // The verified ID from the column the Didit webhook wrote. Decrypted
      // here and passed straight through — never persisted in plaintext,
      // never logged, and never re-asked of the patient.
      saIdNumber = loaded.profile.sa_id_number ? decryptId(loaded.profile.sa_id_number) : null;
      bureauDeps = {
        config: experianConfig(),
        ...enquiryStoreDeps(svc(), async () => hasBureauConsent(loaded.consent)),
      };
    } catch (err) {
      // Our configuration is broken, which is not a decision about the
      // applicant. Leaving deps undefined routes to `unavailable` →
      // 'pending', never to a decline.
      //
      // The message is safe to log: it comes from requireEnv (a variable
      // NAME) or decryptId (a format complaint), never from a value and never
      // from the SOAP body, which does not exist yet at this point and never
      // leaves lib/experian/client.ts when it does.
      console.error('[onboarding] ALERT bureau config unusable — affordability will report unavailable', {
        userId: loaded.userId,
        detail: err instanceof Error ? err.message : 'unknown',
      });
      bureauDeps = undefined;
      saIdNumber = null;
    }
  }

  const decision = await assessAffordability({
    accountId:         loaded.userId,
    salaryAmountRands: loaded.profile.salary_amount,
    salaryDay:         loaded.profile.salary_day,
    identityVerified:  !!loaded.profile.sa_id_number && !!loaded.profile.liveness_verified_at,
    saIdNumber,
  }, bureauDeps);
  const now = new Date().toISOString();

  if (decision.outcome === 'declined') {
    await svc()
      .from('profiles')
      .update({ credit_check_status: 'failed', credit_check_completed_at: now })
      .eq('id', loaded.userId);
    return { error: 'We could not approve an amount right now.' };
  }

  if (decision.outcome === 'unavailable') {
    // No decision was reached. Recorded as 'pending' and NOT as 'failed':
    // a provider outage, or a policy that is not live yet, is not a
    // refusal and must not sit on someone's file as one.
    //
    // No limit is written, so the approved-balance card renders nothing and
    // any plan acceptance is refused with the assessment-pending copy. The
    // applicant is never shown credit they do not have.
    console.warn(JSON.stringify({
      event: 'affordability_unavailable',
      schema_version: 1,
      occurred_at: now,
      reason: decision.reason,
    }));

    const { error: pendingErr } = await svc()
      .from('profiles')
      .update({ credit_check_status: 'pending', credit_check_completed_at: now })
      .eq('id', loaded.userId);
    if (pendingErr) return { error: pendingErr.message };

    const pendingProfile: ProfileForOnboarding = {
      ...loaded.profile,
      credit_check_status: 'pending',
    };
    // Onboarding still completes — see the header. The applicant has a
    // usable account and a pending assessment, which is the honest state.
    const pendingFinalize = await maybeFinalize(loaded.userId, loaded.user, pendingProfile);
    return { error: null, nextPath: pendingFinalize.nextPath };
  }

  const { error } = await svc()
    .from('profiles')
    .update({
      // The amount comes from the policy, never from a literal here.
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
