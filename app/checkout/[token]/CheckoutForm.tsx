'use client';

import { useState, useTransition, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ALLOWED_SALARY_DAYS } from '@/lib/salaryDates';
import {
  normalizePhoneZA,
  validateSaId,
  saIdAge,
} from '@/lib/validation';
import PhoneOtpStep from '@/app/_otp/PhoneOtpStep';
import {
  useFieldValidation,
  focusAndScrollTo,
  type FieldsSchema,
} from '@/lib/forms/useFieldValidation';
import {
  BillChip,
  ScheduleStrip,
  StepShell,
  PrimaryButton,
  SecondaryButton,
} from './_components/CheckoutChrome';
import PlanPickerCards from './_components/PlanPickerCards';

// ─── Multi-step anonymous checkout ─────────────────────────────────────────
//
// Compressed to three visible steps (the emailed link IS the bill
// restatement, so there's no separate "you have a bill" screen; and the
// post-verify hand-off is a button spinner, not a page):
//   1. Plan — 3 vs 2 instalments + salary day → schedule preview. This
//      is the landing screen (the link drops the patient straight here).
//   2. Details — name, SA ID, phone, T&C (blur-validated via shared hook).
//   3. Verify — phone OTP; on success the initiateCheckout hand-off runs
//      with a button-level "Setting up…" spinner (no interstitial page),
//      then a redirect to the single confirm→widget surface.
//
// Validation rules + per-field UX (blur-then-keystroke timing, single
// generic SA ID error, normalised phone validator) are SHARED with
// PatientSignupForm via `lib/forms/useFieldValidation` + `lib/validation`.
// No parallel validation logic lives here — the schema below just wires
// the existing validators into the existing hook.
//
// State is purely client-side until the Pay submit. The server action
// is the single commit point — it creates the auth user, profile,
// payments schedule, and Peach checkout in one trip.
//
// Mobile-first. Visual rhythm: one heading per step, an anchoring
// medallion icon, generous whitespace, a single primary button. The
// condensed BillChip keeps the deal visible without re-printing the
// full summary on every screen.

// Server-action result shapes for the two phone-OTP actions. The
// codes here match exactly what app/checkout/[token]/actions.ts
// returns — keep the unions in lockstep with the action sources.
export type PhoneOtpStartResult =
  | { ok: true }
  | { ok: false; code:
        | 'invalid_phone' | 'invalid_token' | 'too_soon' | 'daily_limit'
        | 'token_daily_limit'    // 0055 — per-token total cap (SMS-burn)
        | 'sms_failed' | 'sms_not_configured' | 'unknown';
    };

export type PhoneOtpVerifyResult =
  | { ok: true }
  | { ok: false; code:
        | 'invalid_phone' | 'invalid_code_format' | 'wrong_code'
        | 'expired' | 'too_many_attempts' | 'not_found' | 'unknown';
    };

type Props = {
  token:              string;
  email:              string;
  practiceName:       string;
  totalAmount:        number;
  invoiceNumber:      string | null;
  practiceReference:  string | null;
  /**
   * Post-0065: profile is the source of truth for salary_day. The
   * server passes it down when the invitation's email resolves to
   * a profile that already has one; the form then hides the
   * inline picker. Null → the form renders the picker so a first-
   * time patient (or a legacy profile without a salary_day) can
   * set it once — value flows back through initiateCheckout and
   * is persisted alongside the plan.
   */
  initialSalaryDay:   number | null;
  initiateCheckout:   (input: {
    token:       string;
    firstName:   string;
    lastName:    string;
    saIdNumber:  string;
    phone:       string;
    planType:    2 | 3;
    salaryDay?:  number | null;
  }) => Promise<
    | { ok: true;  checkoutId: string; amountCents: number; shopperResultUrl: string }
    | { ok: false; error: string }
    | { ok: false; error: string; requireLogin: true; loginUrl: string }
  >;
  requestPhoneOtp:    (token: string, phone: string) => Promise<PhoneOtpStartResult>;
  verifyPhoneOtp:     (token: string, phone: string, code: string) => Promise<PhoneOtpVerifyResult>;
};

// Three steps: Plan (1) → Details (2) → Verify (3). The phone-OTP gate
// (migration 0052) is step 3; on verification the initiateCheckout
// hand-off runs inline (button spinner) — there is no separate "Setting
// up your payment" screen and no opening bill-restatement screen.
type Step = 1 | 2 | 3;

// 30s resend cooldown lives inside the shared PhoneOtpStep now; the
// server-side prepare_phone_verification RPC is the authoritative
// rate-limit, so the UI just needs *some* cooldown for nice UX.

const MIN_AGE   = 18;
const SA_ID_LEN = 13;

// Same single-message rule as PatientSignupForm — the validator's
// internal reasons (length/format/date/citizenship/checksum) stay
// hidden from the user.
const SA_ID_GENERIC_ERROR = 'Please enter a valid SA ID number.';

// ─── Softer input styling ──────────────────────────────────────────────
// Larger min height (py-3 → ~46px), lighter border, teal focus glow
// (ring-4 with low alpha). Reads airy without sacrificing tap target.

const INPUT_BASE =
  'w-full rounded-xl border bg-white px-3.5 py-3 text-base text-[#0F1F3A] placeholder:text-[#A3AEC2] outline-none transition-colors focus:ring-4';
const INPUT_OK   = 'border-[#D8DEE8] focus:border-[#15A89E] focus:ring-[#15A89E]/15';
const INPUT_ERR  = 'border-[#E07A7A] focus:border-[#D14141] focus:ring-[#D14141]/15';

function inputClass(hasError: boolean) {
  return `${INPUT_BASE} ${hasError ? INPUT_ERR : INPUT_OK}`;
}

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

// ─── Tiny client-side schedule preview ─────────────────────────────────────
//
// Mirrors lib/finance.ts splitInstalments + calculatePaymentDates so
// the patient sees the schedule before the server runs the canonical
// calculation. Kept tiny + self-contained so a missed import doesn't
// pull the whole finance module into the client bundle.

function previewInstalments(total: number, planType: 2 | 3): number[] {
  const totalCents = Math.round(total * 100);
  const baseCents  = Math.floor(totalCents / planType);
  const remainder  = totalCents - baseCents * planType;
  return Array.from({ length: planType }, (_, i) =>
    (i === 0 ? baseCents + remainder : baseCents) / 100,
  );
}

function previewDates(salaryDay: number, planType: 2 | 3, today: Date = new Date()): Date[] {
  // Match server logic in lib/finance.ts → calculatePaymentDates:
  //   #1 = today (immediate first charge)
  //   #2 = next salary day at least 5 days away
  //   #3 = the month after #2's salary day
  const utcToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dates: Date[] = [utcToday];

  function lastDayOfMonth(y: number, m: number): number {
    return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  }
  function clamp(y: number, m: number, day: number): Date {
    return new Date(Date.UTC(y, m, Math.min(day, lastDayOfMonth(y, m))));
  }

  const bufferDays = 5;
  const earliest = new Date(Date.UTC(
    utcToday.getUTCFullYear(), utcToday.getUTCMonth(), utcToday.getUTCDate() + bufferDays,
  ));

  let candidate = clamp(utcToday.getUTCFullYear(), utcToday.getUTCMonth(), salaryDay);
  if (candidate < earliest) {
    const nextMonth = utcToday.getUTCMonth() === 11 ? 0 : utcToday.getUTCMonth() + 1;
    const nextYear  = utcToday.getUTCMonth() === 11 ? utcToday.getUTCFullYear() + 1 : utcToday.getUTCFullYear();
    candidate = clamp(nextYear, nextMonth, salaryDay);
  }
  dates.push(candidate);

  if (planType === 3) {
    const m3 = candidate.getUTCMonth() === 11 ? 0 : candidate.getUTCMonth() + 1;
    const y3 = candidate.getUTCMonth() === 11 ? candidate.getUTCFullYear() + 1 : candidate.getUTCFullYear();
    dates.push(clamp(y3, m3, salaryDay));
  }

  return dates;
}

// ─── Quiet step indicator ──────────────────────────────────────────────
//
// Three dots, current step expanded. No labels, no chrome. The
// medallion in StepShell handles the "what step is this" load; this
// just confirms position in the flow.

function StepDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center justify-center gap-1.5 mb-5" aria-label={`Step ${step} of 3`}>
      {([1, 2, 3] as Step[]).map((n) => (
        <span
          key={n}
          aria-hidden
          className={`h-1.5 rounded-full transition-all ${
            n === step ? 'w-6 bg-[#13294B]'
            : n  <  step ? 'w-1.5 bg-[#15A89E]'
            :              'w-1.5 bg-[#D8DEE8]'
          }`}
        />
      ))}
    </div>
  );
}

// ─── Step-3 details — schema fed into the shared hook ─────────────────────

type DetailsFields = {
  firstName:     string;
  lastName:      string;
  saIdNumber:    string;
  phone:         string;
  termsAccepted: boolean;
};

const BLANK_DETAILS: DetailsFields = {
  firstName:     '',
  lastName:      '',
  saIdNumber:    '',
  phone:         '',
  termsAccepted: false,
};

// ─── The form ─────────────────────────────────────────────────────────────

export default function CheckoutForm({
  // email / invoiceNumber / practiceReference are still accepted (the
  // page passes them) but no longer rendered — the opening bill-
  // restatement screen that showed them is gone; the BillChip header
  // (practice + amount) carries the deal now.
  token, practiceName, totalAmount,
  initialSalaryDay,
  initiateCheckout, requestPhoneOtp, verifyPhoneOtp,
}: Props) {
  const [step, setStep] = useState<Step>(1);

  // Plan-step state — defaults are always valid; no schema entries needed.
  // Default to the 3-payment (smaller-instalment) option — it's the one
  // rendered first/on top and the gentler cash-flow choice.
  const [planType,  setPlanType]  = useState<2 | 3>(3);
  // Post-0065: prefer the value the server already knows (profile
  // source of truth). If none, fall back to 25 which is the modal
  // ZA payday and keeps the schedule preview meaningful before the
  // patient explicitly picks.
  const [salaryDay, setSalaryDay] = useState<number>(initialSalaryDay ?? 25);
  // The inline picker renders only when we don't have a stored
  // salary_day — a returning patient with one on their profile
  // never sees it. `forceSalaryDayPicker` is the client-side
  // fallback for the edge case where a server-side race between
  // page load and Pay submit left the profile with no salary_day
  // (rare, but the server returns 'missing_salary_day' and we
  // toggle this flag to reveal the picker on Step 2).
  const [forceSalaryDayPicker, setForceSalaryDayPicker] = useState(false);
  const showSalaryDayPicker = initialSalaryDay == null || forceSalaryDayPicker;

  // Step 3 state — passed as a single object into useFieldValidation so
  // the blur/keystroke-after-error semantics behave identically to the
  // signup forms.
  const [details, setDetails] = useState<DetailsFields>(BLANK_DETAILS);

  const schema = useMemo<FieldsSchema<DetailsFields>>(() => ({
    firstName:  { validate: (v) => v.firstName.trim() ? null : 'First name is required.' },
    lastName:   { validate: (v) => v.lastName.trim()  ? null : 'Last name is required.' },
    saIdNumber: {
      validate: (v) => {
        const r = validateSaId(v.saIdNumber);
        if (!r.valid) return SA_ID_GENERIC_ERROR;
        const age = saIdAge(v.saIdNumber);
        if (age === null || age < MIN_AGE) {
          return `You must be ${MIN_AGE} or older to accept a payment plan.`;
        }
        return null;
      },
      // No suppressLive — same rule as PatientSignupForm: errors are
      // gated by "field has been blurred at least once". The single
      // generic message means we can show on blur regardless of digit
      // count without leaking the validator's internal reason codes.
    },
    phone: {
      validate: (v) =>
        normalizePhoneZA(v.phone) ? null : 'Enter a valid South African cellphone number.',
    },
    termsAccepted: {
      validate: (v) => v.termsAccepted ? null : 'Please accept the payment-plan terms to continue.',
    },
  }), []);

  const { errors, handleBlur, validateAll } = useFieldValidation(details, schema);

  function setText(key: Exclude<keyof DetailsFields, 'termsAccepted'>) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = key === 'saIdNumber'
        ? e.target.value.replace(/\D/g, '')  // strip non-digits as the user types
        : e.target.value;
      setDetails(d => ({ ...d, [key]: val }));
    };
  }
  const onBlur = (key: keyof DetailsFields) => () => handleBlur(key);

  const router = useRouter();

  const [error,     setError]     = useState<string | null>(null);
  // When the server says "this email collides with an organic account",
  // we render a Log in CTA next to the error instead of bare red text.
  const [loginUrl,  setLoginUrl]  = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Post-"Continue to payment": initiateCheckout has created the account
  // + Peach checkout and signed the patient in. We redirect to
  // /checkout/[token], which renders the SINGLE confirm+widget surface
  // (ResumeCapture, for a signed-in owner of an uncaptured plan). This
  // form deliberately shows no payment confirm — the one confirm lives on
  // that surface. `redirecting` keeps the button in its pending state
  // while the navigation swaps the page.
  const [redirecting, setRedirecting] = useState(false);

  // Post-OTP hand-off. When true, the Verify step (3) swaps its OTP body
  // for a button-level "Setting up…" spinner while initiateCheckout runs
  // — there is NO standalone full-page loading screen. Cleared
  // when the hand-off bounces back to an earlier step (verify/plan/details).
  const [handoff, setHandoff] = useState(false);

  // Phone-OTP state lives entirely inside the shared <PhoneOtpStep />.
  // CheckoutForm only needs a remount-key — bumping it on
  // change-number / verify_phone_required forces the embedded step
  // to re-mount and re-fire its auto-send for the new (token, phone).
  const [otpStepKey, setOtpStepKey] = useState(0);

  const instalments = useMemo(() => previewInstalments(totalAmount, planType), [totalAmount, planType]);
  const dates       = useMemo(() => previewDates(salaryDay, planType),         [salaryDay, planType]);

  // Gate the step-3 → step-4 (Verify) transition on a full validateAll
  // pass. Without this, the patient could move past Details with an
  // invalid phone and we'd ship an OTP to a malformed number.
  function handleContinueFromDetails() {
    const { ok, firstInvalid } = validateAll();
    if (!ok) {
      if (firstInvalid) {
        const id = `checkout-${String(firstInvalid)}`;
        requestAnimationFrame(() => focusAndScrollTo(id));
      }
      return;
    }
    setStep(3);
  }

  // Bump the key so the embedded PhoneOtpStep remounts and re-fires
  // its auto-send for the new phone. Called from Change-number and
  // from the verify_phone_required bounce-back below.
  function resetOtpStep() {
    setOtpStepKey(k => k + 1);
  }

  function handleChangeNumber() {
    resetOtpStep();
    setStep(2);
  }

  // After OTP verification we go STRAIGHT to the payment hand-off — no
  // interstitial screen. submitPay creates the account + checkout and
  // redirects to the single pre-card confirm (ResumeCapture: schedule +
  // amount + Pay). `handoff` swaps the Verify step's OTP body for a
  // button-level "Setting up…" spinner (or an error + retry if
  // initiateCheckout fails / bounces) — the user never leaves this step
  // for a standalone loading page.
  function handleVerified() {
    setHandoff(true);
    submitPay();
  }

  function submitPay() {
    setError(null);
    setLoginUrl(null);

    // Submit-time backstop. validateAll() also marks all fields
    // touched and finds the first invalid for focusing.
    const { ok, firstInvalid } = validateAll();
    if (!ok) {
      setError('Please complete the required fields highlighted above.');
      if (firstInvalid) {
        // The invalid field lives on the Details step (2) — bounce back
        // so the patient sees the inline errors next to the inputs.
        setHandoff(false);
        setStep(2);
        requestAnimationFrame(() => focusAndScrollTo(`checkout-${String(firstInvalid)}`));
      }
      return;
    }

    startTransition(async () => {
      // The try/catch is load-bearing: if initiateCheckout throws
      // (function timeout reaching Peach, network drop), the
      // rejection would surface as an uncaught promise inside the
      // transition — isPending eventually resets but the patient
      // sees a re-enabled button with NO error. Catch + surface a
      // clear error so they see what happened.
      try {
        const result = await initiateCheckout({
          token,
          firstName:  details.firstName,
          lastName:   details.lastName,
          saIdNumber: details.saIdNumber.trim(),
          phone:      details.phone.trim(),
          planType,
          // Only send the client-picked value when the picker was
          // rendered. For a returning patient whose profile has one
          // already, the server sources it — sending anything here
          // would be silently ignored, but we omit it to make the
          // wire trace unambiguous.
          salaryDay:  showSalaryDayPicker ? salaryDay : null,
        });
        if (!result.ok) {
          // The server's "verify_phone_required" code means the row
          // we expected to find is missing or stale (>30min). Bounce
          // back to the Verify step; on entry it'll fire a fresh
          // requestPhoneOtp (the otpSentForPhoneRef is reset on
          // change-number / fresh entry).
          if (result.error === 'verify_phone_required') {
            // Verification row is missing or stale (>30 min).
            // resetOtpStep remounts the PhoneOtpStep so its auto-send
            // re-fires. Clear the hand-off so the OTP body shows again.
            setHandoff(false);
            resetOtpStep();
            setStep(3);
            setError(null);
            return;
          }
          if (result.error === 'missing_salary_day') {
            // Server couldn't source a salary_day from the profile
            // and we didn't send one. Force the inline picker on and
            // bounce back to the Plan step (1) with a clear message.
            setHandoff(false);
            setForceSalaryDayPicker(true);
            setStep(1);
            setError('Please pick when you get paid — this saves to your profile for future bills too.');
            return;
          }
          setError(result.error);
          if ('requireLogin' in result && result.requireLogin) {
            setLoginUrl(result.loginUrl);
          }
          return;
        }
        if (!result.checkoutId || !result.shopperResultUrl) {
          setError('The payment service didn\'t return a checkout. Please try again in a moment.');
          return;
        }
        // Account created + signed in + Peach checkout minted. Redirect
        // to /checkout/[token] — initiateCheckout mutated cookies (sign-in
        // + checkout token + fresh-checkout), so the route re-renders
        // server-side as the "signed-in owner of an uncaptured plan"
        // branch → ResumeCapture, which owns THE single confirm (schedule
        // + amount + Pay) → widget. This form never showed a payment
        // confirm, so there is exactly one confirm and it lives on the
        // surface that mounts the widget.
        setRedirecting(true);
        router.replace(`/checkout/${token}`);
      } catch (err) {
        setError(
          err instanceof Error
            ? `Couldn't reach the payment service (${err.message}). Please try again in a moment.`
            : 'Couldn\'t reach the payment service. Please try again in a moment.',
        );
      }
    });
  }


  return (
    <>
      <StepDots step={step} />

      <div className="mb-5">
        <BillChip practiceName={practiceName} totalAmount={totalAmount} />
      </div>

      {/* ── Step 1: plan + salary day ───────────────────────────────────
          Plan choice is rendered by <PlanPickerCards/> — a presentation-
          only restyle of the previous radio-button grid. The cards show
          the hero per-instalment amount, the "N payments on your salary
          dates" honest cadence, the load-bearing "No interest or fees"
          trust signal, and the total as a de-emphasised secondary line.
          State (planType, setPlanType) and the per-instalment amount
          come from THIS component's existing values (previewInstalments
          + useState above) — the cards never recompute. */}
      {step === 1 && (
        <StepShell
          icon="calendar"
          heading="Choose how to split your bill"
          subhead={`From ${practiceName}. Interest-free, on the days you get paid.`}
          actions={<PrimaryButton onClick={() => setStep(2)}>Looks good</PrimaryButton>}
        >
          <PlanPickerCards
            totalAmount={totalAmount}
            planType={planType}
            setPlanType={setPlanType}
            perInstalmentAmount={(n) => previewInstalments(totalAmount, n)[0]}
          />

          {/* Inline salary-day capture — rendered ONLY when the server
              couldn't source one from the patient's profile (new
              signup or legacy profile with no stored value).
              Returning patients with a stored value never see this. */}
          {showSalaryDayPicker && (
            <div data-testid="checkout-salary-day-picker">
              <label htmlFor="salaryDay" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
                When do you get paid?
              </label>
              <p className="text-xs text-[#7A8AA0] mb-2">
                We&apos;ll save this to your profile so future bills use it automatically.
              </p>
              <select
                id="salaryDay"
                value={salaryDay}
                onChange={(e) => setSalaryDay(parseInt(e.target.value, 10))}
                className="w-full rounded-xl border border-[#D8DEE8] bg-white px-3.5 py-3 text-base text-[#0F1F3A] focus:border-[#15A89E] focus:ring-4 focus:ring-[#15A89E]/15 outline-none"
              >
                {ALLOWED_SALARY_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}{d === 1 || d === 31 ? 'st' : 'th'} of the month
                  </option>
                ))}
              </select>
            </div>
          )}

          <ScheduleStrip instalments={instalments} dates={dates} />
        </StepShell>
      )}

      {/* ── Step 2: details (blur-validated via shared hook) ─────────── */}
      {step === 2 && (
        <StepShell
          icon="idcard"
          heading="Just your details"
          actions={
            <div className="flex items-center justify-between gap-4">
              <SecondaryButton onClick={() => setStep(1)}>← Back</SecondaryButton>
              <div className="flex-1 max-w-xs ml-auto">
                <PrimaryButton onClick={handleContinueFromDetails}>Continue to pay</PrimaryButton>
              </div>
            </div>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="checkout-firstName" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
                First name
              </label>
              <input
                id="checkout-firstName"
                type="text"
                autoComplete="given-name"
                value={details.firstName}
                onChange={setText('firstName')}
                onBlur={onBlur('firstName')}
                aria-invalid={!!errors.firstName}
                className={inputClass(!!errors.firstName)}
              />
              {errors.firstName && <p className="mt-1.5 text-xs text-[#D14141]">{errors.firstName}</p>}
            </div>
            <div>
              <label htmlFor="checkout-lastName" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
                Last name
              </label>
              <input
                id="checkout-lastName"
                type="text"
                autoComplete="family-name"
                value={details.lastName}
                onChange={setText('lastName')}
                onBlur={onBlur('lastName')}
                aria-invalid={!!errors.lastName}
                className={inputClass(!!errors.lastName)}
              />
              {errors.lastName && <p className="mt-1.5 text-xs text-[#D14141]">{errors.lastName}</p>}
            </div>
          </div>

          <div>
            <label htmlFor="checkout-saIdNumber" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
              SA ID number
            </label>
            <input
              id="checkout-saIdNumber"
              type="text"
              inputMode="numeric"
              maxLength={SA_ID_LEN}
              value={details.saIdNumber}
              onChange={setText('saIdNumber')}
              onBlur={onBlur('saIdNumber')}
              aria-invalid={!!errors.saIdNumber}
              placeholder="13 digits"
              className={`${inputClass(!!errors.saIdNumber)} font-mono tabular-nums tracking-wide`}
            />
            {errors.saIdNumber && <p className="mt-1.5 text-xs text-[#D14141]">{errors.saIdNumber}</p>}
          </div>

          <div>
            <label htmlFor="checkout-phone" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
              Cellphone
            </label>
            <input
              id="checkout-phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={details.phone}
              onChange={setText('phone')}
              onBlur={onBlur('phone')}
              aria-invalid={!!errors.phone}
              placeholder="082 123 4567"
              className={inputClass(!!errors.phone)}
            />
            {errors.phone && <p className="mt-1.5 text-xs text-[#D14141]">{errors.phone}</p>}
          </div>

          <div>
            <label
              htmlFor="checkout-termsAccepted"
              className={`flex items-start gap-3 text-sm rounded-xl border px-4 py-3 transition-colors cursor-pointer ${
                errors.termsAccepted
                  ? 'border-[#E07A7A] bg-[#FCEAEA] text-[#0F1F3A]'
                  : 'border-[#E5E9F0] bg-[#FAFBFD] text-[#3A4B66] hover:border-[#D8DEE8]'
              }`}
            >
              <input
                id="checkout-termsAccepted"
                type="checkbox"
                checked={details.termsAccepted}
                onChange={(e) => setDetails(d => ({ ...d, termsAccepted: e.target.checked }))}
                onBlur={onBlur('termsAccepted')}
                aria-invalid={!!errors.termsAccepted}
                className="mt-0.5 h-4 w-4 accent-[#15A89E]"
              />
              <span className="leading-relaxed">
                I agree to the{' '}
                <Link
                  href="/legal/terms"
                  target="_blank"
                  rel="noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="font-semibold underline underline-offset-2"
                  style={{ color: '#15A89E' }}
                >
                  payment-plan terms
                </Link>
                {' '}and authorise the scheduled instalment debits on the dates shown.
              </span>
            </label>
            {errors.termsAccepted && <p className="mt-1.5 text-xs text-[#D14141]">{errors.termsAccepted}</p>}
          </div>

          <p className="flex items-center gap-1.5 text-xs text-[#7A8AA0]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
              <rect x="5" y="11" width="14" height="9" rx="1.5" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            Your ID is encrypted at rest — only ever shown back masked.
          </p>
        </StepShell>
      )}

      {/* ── Step 3: phone OTP verification (shared component) ───────────
          Visual identity = checkout's StepShell chrome. The shared
          PhoneOtpStep owns the input + auto-send + resend + verify
          + error-mapping; we pass it the checkout-keyed server actions
          and a shell render-prop that wraps the body in StepShell.
          The key={otpStepKey} forces a remount on Change-number /
          verify_phone_required so auto-send re-fires for the new
          (token, phone) pair. On verify, `handoff` flips and the block
          below replaces this OTP body with a button-level spinner. */}
      {step === 3 && !handoff && (
        <PhoneOtpStep
          key={otpStepKey}
          phoneDisplay={details.phone}
          requestCode={() => requestPhoneOtp(token, details.phone)}
          verifyCode={(c) => verifyPhoneOtp(token, details.phone, c)}
          onVerified={handleVerified}
          onChangeNumber={handleChangeNumber}
          shell={(body, actions) => (
            <StepShell
              icon="shield"
              heading="Verify your phone"
              subhead={`Code sent to ${details.phone || 'your number'}.`}
              actions={actions ?? <div />}
            >
              {body}
            </StepShell>
          )}
        />
      )}

      {/* ── Step 3 hand-off (button-level loading — NOT a standalone page) ──
          The redundant "Continue to payment" / full-page loading screen
          is gone. On OTP verify, `handoff` flips and this block
          replaces the OTP body IN PLACE: a spinner ON the pay button
          ("Setting up…") while initiateCheckout creates the account +
          checkout, then a redirect to the SINGLE pre-card confirm
          (ResumeCapture: schedule + amount + Pay → widget). If
          initiateCheckout errors, we surface it here with a retry — still
          no separate page. verify_phone_required / missing_salary_day
          clear `handoff` and bounce to the relevant earlier step. */}
      {step === 3 && handoff && (
        <StepShell
          icon="card"
          heading={error ? 'Let’s try that again' : 'Almost there'}
          subhead={error ? undefined : 'No charge yet — your card comes next.'}
          actions={
            error ? (
              <div className="space-y-3">
                <PrimaryButton onClick={submitPay} disabled={isPending || redirecting}>
                  {(isPending || redirecting) ? 'Setting up…' : 'Try again'}
                </PrimaryButton>
                <div className="flex justify-center">
                  {/* Back goes to Details (2); the patient stays verified,
                      so re-verification isn't forced on the return. */}
                  <SecondaryButton
                    onClick={() => { setHandoff(false); setStep(2); }}
                    disabled={isPending || redirecting}
                  >
                    ← Back
                  </SecondaryButton>
                </div>
              </div>
            ) : (
              // The loading lives ON the button they just used — no
              // interstitial screen. Disabled + spinner + "Setting up…".
              <PrimaryButton disabled>
                <span className="inline-flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
                  </svg>
                  Setting up…
                </span>
              </PrimaryButton>
            )
          }
        >
          {!error && (
            <p className="text-center text-sm text-[#3A4B66]" data-testid="checkout-handoff-loading">
              No charge yet — you&apos;ll confirm your{' '}
              <span className="font-medium text-[#0F1F3A]">{formatRand(instalments[0])}</span> first
              instalment and enter your card on the next screen.
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-xl bg-[#FCEAEA] border border-[#E07A7A] px-4 py-3 space-y-3"
            >
              <p className="text-sm text-[#8A1F1F]">{error}</p>
              {loginUrl && (
                <a
                  href={loginUrl}
                  className="inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_140%)] px-4 py-2 text-sm font-semibold text-white hover:shadow-md transition-shadow"
                >
                  Log in
                </a>
              )}
            </div>
          )}
        </StepShell>
      )}

      <p className="text-center text-xs text-[#7A8AA0] mt-6 flex items-center justify-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
          <rect x="5" y="11" width="14" height="9" rx="1.5" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        Secure payments · Card details never touch betternow
      </p>
    </>
  );
}
