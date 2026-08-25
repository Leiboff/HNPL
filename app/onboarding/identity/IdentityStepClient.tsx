'use client';

import { useEffect, useRef, useState } from 'react';
import { ShieldIcon } from '@/app/_landing/icons';
import { submitIdentityForVerification, refreshOnboardingState } from '@/lib/onboarding/actions';
import { validateSaId, saIdAge } from '@/lib/validation';
import { INPUT_CLS, BUTTON_CLS } from '@/app/onboarding/formStyles';

// ─── Identity step (client) ────────────────────────────────────────────
//
// ONE job: take the SA ID and consent, and start verification. The
// salary day/amount form that used to share this screen now lives at
// /onboarding/salary and runs before this step — see
// app/onboarding/salary/page.tsx for why that order.
//
// submitIdentityForVerification() resolves registry-photo-first routing
// SERVER-SIDE (validateSaId/saIdAge here are client-side convenience
// only; the server re-validates for real) and returns one of:
//
//   outcome:'redirect' — a Didit session was created for liveness +
//     face match against the registry portrait. Its webhook applies the
//     decision asynchronously, so when the patient is redirected BACK
//     here (?didit=callback) we poll refreshOnboardingState() until the
//     server says the step moved on.
//   outcome:'review'   — resolved without a session (e.g. the registry
//     could not be reached, or returned no usable portrait). No
//     redirect; reload so the server-rendered
//     identityVerificationStatus prop picks up 'in_review'.
//   error              — synchronous decline (e.g. registry no-match) or
//     a transient failure; shown inline.

type Props = {
  identityVerificationStatus:  string | null;
  identityVerificationReason:  string | null;
  returningFromDidit:          boolean;
};

const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 20; // ~40s

const DUPLICATE_ID_MESSAGE =
  'An account already exists for this ID number. Please log in to that account instead — ' +
  'use "Forgot password" if you can\'t get in, or contact support if you think this is a mistake.';

const SA_ID_GENERIC_ERROR = 'Please enter a valid SA ID number.';
const MIN_AGE = 18;

export default function IdentityStepClient({
  identityVerificationStatus,
  identityVerificationReason,
  returningFromDidit,
}: Props) {
  const [saId,           setSaId]           = useState('');
  const [consent,        setConsent]        = useState(false);
  const [verifyError,    setVerifyError]    = useState<string | null>(null);
  const [verifyLoading,  setVerifyLoading]  = useState(false);
  const [polling,        setPolling]        = useState(returningFromDidit && identityVerificationStatus !== 'declined');
  const pollAttempts = useRef(0);

  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(async () => {
      pollAttempts.current += 1;
      const result = await refreshOnboardingState();
      if (result.error === null && result.nextPath !== '/onboarding/identity') {
        clearInterval(interval);
        window.location.href = result.nextPath;
        return;
      }
      if (pollAttempts.current >= POLL_MAX_ATTEMPTS) {
        clearInterval(interval);
        setPolling(false);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [polling]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setVerifyError(null);

    const cleaned = saId.replace(/\s+/g, '');
    const check = validateSaId(cleaned);
    if (!check.valid) {
      setVerifyError(SA_ID_GENERIC_ERROR);
      return;
    }
    const age = saIdAge(cleaned);
    if (age === null || age < MIN_AGE) {
      setVerifyError(`You must be ${MIN_AGE} or older to use BetterNow.`);
      return;
    }
    if (!consent) {
      setVerifyError('Please provide consent to continue.');
      return;
    }

    setVerifyLoading(true);
    const result = await submitIdentityForVerification({ saIdNumber: cleaned, consent });
    setVerifyLoading(false);

    if (result.error !== null) {
      setVerifyError(result.error);
      return;
    }
    if (result.outcome === 'redirect') {
      window.location.href = result.url;
      return;
    }
    // outcome === 'review' — no session, nothing to redirect to. Reload
    // so the server-rendered identityVerificationStatus prop picks up
    // 'in_review' and this component re-renders in that state.
    window.location.href = '/onboarding/identity';
  }

  if (polling) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12" data-testid="onboarding-identity-polling">
        <div
          className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#E2E8EE] border-t-[#15A89E]"
          aria-hidden="true"
        />
        <p className="text-center text-[14px]" style={{ color: '#41556F' }}>
          Confirming your verification…
        </p>
      </div>
    );
  }

  const declined = identityVerificationStatus === 'declined';
  const inReview = identityVerificationStatus === 'in_review';
  const verified = identityVerificationStatus === 'approved';

  // Not user-actionable — retrying does not help, and inviting a retry
  // on a deceased/blocked-ID decline is itself a probing surface. Same
  // treatment as a duplicate-ID decline: no form, no button.
  const notActionable = identityVerificationReason === 'id_already_registered'
    || identityVerificationReason === 'dha_deceased'
    || identityVerificationReason === 'dha_id_blocked';

  return (
    <div className="flex flex-1 flex-col gap-8">
      <form onSubmit={handleVerify} className="flex flex-col gap-4" data-testid="onboarding-identity-verify">
        <div className="flex items-start gap-2">
          <span className="mt-px inline-flex shrink-0" style={{ color: '#15A89E' }} aria-hidden="true">
            <ShieldIcon size={16} />
          </span>
          <p className="text-[12px] leading-[1.5]" style={{ color: '#8496AA' }}>
            We use your ID number and a quick selfie to confirm it&apos;s really you. Your selfie is checked against your official identity photo.
          </p>
        </div>

        {verified && (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" data-testid="onboarding-identity-verified">
            Identity verified.
          </p>
        )}

        {inReview && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700" role="status">
            Your verification is under review. We&apos;ll email you once it&apos;s done.
          </p>
        )}

        {declined && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {identityVerificationReason === 'id_already_registered'
              ? DUPLICATE_ID_MESSAGE
              : identityVerificationReason === 'dha_deceased' || identityVerificationReason === 'dha_id_blocked'
              ? 'We couldn\'t verify your identity. Please contact support.'
              : 'We couldn\'t verify your identity. Please try again.'}
          </p>
        )}

        {!verified && !notActionable && (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor="sa-id" className="text-[13px] font-medium" style={{ color: '#41556F' }}>
                South African ID number
              </label>
              <input
                id="sa-id"
                type="text"
                inputMode="numeric"
                maxLength={13}
                autoComplete="off"
                value={saId}
                onChange={(e) => setSaId(e.target.value.replace(/\D/g, ''))}
                data-testid="onboarding-sa-id"
                placeholder="13-digit ID number"
                className={INPUT_CLS}
              />
            </div>

            {/*
              TODO: LEGAL REVIEW — placeholder consent copy, NOT final.

              The previous wording named "the Department of Home Affairs"
              as the source. That is no longer accurate: with
              IDENTITY_PHOTO_PROVIDER=datanamix the photo comes from a
              registered credit bureau's copy of Home Affairs data (see
              lib/onboarding/identityProvider.ts), which is a different
              controller and a different POPIA disclosure.

              The text below is deliberately source-neutral so it is not
              actively WRONG, but "identity records" is vague and vague
              consent is weak consent. A lawyer needs to decide whether
              POPIA requires naming the specific third party, and if so
              whether this copy must change when the provider does.
            */}
            <label className="flex items-start gap-2 text-[12px] leading-[1.5]" style={{ color: '#8496AA' }}>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                data-testid="onboarding-dha-consent"
                className="mt-0.5 shrink-0"
              />
              I consent to BetterNow retrieving my identity photograph from official identity
              records, via its verification partners, to confirm my identity.
            </label>

            {verifyError && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                {verifyError}
              </p>
            )}

            <button
              type="submit"
              disabled={verifyLoading}
              data-testid="onboarding-identity-verify-button"
              className={BUTTON_CLS}
              style={{ background: '#15A89E', boxShadow: verifyLoading ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)' }}
            >
              {verifyLoading ? 'Verifying…' : declined || inReview ? 'Try again' : 'Verify my identity'}
            </button>
          </>
        )}
      </form>

    </div>
  );
}
