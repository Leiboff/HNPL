'use client';

import { useEffect, useRef, useState, useTransition, useMemo } from 'react';
import { ALLOWED_SALARY_DAYS } from '@/lib/salaryDates';
import {
  normalizePhoneZA,
  validateSaId,
  saIdAge,
} from '@/lib/validation';
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

// ─── Multi-step anonymous checkout ─────────────────────────────────────────
//
// Three visible steps + a final Pay submit:
//   1. Bill review — reads the bill back, confirms the deal.
//   2. Plan — 2 vs 3 instalments + salary day → schedule preview.
//   3. Details — name, SA ID, phone (blur-validated via shared hook).
//   4. Pay — single button → Paystack.
//
// Validation rules + per-field UX (blur-then-keystroke timing, single
// generic SA ID error, normalised phone validator) are SHARED with
// PatientSignupForm via `lib/forms/useFieldValidation` + `lib/validation`.
// No parallel validation logic lives here — the schema below just wires
// the existing validators into the existing hook.
//
// State is purely client-side until the Pay submit. The server action
// is the single commit point — it creates the auth user, profile,
// payments schedule, and Paystack transaction in one trip.
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
  initiateCheckout:   (input: {
    token:       string;
    firstName:   string;
    lastName:    string;
    saIdNumber:  string;
    phone:       string;
    planType:    2 | 3;
    salaryDay:   number;
  }) => Promise<
    | { ok: true;  authorizationUrl: string }
    | { ok: false; error: string }
    | { ok: false; error: string; requireLogin: true; loginUrl: string }
  >;
  requestPhoneOtp:    (token: string, phone: string) => Promise<PhoneOtpStartResult>;
  verifyPhoneOtp:     (token: string, phone: string, code: string) => Promise<PhoneOtpVerifyResult>;
};

// Five steps now: Bill → Plan → Details → Verify → Pay. The Verify
// step (4) was inserted between Details (3) and Pay (now 5) — phone-
// OTP gate per migration 0052. Pay was previously 4.
type Step = 1 | 2 | 3 | 4 | 5;

// 30s resend cooldown — mirrors the server-side rate limit in
// prepare_phone_verification. UI honours it for nice UX; the RPC
// enforces it for cost protection.
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

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

function formatDateLong(d: Date): string {
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' });
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
// Four dots, current step expanded. No labels, no chrome. The
// medallion in StepShell handles the "what step is this" load; this
// just confirms position in the flow.

function StepDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center justify-center gap-1.5 mb-5" aria-label={`Step ${step} of 5`}>
      {([1, 2, 3, 4, 5] as Step[]).map((n) => (
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

// ─── Step-4 OTP-resend button ────────────────────────────────────────────
//
// 30s countdown after each send, then becomes a tappable "Resend"
// button. The display is rAF-driven (1s tick) to avoid layout thrash
// from a 60-fps re-render — the countdown is informational, not
// timing-critical.

function OtpResendButton({
  unlockAt,
  onResend,
  disabled,
}: {
  unlockAt: number;       // epoch ms; before this we show a countdown
  onResend: () => void;
  disabled: boolean;
}) {
  // remaining seconds — driven by an interval, NEVER computed in the
  // render body (react-hooks/purity flags Date.now() during render
  // and is right to: re-renders triggered by unrelated state would
  // see stale countdown values otherwise).
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const compute = () => Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000));
    // Async IIFE for the initial setRemaining — keeps the lint rule
    // happy (no synchronous setState in the effect body). The 1s
    // interval below also calls setRemaining; that's "subscribe to
    // external state" which the rule explicitly allows.
    (async () => { setRemaining(compute()); })();
    if (compute() <= 0) return;
    const id = window.setInterval(() => {
      const next = compute();
      setRemaining(next);
      if (next <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [unlockAt]);

  const locked = remaining > 0;

  if (locked) {
    return (
      <span className="text-[#7A8AA0]">
        Didn’t arrive? Resend in <span className="font-medium tabular-nums text-[#3A4B66]">{remaining}s</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onResend}
      disabled={disabled}
      className="text-sm font-medium text-[#13294B] hover:text-[#0F1F3A] focus:outline-none focus-visible:underline disabled:opacity-60 transition-colors"
    >
      Didn’t arrive? Resend code
    </button>
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
  token, email, practiceName, totalAmount, invoiceNumber, practiceReference,
  initiateCheckout, requestPhoneOtp, verifyPhoneOtp,
}: Props) {
  const [step, setStep] = useState<Step>(1);

  // Step 2 state — defaults are always valid; no schema entries needed.
  const [planType,  setPlanType]  = useState<2 | 3>(2);
  const [salaryDay, setSalaryDay] = useState<number>(25);

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

  const [error,     setError]     = useState<string | null>(null);
  // When the server says "this email collides with an organic account",
  // we render a Log in CTA next to the error instead of bare red text.
  const [loginUrl,  setLoginUrl]  = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // ── Phone-OTP step state ──────────────────────────────────────────────
  // otpSentForPhone tracks which (normalized) phone we last asked the
  // server to send an OTP for. Re-entering step 4 with the same phone
  // is a no-op (we don't re-fire on every micro-re-render); changing
  // the phone at step 3 nullifies this, so the next Verify entry
  // re-fires for the new number. Server-side, the prepare RPC also
  // throttles (too_soon), so even a buggy double-fire is bounded.
  const [otpCode,         setOtpCode]         = useState('');
  const [otpError,        setOtpError]        = useState<string | null>(null);
  const [otpSending,      setOtpSending]      = useState(false);
  const [otpVerifying,    setOtpVerifying]    = useState(false);
  const [otpResendUnlock, setOtpResendUnlock] = useState<number>(0);  // epoch ms
  const [otpSentForPhone, setOtpSentForPhone] = useState<string | null>(null);
  const otpInputRef = useRef<HTMLInputElement | null>(null);

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
    setStep(4);
  }

  // Map a server coded error to user-facing copy. UI owns the wording;
  // the action only carries stable string codes. Typed as `string` so
  // both PhoneOtpStartResult and PhoneOtpVerifyResult codes flow in
  // without a TypeScript ballet.
  function otpErrorCopy(code: string): string {
    switch (code) {
      case 'too_soon':            return 'Please wait a moment before requesting another code.';
      case 'daily_limit':         return 'Too many code requests today. Try again tomorrow or contact your practice.';
      case 'invalid_token':       return 'This invitation link is no longer valid.';
      case 'invalid_phone':       return 'That phone number looks wrong. Go back and check it.';
      case 'invalid_code_format': return 'Please enter the 6-digit code.';
      case 'wrong_code':          return 'That code didn’t match — try again.';
      case 'expired':             return 'That code expired. Tap Resend to get a fresh one.';
      case 'too_many_attempts':   return 'Too many wrong codes. Tap Resend to start over.';
      case 'not_found':           return 'We couldn’t find your verification — tap Resend.';
      case 'sms_failed':          return 'We couldn’t send the SMS just now. Tap Resend to retry.';
      case 'sms_not_configured':  return 'SMS isn’t set up in this environment. Contact your practice.';
      default:                    return 'Something went wrong. Tap Resend to try again.';
    }
  }

  // Fire the initial OTP send for the entered phone whenever step 4
  // becomes active AND we haven't sent for this exact normalized phone
  // yet. We intentionally do NOT re-fire on every render in step 4
  // (the user can re-trigger by hitting Resend) — the otpSentForPhone
  // marker guards against double-send on transitions.
  useEffect(() => {
    if (step !== 4) return;
    const normalized = normalizePhoneZA(details.phone);
    if (!normalized) return;
    if (otpSentForPhone === normalized) return;

    // All setStates live inside the async IIFE — the lint rule allows
    // setState in async callbacks within effects (and rightly flags
    // synchronous setState in the effect body as a cascading-render
    // smell). Same pattern we use in InstallPrompt / NotificationsToggle.
    (async () => {
      setOtpError(null);
      setOtpSending(true);
      try {
        const r = await requestPhoneOtp(token, normalized);
        if (r.ok) {
          setOtpSentForPhone(normalized);
          setOtpResendUnlock(Date.now() + OTP_RESEND_COOLDOWN_MS);
        } else {
          setOtpError(otpErrorCopy(r.code));
          // Don't mark "sent for this phone" if it failed — the
          // patient hitting Resend should re-try.
        }
      } catch {
        setOtpError(otpErrorCopy('unknown'));
      } finally {
        setOtpSending(false);
      }
    })();
  // We intentionally exclude requestPhoneOtp from deps — it's a
  // server-action reference that's stable across renders, and React
  // 19's lint correctly allows omitting stable function refs from
  // useEffect deps. Including details.phone would re-fire if the user
  // types in step 3 then returns to 4 — that's the right behaviour.
  }, [step, details.phone, otpSentForPhone, token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleResendOtp() {
    if (Date.now() < otpResendUnlock) return;
    const normalized = normalizePhoneZA(details.phone);
    if (!normalized) { setOtpError(otpErrorCopy('invalid_phone')); return; }
    setOtpError(null);
    setOtpSending(true);
    try {
      const r = await requestPhoneOtp(token, normalized);
      if (r.ok) {
        setOtpCode('');
        setOtpSentForPhone(normalized);
        setOtpResendUnlock(Date.now() + OTP_RESEND_COOLDOWN_MS);
      } else {
        setOtpError(otpErrorCopy(r.code));
      }
    } finally {
      setOtpSending(false);
    }
  }

  async function handleVerifyOtp(codeToVerify: string) {
    const normalized = normalizePhoneZA(details.phone);
    if (!normalized) { setOtpError(otpErrorCopy('invalid_phone')); return; }
    if (!/^\d{6}$/.test(codeToVerify)) return;  // wait for 6 digits

    setOtpError(null);
    setOtpVerifying(true);
    try {
      const r = await verifyPhoneOtp(token, normalized, codeToVerify);
      if (r.ok) {
        // Verified — advance to Pay.
        setStep(5);
      } else {
        setOtpError(otpErrorCopy(r.code));
        // On too-many-attempts the next action is Resend (which resets
        // the attempt cap server-side). Clear the input to discourage
        // re-submitting the same wrong code.
        if (r.code === 'too_many_attempts' || r.code === 'expired') {
          setOtpCode('');
        }
      }
    } finally {
      setOtpVerifying(false);
    }
  }

  // 6-digit input handler: strip non-digits, auto-submit on the 6th.
  function handleOtpInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value.replace(/\D/g, '').slice(0, 6);
    setOtpCode(next);
    setOtpError(null);
    if (next.length === 6 && !otpVerifying) {
      void handleVerifyOtp(next);
    }
  }

  function handleChangeNumber() {
    // Drop the "we already sent" marker so a return to step 4 re-fires
    // for the new phone. Also clear any half-typed code + the
    // server-coded error.
    setOtpSentForPhone(null);
    setOtpCode('');
    setOtpError(null);
    setStep(3);
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
        // The invalid field lives on step 3 — bounce back so the
        // patient sees the inline errors next to the inputs.
        setStep(3);
        requestAnimationFrame(() => focusAndScrollTo(`checkout-${String(firstInvalid)}`));
      }
      return;
    }

    startTransition(async () => {
      // The try/catch is load-bearing: if initiateCheckout throws
      // (function timeout reaching Paystack, network drop), the
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
          salaryDay,
        });
        if (!result.ok) {
          // The server's "verify_phone_required" code means the row
          // we expected to find is missing or stale (>30min). Bounce
          // back to the Verify step; on entry it'll fire a fresh
          // requestPhoneOtp (the otpSentForPhoneRef is reset on
          // change-number / fresh entry).
          if (result.error === 'verify_phone_required') {
            setOtpSentForPhone(null);
            setStep(4);
            setError(null);
            return;
          }
          setError(result.error);
          if ('requireLogin' in result && result.requireLogin) {
            setLoginUrl(result.loginUrl);
          }
          return;
        }
        if (!result.authorizationUrl) {
          setError('The payment service didn\'t return a URL. Please try again in a moment.');
          return;
        }
        // Hard navigate so Paystack's redirect-back lands on a clean server
        // request that reads our auth cookie.
        window.location.href = result.authorizationUrl;
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

      {/* ── Step 1: bill review ──────────────────────────────────────── */}
      {step === 1 && (
        <StepShell
          icon="bill"
          heading="You have a bill to settle"
          subhead={`From ${practiceName}. Pay it in 2 or 3 instalments — interest-free.`}
          actions={<PrimaryButton onClick={() => setStep(2)}>Review my plan</PrimaryButton>}
        >
          <div className="rounded-2xl bg-[#FAFBFD] border border-[#E5E9F0] p-5 sm:p-6 text-center">
            <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#7A8AA0]">
              Amount due
            </p>
            <p className="mt-2 text-4xl font-semibold tabular-nums text-[#13294B]">
              {formatRand(totalAmount)}
            </p>
            {(invoiceNumber || practiceReference) && (
              <div className="mt-3 flex gap-2 flex-wrap justify-center">
                {invoiceNumber && (
                  <span className="font-mono text-xs text-[#3A4B66] bg-white border border-[#E5E9F0] rounded-full px-2.5 py-0.5">
                    {invoiceNumber}
                  </span>
                )}
                {practiceReference && (
                  <span className="font-mono text-xs text-[#3A4B66] bg-white border border-[#E5E9F0] rounded-full px-2.5 py-0.5">
                    {practiceReference}
                  </span>
                )}
              </div>
            )}
            <p className="mt-3 text-xs text-[#7A8AA0]">to {email}</p>
          </div>
        </StepShell>
      )}

      {/* ── Step 2: plan + salary day ─────────────────────────────────── */}
      {step === 2 && (
        <StepShell
          icon="calendar"
          heading="Split it how it suits you"
          actions={
            <div className="flex items-center justify-between gap-4">
              <SecondaryButton onClick={() => setStep(1)}>← Back</SecondaryButton>
              <div className="flex-1 max-w-xs ml-auto">
                <PrimaryButton onClick={() => setStep(3)}>Looks good</PrimaryButton>
              </div>
            </div>
          }
        >
          <div role="radiogroup" aria-label="Number of instalments" className="grid grid-cols-2 gap-3">
            {[2, 3].map((n) => {
              const active = planType === n;
              const each   = previewInstalments(totalAmount, n as 2 | 3)[0];
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPlanType(n as 2 | 3)}
                  className={`relative rounded-2xl border-2 p-4 text-left transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-[#15A89E]/20 ${
                    active
                      ? 'border-[#15A89E] bg-[#15A89E]/6'
                      : 'border-[#E5E9F0] bg-white hover:border-[#D8DEE8]'
                  }`}
                >
                  <p className="text-lg font-semibold text-[#0F1F3A]">{n} payments</p>
                  <p className="text-sm tabular-nums mt-0.5 text-[#3A4B66]">
                    {formatRand(each)} each
                  </p>
                  {active && (
                    <span
                      aria-hidden
                      className="absolute top-3 right-3 inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#15A89E] text-white"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
                        <path d="m5 12.5 4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div>
            <label htmlFor="salaryDay" className="block text-sm font-medium text-[#3A4B66] mb-1.5">
              When do you get paid?
            </label>
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

          <ScheduleStrip instalments={instalments} dates={dates} />
        </StepShell>
      )}

      {/* ── Step 3: details (blur-validated via shared hook) ─────────── */}
      {step === 3 && (
        <StepShell
          icon="idcard"
          heading="Just your details"
          actions={
            <div className="flex items-center justify-between gap-4">
              <SecondaryButton onClick={() => setStep(2)}>← Back</SecondaryButton>
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
                I agree to the payment-plan terms and authorise the scheduled
                instalment debits on the dates shown.
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

      {/* ── Step 4: phone OTP verification ───────────────────────────── */}
      {step === 4 && (
        <StepShell
          icon="shield"
          heading="Verify your phone"
          subhead={`We sent a 6-digit code to ${details.phone || 'your number'}.`}
          actions={
            <div className="space-y-3">
              <PrimaryButton
                onClick={() => void handleVerifyOtp(otpCode)}
                disabled={otpCode.length !== 6 || otpVerifying}
              >
                {otpVerifying ? 'Verifying…' : 'Verify code'}
              </PrimaryButton>
              <div className="flex justify-center">
                <SecondaryButton onClick={handleChangeNumber} disabled={otpVerifying}>
                  ← Change number
                </SecondaryButton>
              </div>
            </div>
          }
        >
          {/* The OTP input. autoComplete="one-time-code" + inputMode=
              "numeric" lets iOS Messages + Android Messages autofill
              the SMS body the moment it arrives. The "code is N"
              phrasing in lib/sms/smsportal.ts buildOtpSmsBody is the
              autofill heuristic — don't reword it without testing. */}
          <div>
            <label htmlFor="checkout-otp" className="sr-only">
              6-digit verification code
            </label>
            <input
              id="checkout-otp"
              ref={otpInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              value={otpCode}
              onChange={handleOtpInputChange}
              aria-invalid={!!otpError}
              placeholder="••••••"
              autoFocus
              className={`${inputClass(!!otpError)} text-center text-2xl tracking-[0.6em] font-mono tabular-nums`}
            />
            {otpError && <p className="mt-1.5 text-xs text-[#D14141]">{otpError}</p>}
          </div>

          <div className="flex items-center justify-center text-sm text-[#3A4B66]">
            {otpSending ? (
              <span className="text-[#7A8AA0]">Sending code…</span>
            ) : (
              <OtpResendButton
                unlockAt={otpResendUnlock}
                onResend={handleResendOtp}
                disabled={otpVerifying}
              />
            )}
          </div>

          <p className="text-xs text-[#7A8AA0] text-center">
            The code expires in 10 minutes. We never share your number.
          </p>
        </StepShell>
      )}

      {/* ── Step 5: pay ──────────────────────────────────────────────── */}
      {step === 5 && (
        <StepShell
          icon="card"
          heading="Confirm and pay"
          actions={
            <div className="space-y-3">
              <PrimaryButton onClick={submitPay} disabled={isPending}>
                {isPending ? 'Setting up payment…' : `Pay ${formatRand(instalments[0])} today`}
              </PrimaryButton>
              <div className="flex justify-center">
                {/* Back goes to Details (3), skipping the Verify step
                    on the return — the patient is already verified
                    when they're on Pay. Bouncing back through Verify
                    would re-fire the OTP unnecessarily. */}
                <SecondaryButton onClick={() => setStep(3)} disabled={isPending}>← Back</SecondaryButton>
              </div>
            </div>
          }
        >
          <div className="rounded-2xl bg-[#FAFBFD] border border-[#E5E9F0] p-5 sm:p-6">
            <p className="text-xs uppercase tracking-[0.08em] font-medium text-[#7A8AA0]">
              Charging your card now
            </p>
            <p className="mt-2 text-4xl font-semibold tabular-nums text-[#13294B]">
              {formatRand(instalments[0])}
            </p>
            {dates[1] && (
              <p className="mt-3 text-sm text-[#3A4B66]">
                Next:{' '}
                <span className="font-medium text-[#0F1F3A] tabular-nums">{formatRand(instalments[1])}</span>
                {' '}on{' '}
                <span className="font-medium text-[#0F1F3A]">{formatDateLong(dates[1])}</span>
                {dates[2] && (
                  <>
                    , then{' '}
                    <span className="font-medium text-[#0F1F3A] tabular-nums">{formatRand(instalments[2])}</span>
                    {' '}on{' '}
                    <span className="font-medium text-[#0F1F3A]">{formatDateLong(dates[2])}</span>
                  </>
                )}
                .
              </p>
            )}
          </div>

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
        Secured by Paystack · Card details never touch BetterNow
      </p>
    </>
  );
}
