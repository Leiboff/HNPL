'use client';

import { useState, useTransition, useMemo } from 'react';
import { ALLOWED_SALARY_DAYS } from '@/lib/salaryDates';

// ─── Multi-step anonymous checkout ─────────────────────────────────────────
//
// Three visible steps + a final Pay submit:
//   1. Bill review (informational; reads the bill back to the patient)
//   2. Plan selection (2 vs 3 instalments + salary day → schedule preview)
//   3. Patient details (name, SA ID, phone)
//   4. Pay — single button that calls initiateCheckout and redirects
//      to Paystack's authorization_url.
//
// State is purely client-side until the Pay submit. The server action
// is the single commit point — it creates the auth user, profile,
// payments schedule, and Paystack transaction in one trip.
//
// Mobile-first single-column layout. The bill summary is sticky at
// the top so the patient never loses sight of what they're paying for.

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
};

type Step = 1 | 2 | 3 | 4;

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
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

// ─── Step indicator ────────────────────────────────────────────────────────

function StepIndicator({ step }: { step: Step }) {
  const steps = ['Bill', 'Plan', 'Details', 'Pay'];
  return (
    <div className="flex items-center gap-1 mb-4">
      {steps.map((label, i) => {
        const idx     = (i + 1) as Step;
        const active  = idx === step;
        const done    = idx < step;
        return (
          <div key={label} className="flex items-center flex-1">
            <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-semibold ${
              done   ? 'bg-[#15A89E] text-white'
              : active ? 'bg-[#13294B] text-white'
              :         'bg-gray-200 text-gray-500'
            }`}>
              {done ? '✓' : idx}
            </div>
            <div className="ml-1.5 text-[11px] uppercase tracking-wide font-medium text-gray-600 truncate">
              {label}
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1.5 ${done ? 'bg-[#15A89E]' : 'bg-gray-200'}`} aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Bill summary card (sticky-ish at top) ─────────────────────────────────

function BillSummary({
  practiceName, totalAmount, invoiceNumber, practiceReference, email,
}: Pick<Props, 'practiceName' | 'totalAmount' | 'invoiceNumber' | 'practiceReference' | 'email'>) {
  return (
    <div className="bg-white rounded-2xl border-2 border-[#13294B]/10 p-4 mb-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">From</p>
      <p className="text-base font-semibold text-gray-900">{practiceName}</p>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="text-3xl font-bold text-[#13294B] tabular-nums">{formatRand(totalAmount)}</p>
        <p className="text-xs text-gray-500">to {email}</p>
      </div>
      {(invoiceNumber || practiceReference) && (
        <div className="mt-3 flex gap-2 flex-wrap text-xs text-gray-500">
          {invoiceNumber && (
            <span className="font-mono bg-gray-100 rounded px-2 py-0.5">{invoiceNumber}</span>
          )}
          {practiceReference && (
            <span className="font-mono bg-gray-100 rounded px-2 py-0.5">{practiceReference}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── The form ─────────────────────────────────────────────────────────────

export default function CheckoutForm({
  token, email, practiceName, totalAmount, invoiceNumber, practiceReference, initiateCheckout,
}: Props) {
  const [step, setStep] = useState<Step>(1);

  // Step 2 state
  const [planType,  setPlanType]  = useState<2 | 3>(2);
  const [salaryDay, setSalaryDay] = useState<number>(25);

  // Step 3 state
  const [firstName,   setFirstName]   = useState('');
  const [lastName,    setLastName]    = useState('');
  const [saIdNumber,  setSaIdNumber]  = useState('');
  const [phone,       setPhone]       = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [error,     setError]     = useState<string | null>(null);
  // When the server says "this email collides with an organic account",
  // we render a Log in CTA next to the error instead of bare red text.
  const [loginUrl,  setLoginUrl]  = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const instalments = useMemo(() => previewInstalments(totalAmount, planType), [totalAmount, planType]);
  const dates       = useMemo(() => previewDates(salaryDay, planType),         [salaryDay, planType]);

  function submitPay() {
    setError(null);
    setLoginUrl(null);
    if (!firstName.trim())              { setError('Enter your first name.'); return; }
    if (!lastName.trim())               { setError('Enter your last name.');  return; }
    if (!saIdNumber.trim())             { setError('Enter your SA ID number.'); return; }
    if (!phone.trim())                  { setError('Enter your cellphone number.'); return; }
    if (!termsAccepted)                 { setError('Please confirm you accept the payment-plan terms.'); return; }

    startTransition(async () => {
      const result = await initiateCheckout({
        token,
        firstName, lastName,
        saIdNumber: saIdNumber.trim(),
        phone:      phone.trim(),
        planType,
        salaryDay,
      });
      if (!result.ok) {
        setError(result.error);
        if ('requireLogin' in result && result.requireLogin) {
          setLoginUrl(result.loginUrl);
        }
        return;
      }
      // Hard navigate so Paystack's redirect-back lands on a clean server
      // request that reads our auth cookie.
      window.location.href = result.authorizationUrl;
    });
  }

  return (
    <>
      <StepIndicator step={step} />
      <BillSummary
        practiceName={practiceName}
        totalAmount={totalAmount}
        invoiceNumber={invoiceNumber}
        practiceReference={practiceReference}
        email={email}
      />

      {/* ── Step 1: bill review ──────────────────────────────────────── */}
      {step === 1 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm space-y-4">
          <h1 className="text-lg font-semibold text-gray-900">Review your bill</h1>
          <p className="text-sm text-gray-700">
            <span className="font-semibold">{practiceName}</span> sent you a bill for{' '}
            <span className="font-semibold tabular-nums">{formatRand(totalAmount)}</span>.
            Pay it over 2 or 3 months interest-free — no extra fees, no surprises.
          </p>
          <ul className="text-sm text-gray-600 space-y-1 list-disc list-inside">
            <li>First payment today, the rest collected automatically on your salary date.</li>
            <li>Your card details are stored securely with Paystack, never on our servers.</li>
            <li>You can manage the plan from your account at any time.</li>
          </ul>
          <button
            type="button"
            onClick={() => setStep(2)}
            className="w-full rounded-lg px-4 py-3 text-base font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            Continue →
          </button>
        </div>
      )}

      {/* ── Step 2: plan + salary day ─────────────────────────────────── */}
      {step === 2 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm space-y-4">
          <h1 className="text-lg font-semibold text-gray-900">Choose your plan</h1>

          <div role="radiogroup" aria-label="Number of instalments" className="grid grid-cols-2 gap-3">
            {[2, 3].map((n) => {
              const active = planType === n;
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPlanType(n as 2 | 3)}
                  className={`rounded-xl border-2 p-3 text-left transition-colors ${
                    active ? 'border-[#15A89E] bg-[#15A89E]/5' : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <p className="text-base font-semibold text-gray-900">{n} instalments</p>
                  <p className="text-xs text-gray-500 mt-0.5 tabular-nums">
                    {formatRand(previewInstalments(totalAmount, n as 2 | 3)[0])} each
                  </p>
                </button>
              );
            })}
          </div>

          <div>
            <label htmlFor="salaryDay" className="block text-sm font-medium text-gray-700 mb-1">
              Your salary date
            </label>
            <select
              id="salaryDay"
              value={salaryDay}
              onChange={(e) => setSalaryDay(parseInt(e.target.value, 10))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base bg-white"
            >
              {ALLOWED_SALARY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}{d === 1 || d === 31 ? 'st' : 'th'} of the month
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              We&apos;ll collect each future instalment on (or just after) your salary date.
            </p>
          </div>

          {/* Schedule preview */}
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-3">
            <p className="text-xs uppercase tracking-wide text-gray-500 font-medium mb-2">Your schedule</p>
            <ul className="space-y-1.5">
              {dates.map((d, i) => (
                <li key={i} className="flex items-center justify-between text-sm">
                  <span className="text-gray-700">
                    {i === 0 ? 'Today' : formatDate(d)}
                  </span>
                  <span className="font-semibold text-gray-900 tabular-nums">
                    {formatRand(instalments[i])}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="flex-1 rounded-lg px-4 py-3 text-base font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 transition-all hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: details ──────────────────────────────────────────── */}
      {step === 3 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm space-y-4">
          <h1 className="text-lg font-semibold text-gray-900">Your details</h1>
          <p className="text-sm text-gray-500">
            We need these to set up the payment plan. Your ID is encrypted at rest and never shown back in full.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-1">
                First name
              </label>
              <input
                id="firstName"
                type="text"
                autoComplete="given-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base"
              />
            </div>
            <div>
              <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-1">
                Last name
              </label>
              <input
                id="lastName"
                type="text"
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base"
              />
            </div>
          </div>

          <div>
            <label htmlFor="saIdNumber" className="block text-sm font-medium text-gray-700 mb-1">
              SA ID number
            </label>
            <input
              id="saIdNumber"
              type="text"
              inputMode="numeric"
              maxLength={13}
              value={saIdNumber}
              onChange={(e) => setSaIdNumber(e.target.value.replace(/\D/g, ''))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base font-mono tabular-nums"
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
              Cellphone
            </label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0821234567"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base"
            />
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              I agree to BetterNow&apos;s payment-plan terms and authorise the scheduled
              instalment debits on the dates above.
            </span>
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(4)}
              className="flex-1 rounded-lg px-4 py-3 text-base font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 transition-all hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: pay ──────────────────────────────────────────────── */}
      {step === 4 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm space-y-4">
          <h1 className="text-lg font-semibold text-gray-900">Pay your first instalment</h1>
          <div className="rounded-xl bg-gray-50 border border-gray-200 p-3">
            <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">Charging now</p>
            <p className="text-2xl font-bold text-[#13294B] tabular-nums mt-1">
              {formatRand(instalments[0])}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Next: {formatRand(instalments[1] ?? 0)} on {dates[1] ? formatDate(dates[1]) : '—'}
              {dates[2] && `, then ${formatRand(instalments[2])} on ${formatDate(dates[2])}`}
            </p>
          </div>

          <p className="text-sm text-gray-600">
            We&apos;ll take you to Paystack to enter your card. Your account is created the
            moment your card is charged — no separate signup step.
          </p>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 space-y-2">
              <p className="text-sm text-red-700">{error}</p>
              {loginUrl && (
                <a
                  href={loginUrl}
                  className="inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_145%)] px-4 py-2 text-sm font-semibold text-white hover:shadow-md transition-all"
                >
                  Log in →
                </a>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep(3)}
              disabled={isPending}
              className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 disabled:opacity-60"
            >
              Back
            </button>
            <button
              type="button"
              onClick={submitPay}
              disabled={isPending}
              className="flex-1 rounded-lg px-4 py-3 text-base font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 transition-all hover:shadow-lg disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              {isPending ? 'Setting up payment…' : `Pay ${formatRand(instalments[0])} →`}
            </button>
          </div>
        </div>
      )}

      <p className="text-center text-[11px] text-gray-400 mt-6">
        Secured by Paystack · Card details never touch BetterNow servers
      </p>
    </>
  );
}
