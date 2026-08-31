import Link from 'next/link';
import PatientScreen from './PatientScreen';
import ActionCentreBell from './ActionCentreBell';
import { formatRand, formatDayMonth } from './_format';

// ─── HomeFailedState — v4 "Payment didn't go through" (screen 04) ─────────
//
// Home rendered in a failed state: a red header used once, a procedural
// (never punitive) body, and one way to pay. Triggered when the patient
// has a failed or defaulted instalment.
//
// Copy honesty (per the build decision): every line is backed by real
// data. The retry date is the row's actual next_attempt_date — never a
// made-up "Monday 4 Aug". We do NOT promise "no late fee is charged"
// (late/dunning fees can accrue); we state the interest-free truth and
// surface any fee that HAS been added. The "new plans are paused" step
// shows only when the account is genuinely frozen (a defaulted plan).

function StepRow({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span
        className="flex-none w-[26px] h-[26px] rounded-full flex items-center justify-center text-[12px] font-bold"
        style={{ background: 'var(--portal-wash)', color: 'var(--portal-ink-2)' }}
      >
        {n}
      </span>
      <p className="text-[14px] leading-[1.55]" style={{ color: 'var(--portal-ink-2)' }}>{children}</p>
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" style={{ stroke: 'var(--portal-faint)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export default function HomeFailedState({
  firstName,
  amount,
  practiceName,
  dueDate,
  retryDate,
  feesRand,
  cardBrand,
  cardLast4,
  altCard,
  planId,
  frozen,
}: {
  firstName:    string | null;
  amount:       number;
  practiceName: string;
  dueDate:      string;
  retryDate:    string | null;
  feesRand:     number;
  cardBrand:    string | null;
  cardLast4:    string | null;
  altCard:      { brand: string; last4: string } | null;
  planId:       string | null;
  frozen:       boolean;
}) {
  const cardLabel = cardBrand && cardLast4 ? `${cardBrand} ···· ${cardLast4}` : 'your card';

  const header = (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15.5px] font-semibold text-white">
          Hi {firstName ?? 'there'}
        </span>
        <ActionCentreBell onDark />
      </div>

      <div className="mt-[26px]">
        <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.18em', color: 'rgba(255,255,255,.62)' }}>
          Payment didn&rsquo;t go through
        </p>
        <p className="mt-[11px] font-bold tabular-nums text-white" style={{ fontSize: 48, lineHeight: '.94', letterSpacing: '-.045em' }}>
          {formatRand(amount).split('.')[0]}
          <span style={{ fontSize: 28, color: 'rgba(255,255,255,.55)' }}>.{formatRand(amount).split('.')[1]}</span>
        </p>
        <p className="mt-3 text-[14.5px]" style={{ color: 'rgba(255,255,255,.82)' }}>
          {practiceName} · was due {formatDayMonth(dueDate)}
        </p>
      </div>
    </>
  );

  return (
    <PatientScreen tone="fail" header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* What happens now */}
        <div
          className="rounded-card bg-white p-[18px] flex flex-col gap-[14px]"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>
            What happens now
          </p>
          <StepRow n={1}>
            {retryDate
              ? <>We&rsquo;ll try {cardLabel} again on <b>{formatDayMonth(retryDate)}</b>.</>
              : <>This payment is overdue and no more automatic retries are scheduled — please settle it below.</>}
          </StepRow>
          <StepRow n={2}>
            {feesRand > 0
              ? <>A <span className="tabular-nums">{formatRand(feesRand)}</span> late fee has been added. No interest is charged on your plan.</>
              : <>No interest is charged on your plan.</>}
          </StepRow>
          {frozen && (
            <StepRow n={3}>New plans are paused until this one is up to date.</StepRow>
          )}
        </div>

        {/* Two ways out */}
        <div
          className="rounded-card bg-white overflow-hidden"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          {altCard && (
            <Link href="/patient/account" className="flex items-center justify-between gap-3 p-[16px] hover:bg-gray-50 transition-colors">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold" style={{ color: 'var(--portal-ink)' }}>Use a different card</p>
                <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--portal-muted)' }}>
                  {altCard.brand} ···· {altCard.last4} is on file
                </p>
              </div>
              <Chevron />
            </Link>
          )}
          <a
            href="mailto:support@betternow.co.za"
            className={`flex items-center justify-between gap-3 p-[16px] hover:bg-gray-50 transition-colors ${altCard ? 'border-t' : ''}`}
            style={altCard ? { borderColor: 'var(--portal-hairline)' } : undefined}
          >
            <div className="min-w-0">
              <p className="text-[14px] font-semibold" style={{ color: 'var(--portal-ink)' }}>Can&rsquo;t pay right now?</p>
              <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--portal-muted)' }}>Talk to us — we&rsquo;ll work something out</p>
            </div>
            <Chevron />
          </a>
        </div>

        {/* Pay now */}
        <Link
          href={planId ? `/patient/orders/${planId}` : '/patient/orders'}
          className="block text-center text-[15px] font-semibold text-white rounded-tile py-[15px] tabular-nums"
          style={{ background: 'var(--portal-accent)' }}
        >
          Pay {formatRand(amount)} now
        </Link>

      </div>
    </PatientScreen>
  );
}
