import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from './PatientScreen';
import ActionCentreBell from './ActionCentreBell';
import InstalmentLadder, { ladderFromCounts } from './InstalmentLadder';
import HomeBillCard from './HomeBillCard';
import HomeFailedState from './HomeFailedState';
import DefaultFreezeBanner from './DefaultFreezeBanner';
import PatientWelcomeBanner from './PatientWelcomeBanner';
import { declinePlan } from './actions';
import { availableBalance, type PaymentForBalance } from '@/lib/patient/approvedBalance';
import { isPatientFrozen } from '@/lib/patient/freeze';
import { computePlanProgress } from '@/lib/planProgress';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import { formatRand, formatDate, formatDayMonth, relativeDay, todaySAST } from './_format';

// ─── Patient home dashboard — v4 ──────────────────────────────────────────
//
// v4 puts the brand on the canvas: a navy hero carrying the balance, a
// light sheet lifting over it, and the recurring "ladder" schedule graphic
// on every plan row. Three questions answered above the fold — is anything
// waiting on me, what can I spend, what comes off my card next.
//
// A failed/defaulted instalment flips the whole screen into the
// missed-payment state (HomeFailedState, red header). Every figure on that
// screen is real: the retry date is the row's own next_attempt_date, and
// no "no-fee" guarantee is ever printed (late fees can accrue).
//
// The approved-balance hero respects the "real data only" rule: with no
// limit set, the hero shows the greeting alone — never a placeholder.

type PracticeEmbed = { name: string } | { name: string }[] | null;

function getPracticeName(practice: PracticeEmbed): string {
  if (!practice) return 'your practice';
  if (Array.isArray(practice)) return practice[0]?.name ?? 'your practice';
  return practice.name;
}

type PlanSummary = {
  id:           string;
  status:       string;
  total_amount: number;
  plan_type:    number | null;
  practice:     PracticeEmbed;
  payments:     Array<{ amount: number | string; status: string; kind: string | null }> | null;
};

type PaymentPlanEmbed = { id: string; plan_type: number | null; practice: PracticeEmbed } | null;

type UpcomingPayment = {
  id:                 string;
  amount:             number;
  due_date:           string;
  status:             string;
  instalment_number:  number;
  dunning_fees_cents: number | null;
  next_attempt_date:  string | null;
  plan_id:            string | null;
  plan: PaymentPlanEmbed | PaymentPlanEmbed[];
};

type CardRow = { card_brand: string | null; last_four: string | null; is_default: boolean | null };

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PatientDashboardPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const supabase = await createClient();

  const { welcome } = await searchParams;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [
    { data: profile },
    { data: rawPlans },
    { data: rawPayments },
    isFrozen,
    { data: rawCards },
  ] = await Promise.all([
    supabase.from('profiles').select('first_name, last_name, approved_credit_limit').eq('id', user.id).single(),
    supabase
      .from('plans')
      .select('id, status, total_amount, plan_type, practice:practices(name), payments(amount, status, kind)')
      .eq('patient_id', user.id),
    supabase
      .from('payments')
      .select(`
        id, amount, due_date, status, instalment_number,
        dunning_fees_cents, next_attempt_date, plan_id,
        plan:plans!payments_plan_id_fkey(id, plan_type, practice:practices(name))
      `)
      .eq('patient_id', user.id)
      .eq('kind', 'instalment')
      .in('status', ['scheduled', 'processing', 'failed', 'defaulted'])
      .order('due_date', { ascending: true }),
    isPatientFrozen(supabase, user.id),
    supabase
      .from('payment_methods')
      .select('card_brand, last_four, is_default')
      .eq('patient_id', user.id)
      .order('is_default', { ascending: false }),
  ]);

  const allPlans = (rawPlans ?? []) as unknown as PlanSummary[];
  const payments = (rawPayments ?? []) as unknown as UpcomingPayment[];
  const cards    = (rawCards ?? []) as CardRow[];

  const firstName = (profile?.first_name as string | null) ?? null;
  const lastName  = (profile?.last_name  as string | null) ?? null;
  const greetName = firstName ?? user.email?.split('@')[0] ?? 'there';

  const totalCount   = allPlans.length;
  const pendingPlans = allPlans.filter((p) => p.status === 'pending_acceptance');
  const currentCount = allPlans.filter((p) => p.status === 'active').length;

  // ── Saved cards: default (charged) + one alternate ────────────────
  const defaultCard = cards.find((c) => c.is_default) ?? cards[0] ?? null;
  const altCard     = cards.find((c) => c !== defaultCard) ?? null;
  const cardBrand   = defaultCard?.card_brand ?? null;
  const cardLast4   = defaultCard?.last_four ?? null;

  // ── Approved balance ──────────────────────────────────────────────
  const approvedLimit: number | null = (profile?.approved_credit_limit as number | null) ?? null;
  const activePlanIds = new Set(allPlans.filter((p) => p.status === 'active').map((p) => p.id));
  const paymentsForBalance: PaymentForBalance[] = payments
    .filter((p) => p.plan_id != null && activePlanIds.has(p.plan_id as string))
    .map((p) => ({ amount: Number(p.amount), status: p.status }));
  const available = approvedLimit != null ? availableBalance(approvedLimit, paymentsForBalance) : 0;
  const used = approvedLimit != null ? Math.max(0, approvedLimit - available) : 0;
  const usedPct = approvedLimit && approvedLimit > 0 ? Math.min(100, Math.max(0, (used / approvedLimit) * 100)) : 0;

  const effectiveDate = (p: UpcomingPayment): string => p.next_attempt_date ?? p.due_date;
  const today = todaySAST();

  // ── Per-plan next instalment (no extra query) ─────────────────────
  const nextByPlan = new Map<string, { amount: number; date: string; overdue: boolean }>();
  for (const p of payments) {
    if (!p.plan_id) continue;
    const eff = effectiveDate(p);
    const existing = nextByPlan.get(p.plan_id);
    if (!existing || eff < existing.date) {
      nextByPlan.set(p.plan_id, {
        amount:  Number(p.amount) + Number(p.dunning_fees_cents ?? 0) / 100,
        date:    eff,
        overdue: deriveInstalmentStatus(p, today) === 'overdue',
      });
    }
  }

  // ── Active plan rows (rendered with the ladder) ───────────────────
  const planRows = allPlans
    .filter((p) => p.status === 'active')
    .map((p) => {
      const prog = computePlanProgress({
        status:   p.status,
        payments: (p.payments ?? []).map((pmt) => ({ amount: pmt.amount, status: pmt.status, kind: pmt.kind ?? undefined })),
      });
      const nxt   = nextByPlan.get(p.id);
      const total = prog.totalPayments || (p.plan_type ?? 0);
      return {
        id:           p.id,
        practiceName: getPracticeName(p.practice),
        paid:         prog.paidCount,
        total,
        percent:      prog.percent,
        remaining:    prog.remainingAmount,
        isPaidInFull: prog.isPaidInFull,
        nextAmount:   nxt?.amount ?? null,
        nextDate:     nxt?.date ?? null,
        nextOverdue:  nxt?.overdue ?? false,
      };
    })
    .sort((a, b) => a.percent - b.percent);

  // ── Failed / defaulted → the missed-payment screen ────────────────
  const troubled = payments.filter((p) => p.status === 'failed' || p.status === 'defaulted');
  if (troubled.length > 0) {
    // Most urgent: defaulted before failed, then soonest effective date.
    const urgent = [...troubled].sort((a, b) => {
      const rank = (s: string) => (s === 'defaulted' ? 0 : 1);
      return rank(a.status) - rank(b.status) || effectiveDate(a).localeCompare(effectiveDate(b));
    })[0];
    const planData = Array.isArray(urgent.plan) ? (urgent.plan[0] ?? null) : urgent.plan;
    return (
      <HomeFailedState
        firstName={firstName}
        lastName={lastName}
        amount={Number(urgent.amount) + Number(urgent.dunning_fees_cents ?? 0) / 100}
        practiceName={getPracticeName(planData?.practice ?? null)}
        dueDate={urgent.due_date}
        retryDate={urgent.status === 'failed' ? urgent.next_attempt_date : null}
        feesRand={Number(urgent.dunning_fees_cents ?? 0) / 100}
        cardBrand={cardBrand}
        cardLast4={cardLast4}
        altCard={altCard && altCard.card_brand && altCard.last_four
          ? { brand: altCard.card_brand, last4: altCard.last_four }
          : null}
        planId={urgent.plan_id}
        frozen={isFrozen}
      />
    );
  }

  // ── Soonest scheduled instalment (drives the next-due card) ───────
  const sorted = [...payments].sort((a, b) => effectiveDate(a).localeCompare(effectiveDate(b)));
  const soonest = sorted[0] ?? null;
  const nextPayment = soonest
    ? {
        amount:  Number(soonest.amount) + Number(soonest.dunning_fees_cents ?? 0) / 100,
        date:    effectiveDate(soonest),
        planId:  soonest.plan_id,
        // Derived, not trusted from the stored status: a scheduled row whose
        // due date has passed is overdue and must not read as neutral here.
        overdue: deriveInstalmentStatus(soonest, today) === 'overdue',
      }
    : null;

  const initials = `${(firstName ?? '').charAt(0)}${(lastName ?? '').charAt(0)}`.toUpperCase()
    || greetName.charAt(0).toUpperCase();

  // ── Navy hero header ──────────────────────────────────────────────
  const header = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-[11px]">
          <span
            className="w-[38px] h-[38px] rounded-full flex items-center justify-center text-[13px] font-semibold text-white"
            style={{ background: 'rgba(255,255,255,.12)' }}
          >
            {initials}
          </span>
          <span className="text-[15.5px] font-semibold text-white">Hi {greetName}</span>
        </div>
        <ActionCentreBell onDark />
      </div>

      {approvedLimit != null ? (
        <div className="mt-[26px]">
          <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.18em', color: 'rgba(255,255,255,.55)' }}>
            Available to spend
          </p>
          <p className="mt-[11px] font-bold tabular-nums text-white" style={{ fontSize: 54, lineHeight: '.94', letterSpacing: '-.045em' }}>
            {formatRand(available).split('.')[0]}
            <span style={{ fontSize: 30, letterSpacing: '-.03em', color: 'rgba(255,255,255,.55)' }}>
              .{formatRand(available).split('.')[1]}
            </span>
          </p>
          <div className="mt-[18px] h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.14)' }}>
            <div className="h-full rounded-full" style={{ width: `${usedPct}%`, background: 'linear-gradient(90deg,#5CD9CE,#15A89E)' }} />
          </div>
          <p className="mt-[10px] text-[13px] tabular-nums" style={{ color: 'rgba(255,255,255,.6)' }}>
            {formatRand(used)} in use · {formatRand(approvedLimit)} limit
          </p>
        </div>
      ) : (
        <p className="mt-[22px] text-[14px]" style={{ color: 'rgba(255,255,255,.7)' }}>
          Welcome back — find care and pay for it over time.
        </p>
      )}
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {welcome === '1' && <PatientWelcomeBanner firstName={firstName} />}

        {/* Default-freeze notice (also drives the failed-state branch above). */}
        <DefaultFreezeBanner frozen={isFrozen} />

        {/* Waiting on you — a pending bill needing a decision, first. */}
        {pendingPlans.map((p) => (
          <HomeBillCard
            key={p.id}
            planId={p.id}
            practiceName={getPracticeName(p.practice)}
            total={Number(p.total_amount)}
            planType={p.plan_type}
            declinePlan={declinePlan}
          />
        ))}

        {/* Next payment — the soonest instalment coming off the card. */}
        {nextPayment && (
          <div
            className="rounded-[22px] bg-white p-[18px] flex flex-col gap-[16px]"
            style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.16em', color: nextPayment.overdue ? '#B42318' : 'rgba(19,41,75,.5)' }}>
                  {nextPayment.overdue ? 'Payment overdue' : 'Next payment'}
                </p>
                <p className="mt-[9px] text-[34px] font-bold tabular-nums leading-none" style={{ color: '#13294B', letterSpacing: '-.04em' }}>
                  {formatRand(nextPayment.amount)}
                </p>
              </div>
              <span
                className="flex-none text-[12px] font-semibold rounded-full px-3 py-2"
                style={nextPayment.overdue
                  ? { background: 'rgba(180,35,24,.1)', color: '#B42318' }
                  : { background: 'rgba(21,168,158,.13)', color: '#0F766E' }}
              >
                {nextPayment.overdue ? 'Overdue' : relativeDay(nextPayment.date, today)}
              </span>
            </div>
            <p className="text-[13.5px]" style={{ color: nextPayment.overdue ? '#B42318' : '#8496AA' }}>
              {nextPayment.overdue
                ? <>Was due {formatDayMonth(nextPayment.date)} · {relativeDay(nextPayment.date, today)}</>
                : formatDayMonth(nextPayment.date)}
              {cardBrand && cardLast4 ? <> · off your {cardBrand} ···· {cardLast4}</> : null}
            </p>
            <Link
              href={nextPayment.planId ? `/patient/orders/${nextPayment.planId}` : '/patient/orders'}
              className="text-center text-[14.5px] font-semibold text-white rounded-[14px] py-[14px]"
              style={{ background: '#0B1F3A' }}
            >
              View &amp; pay
            </Link>
          </div>
        )}

        {/* Your plans — one row per active plan, ladder + next line. */}
        {planRows.length > 0 && (
          <div
            className="rounded-[22px] bg-white overflow-hidden"
            style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
          >
            <div className="flex items-center justify-between gap-3 px-[18px] pt-[16px] pb-[14px]">
              <span className="text-[14.5px] font-semibold" style={{ color: '#13294B' }}>Your plans</span>
              <Link href="/patient/orders" className="text-[13px] font-semibold" style={{ color: '#0F766E' }}>See all</Link>
            </div>
            {planRows.map((r) => (
              <Link
                key={r.id}
                href={`/patient/orders/${r.id}`}
                className="block px-[18px] py-[15px] hover:bg-gray-50 transition-colors"
                style={{ borderTop: '1px solid #EEF2F5' }}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[14.5px] font-semibold truncate min-w-0" style={{ color: '#13294B' }}>{r.practiceName}</span>
                  <span className="text-[14.5px] font-semibold tabular-nums shrink-0" style={{ color: '#13294B' }}>
                    {formatRand(r.remaining)} left
                  </span>
                </div>
                <div className="mt-[11px]">
                  <InstalmentLadder segments={ladderFromCounts(r.total, r.paid)} />
                </div>
                <p className="mt-[11px] text-[12.5px] tabular-nums" style={{ color: r.nextOverdue ? '#B42318' : '#8496AA' }}>
                  {r.isPaidInFull ? 'Paid in full' : `${r.paid} of ${r.total} paid`}
                  {r.nextAmount != null && r.nextDate
                    ? r.nextOverdue
                      ? ` · ${formatRand(r.nextAmount)} overdue since ${formatDayMonth(r.nextDate)}`
                      : ` · ${formatRand(r.nextAmount)} on ${formatDayMonth(r.nextDate)}`
                    : ''}
                </p>
              </Link>
            ))}
          </div>
        )}

        {/* Empty state — no plans yet. */}
        {planRows.length === 0 && pendingPlans.length === 0 && (
          <div
            className="rounded-[22px] bg-white p-[18px] text-center"
            style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
          >
            <p className="text-[14px]" style={{ color: '#41556F' }}>
              {totalCount === 0 ? 'No payment plans yet.' : 'Nothing outstanding right now.'}
            </p>
          </div>
        )}

        {/* Find care row. */}
        <Link
          href="/patient/explore"
          className="rounded-[22px] bg-white p-[17px] flex items-center gap-[14px]"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <div className="flex-1 min-w-0">
            <p className="text-[14.5px] font-semibold" style={{ color: '#13294B' }}>Find care near you</p>
            <p className="mt-1 text-[12.5px]" style={{ color: '#8496AA' }}>Dentists, physios and optometrists near you</p>
          </div>
          <span
            className="flex-none w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(21,168,158,.12)', color: '#0F766E' }}
            aria-hidden
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25">
              <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </Link>

      </div>
    </PatientScreen>
  );
}
