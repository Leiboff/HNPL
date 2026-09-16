import Link from 'next/link';
import PatientScreen from './PatientScreen';
import ActionCentreBell from './ActionCentreBell';
import { formatRand, formatDayMonth } from './_format';

// ─── HomeFailedState — Home, in the missed-payment state ─────────────────
//
// Rendered instead of the normal Home when the patient has a failed or
// defaulted instalment. The TRIGGER is unchanged (see the short-circuit in
// page.tsx); what changed in v5 is that this stopped being a red screen.
//
// ─── WHY THE RED HEADER IS GONE ───────────────────────────────────────
//
// v4 gave this state its own canvas: a #7A1F1F band with a red glow, the
// only place in the portal that colour appeared. It was legible, and it
// was wrong twice over. It made a recoverable, ordinary event — a card
// declined, which mostly means an expiry or a daily limit — look like an
// account in disgrace; and it broke the one structural promise the shell
// makes, that a navy band means "this screen leads with a figure" and the
// figure means the same thing everywhere. A patient who lands here should
// see their own home screen with one card gone red, not a different app.
//
// So the danger treatment now lives where the danger is: a red eyebrow, a
// red amount and a danger chip on the top card, over the standard navy
// hero, with a NAVY call to action. Navy, not red: the button is the way
// out, and colouring the escape route like the problem is what makes a
// screen feel punitive. This is the same treatment the ordinary Home gives
// an overdue instalment, one step further along — which is the point.
//
// Copy honesty (unchanged): every line is backed by real data. The retry
// date is the row's actual next_attempt_date — never a made-up "Monday 4
// Aug". We do NOT promise "no late fee is charged" (late/dunning fees can
// accrue); we state the interest-free truth and surface any fee that HAS
// been added. The "new plans are paused" step shows only when the account
// is genuinely frozen (a defaulted plan).

const CARD_SHADOW = '0 2px 8px -3px rgba(15,31,58,.09)';
const CARD_BORDER = '1px solid rgba(19,41,75,.06)';
const DANGER      = '#B42318';
const DANGER_WASH = 'rgba(180,35,24,.10)';

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

  // The chip states the mechanical fact, which is also the most useful one:
  // whether an automatic attempt is still coming. "No retries left" is why
  // settling by hand is now the only route, and it is true exactly when the
  // row carries no next_attempt_date.
  const chip = retryDate ? `Retry ${formatDayMonth(retryDate)}` : 'No retries left';

  const header = (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[15.5px] font-semibold text-white">
        Hi {firstName ?? 'there'}
      </span>
      <ActionCentreBell onDark />
    </div>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* The amount owed — the same shape as Home's next-payment card, in
            the danger treatment. Eyebrow, figure and meta go red; the CTA
            stays navy. */}
        <div
          className="bn-up rounded-card bg-white p-[18px] flex flex-col gap-[16px]"
          style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
          data-testid="home-failed-amount"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.16em', color: DANGER }}>
                {frozen ? 'Settle to unfreeze' : 'Payment didn’t go through'}
              </p>
              <p className="mt-[9px] text-[34px] font-bold tabular-nums leading-none" style={{ color: DANGER, letterSpacing: '-.04em' }}>
                {formatRand(amount)}
              </p>
            </div>
            <span
              className="flex-none text-[12px] font-semibold rounded-full px-[13px] py-2"
              style={{ background: DANGER_WASH, color: DANGER }}
            >
              {chip}
            </span>
          </div>
          <p className="text-[13.5px] leading-[1.5]" style={{ color: DANGER }}>
            {practiceName} · was due {formatDayMonth(dueDate)}
            {cardBrand && cardLast4 ? <> · off your {cardBrand} ···· {cardLast4}</> : null}
          </p>
          <Link
            href={planId ? `/patient/orders/${planId}` : '/patient/orders'}
            className="bn-btn-navy text-center text-[14.5px] font-semibold text-white rounded-tile py-[15px] tabular-nums"
          >
            Pay {formatRand(amount)} now
          </Link>
        </div>

        {/* What happens now */}
        <div
          className="bn-up-2 rounded-card bg-white p-[18px] flex flex-col gap-[14px]"
          style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
        >
          <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>
            What happens now
          </p>
          <StepRow n={1}>
            {retryDate
              ? <>We&rsquo;ll try {cardLabel} again on <b>{formatDayMonth(retryDate)}</b>.</>
              : <>This payment is overdue and no more automatic retries are scheduled — please settle it above.</>}
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
          className="bn-up-3 rounded-card bg-white overflow-hidden"
          style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
        >
          {altCard && (
            <Link href="/patient/account" className="bn-row-hover flex items-center justify-between gap-3 p-[16px]">
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
            className="bn-row-hover flex items-center justify-between gap-3 p-[16px]"
            style={altCard ? { borderTop: '1px solid var(--portal-hairline)' } : undefined}
          >
            <div className="min-w-0">
              <p className="text-[14px] font-semibold" style={{ color: 'var(--portal-ink)' }}>Can&rsquo;t pay right now?</p>
              <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--portal-muted)' }}>Talk to us — we&rsquo;ll work something out</p>
            </div>
            <Chevron />
          </a>
        </div>

      </div>
    </PatientScreen>
  );
}
