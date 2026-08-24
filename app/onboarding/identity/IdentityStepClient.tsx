'use client';

import { useEffect, useRef, useState } from 'react';
import SalaryDayPicker from '@/components/SalaryDayPicker';
import { ShieldIcon } from '@/app/_landing/icons';
import { saveSalaryDetails, submitIdentityForVerification, refreshOnboardingState } from '@/lib/onboarding/actions';
import { validateSaId, saIdAge } from '@/lib/validation';
import { isValidSalaryAmount } from '@/lib/salaryAmount';

// ─── Identity step (client) ────────────────────────────────────────────
//
// Two independent pieces, each with its own submit:
//
//   1. Salary day + amount — plain form, saveSalaryDetails().
//   2. Identity verification — the patient types their SA ID and gives
//      consent; submitIdentityForVerification() resolves DHA-photo-first
//      routing SERVER-SIDE (validateSaId/saIdAge here are client-side
//      convenience only, same generic-error rule the old manual-entry
//      form used — the server re-validates for real) and either:
//        outcome:'redirect' — a Didit session was created (DHA-photo
//          face-match OR the OCR fallback); redirect to it. Its webhook
//          applies the decision asynchronously, so when the user is
//          redirected BACK here (?didit=callback) we poll
//          refreshOnboardingState() until the server says the step
//          moved on.
//        outcome:'review'   — resolved without a session (e.g. DHA said
//          "not on the register"). No redirect; reload so the server-
//          rendered identityVerificationStatus prop picks up 'in_review'.
//        error              — synchronous decline (e.g. DHA said
//          NO_MATCH) or a transient failure; shown inline.
//
// The onboarding 'identity' step is satisfied only once BOTH have
// landed — see lib/onboarding/state.ts. Either can be done first.

const INPUT_CLS =
  'h-[56px] w-full rounded-[14px] border-[1.5px] border-[#E2E8EE] bg-[#FBFCFD] px-4 text-[16px] tracking-[0.06em] ' +
  'text-[#13294B] outline-none transition-colors placeholder:text-[#A8B4C2] ' +
  'focus:border-[#15A89E] focus:bg-white focus:ring-4 focus:ring-[#15A89E]/15';

const BUTTON_CLS =
  'flex h-[54px] w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all ' +
  'disabled:opacity-45 disabled:cursor-not-allowed';

type Props = {
  salaryDay:                   number | null;
  salaryAmount:                number | null;
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
  salaryDay: initialSalaryDay,
  salaryAmount: initialSalaryAmount,
  identityVerificationStatus,
  identityVerificationReason,
  returningFromDidit,
}: Props) {
  // ── Salary form ──
  const [salaryDay,    setSalaryDay]    = useState<number | null>(initialSalaryDay);
  const [salaryAmount, setSalaryAmount] = useState(initialSalaryAmount != null ? String(initialSalaryAmount) : '');
  const [salaryError,  setSalaryError]  = useState<string | null>(null);
  const [salarySaving, setSalarySaving] = useState(false);
  const [salarySaved,  setSalarySaved]  = useState(initialSalaryDay != null && initialSalaryAmount != null);

  // ── Identity verification ──
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

  async function handleSalarySubmit(e: React.FormEvent) {
    e.preventDefault();
    setSalaryError(null);

    if (salaryDay === null) {
      setSalaryError('Please choose when your salary is paid.');
      return;
    }
    const amount = Number(salaryAmount);
    if (!isValidSalaryAmount(amount)) {
      setSalaryError('Please enter how much you earn a month.');
      return;
    }

    setSalarySaving(true);
    const result = await saveSalaryDetails({ salaryDay, salaryAmount: amount });
    setSalarySaving(false);

    if (result.error !== null) {
      setSalaryError(result.error);
      return;
    }
    setSalarySaved(true);
    if (result.nextPath !== '/onboarding/identity') {
      window.location.href = result.nextPath;
    }
  }

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
            We use your SA ID and a quick selfie to confirm it&apos;s really you — handled securely by our verification partner, Didit.
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

            {/* TODO: legal review — placeholder consent copy, not final. */}
            <label className="flex items-start gap-2 text-[12px] leading-[1.5]" style={{ color: '#8496AA' }}>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                data-testid="onboarding-dha-consent"
                className="mt-0.5 shrink-0"
              />
              I consent to BetterNow retrieving my identity photograph from the Department of
              Home Affairs to verify my identity.
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

      <form onSubmit={handleSalarySubmit} className="flex flex-col gap-6 border-t pt-6" style={{ borderColor: '#E2E8EE' }}>
        <SalaryDayPicker
          value={salaryDay}
          onChange={(d) => setSalaryDay(d)}
        />

        <div className="flex flex-col gap-2">
          <label htmlFor="salary-amount" className="text-[13px] font-medium" style={{ color: '#41556F' }}>
            Monthly income
          </label>
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[16px]"
              style={{ color: '#A8B4C2' }}
            >
              R
            </span>
            <input
              id="salary-amount"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              autoComplete="off"
              value={salaryAmount}
              onChange={(e) => setSalaryAmount(e.target.value)}
              data-testid="onboarding-salary-amount"
              placeholder="15,000"
              className={INPUT_CLS + ' pl-8'}
            />
          </div>
          <p className="text-[12px] leading-[1.5]" style={{ color: '#8496AA' }}>
            What you take home a month, before any instalments. Used for the affordability check.
          </p>
        </div>

        {salaryError && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {salaryError}
          </p>
        )}

        <button
          type="submit"
          disabled={salarySaving}
          data-testid="onboarding-identity-submit"
          className={BUTTON_CLS}
          style={{
            background: salarySaved ? '#41556F' : '#15A89E',
            boxShadow: salarySaving ? 'none' : '0 10px 22px -12px rgba(21,168,158,0.9)',
          }}
        >
          {salarySaving ? 'Saving…' : salarySaved ? 'Saved — update' : 'Save'}
        </button>
      </form>
    </div>
  );
}
