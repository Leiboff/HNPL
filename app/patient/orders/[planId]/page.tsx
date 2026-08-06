import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '@/app/patient/PatientScreen';
import InstalmentLadder, { ladderFromCounts } from '@/app/patient/InstalmentLadder';
import PlanSettleAffordance from '../PlanSettleAffordance';
import DeclinedPlanDetail from '../DeclinedPlanDetail';
import { selfSettleInstalment, selfSettleEntirePlan } from '../settle-actions';
import { computePlanProgress } from '@/lib/planProgress';
import { isDeclinedPlan } from '@/lib/patient/planBucket';
import {
  deriveInstalmentStatus,
  instalmentStatusLabel,
  type InstalmentStatus,
} from '@/lib/patient/instalmentStatus';
import { cardBrandLabel } from '@/lib/patient/cardBrand';
import { formatRand, formatDate, relativeDay, todaySAST } from '@/app/patient/_format';

// ─── Plan detail (v4 screen 03) ──────────────────────────────────────────
//
// The instalment-breakdown modal becomes a real, linkable, back-navigable
// screen: a navy hero carrying "left to pay" + the mint ladder, a schedule
// read as a timeline (paid / next / to-come), the card that will be
// charged, a dispute route, and a fixed footer holding the two pay actions
// (PlanSettleAffordance — the same money-path affordance used before, so
// its behaviour + test are unchanged).

type PaymentRow = {
  id: string;
  instalment_number: number;
  amount: number;
  due_date: string;
  status: string;
  collected_at: string | null;
  dunning_fees_cents: number | null;
  next_attempt_date: string | null;
  kind: string;
};

// Badge palette keyed off the DERIVED status (never the raw stored one),
// so a scheduled row whose due date has passed reads "Overdue", not
// "Upcoming".
const BADGE_STYLE: Record<InstalmentStatus, { bg: string; fg: string }> = {
  paid:        { bg: '#E7F6EC', fg: '#1E7A45' },
  processing:  { bg: '#EAF1FB', fg: '#2B5FA8' },
  due_today:   { bg: '#EAF1FB', fg: '#2B5FA8' },
  upcoming:    { bg: '#EAF1FB', fg: '#2B5FA8' },
  overdue:     { bg: '#FCEAEA', fg: '#B42318' },
  written_off: { bg: '#F1F5F6', fg: '#64748B' },
};

function ScheduleBadge({ derived }: { derived: InstalmentStatus }) {
  const cfg = BADGE_STYLE[derived];
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: cfg.bg, color: cfg.fg }}>
      {instalmentStatusLabel(derived)}
    </span>
  );
}

export default async function PlanDetailPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: rawPlan }, { data: rawCards }] = await Promise.all([
    supabase
      .from('plans')
      .select(`
        id, total_amount, plan_type, status, invoice_number, practice_reference,
        created_at, peach_registration_id, practice:practices(name),
        payments(id, instalment_number, amount, due_date, status, collected_at, dunning_fees_cents, next_attempt_date, kind)
      `)
      .eq('id', planId)
      .eq('patient_id', user.id)
      .maybeSingle(),
    supabase
      .from('payment_methods')
      .select('card_brand, last_four, is_default')
      .eq('patient_id', user.id)
      .order('is_default', { ascending: false }),
  ]);

  if (!rawPlan) redirect('/patient/orders');

  // A bill still awaiting acceptance (or an abandoned first charge) belongs
  // in the accept/resume flow, not the read-only detail screen.
  if (rawPlan.status === 'pending_acceptance') redirect(`/patient/orders/${planId}/confirm`);
  if (rawPlan.status === 'pending_first_payment' && !rawPlan.peach_registration_id) {
    redirect(`/patient/orders/${planId}/confirm`);
  }

  const practicesRaw = rawPlan.practice as { name: string } | { name: string }[] | null;
  const practiceName = !practicesRaw
    ? 'Unknown Practice'
    : Array.isArray(practicesRaw) ? (practicesRaw[0]?.name ?? 'Unknown Practice') : practicesRaw.name;

  // A declined bill never became a plan — no schedule, no card, no receipt.
  // Render the minimal "what happened" view, not the active-plan template.
  if (isDeclinedPlan(rawPlan.status as string)) {
    return (
      <DeclinedPlanDetail
        practiceName={practiceName}
        amount={Number(rawPlan.total_amount)}
        invoiceNumber={(rawPlan.invoice_number as string | null) ?? null}
        practiceReference={(rawPlan.practice_reference as string | null) ?? null}
      />
    );
  }

  const payments = ((rawPlan.payments ?? []) as PaymentRow[])
    .filter((p) => p.kind !== 'settlement')
    .sort((a, b) => a.instalment_number - b.instalment_number);

  const prog  = computePlanProgress({ status: rawPlan.status, payments });
  const total = prog.totalPayments || (rawPlan.plan_type ?? payments.length);

  const cards       = (rawCards ?? []) as { card_brand: string | null; last_four: string | null; is_default: boolean | null }[];
  const chargeCard  = cards.find((c) => c.is_default) ?? cards[0] ?? null;

  const nextDueNumber = payments.find((p) => p.status !== 'collected' && p.status !== 'written_off')?.instalment_number ?? null;
  const today = todaySAST();

  // Outstanding set for the settle affordance (active plans only).
  const outstanding = payments.filter((p) => p.status === 'scheduled' || p.status === 'failed' || p.status === 'defaulted');
  const outstandingTotalCents = outstanding.reduce(
    (sum, p) => sum + Math.round(Number(p.amount) * 100) + Number(p.dunning_fees_cents ?? 0), 0,
  );
  const nextOut = outstanding[0] ?? null;
  const isActive = rawPlan.status === 'active';

  const refSegments: string[] = [];
  if (rawPlan.invoice_number)     refSegments.push(`Ref ${rawPlan.invoice_number}`);
  if (rawPlan.practice_reference) refSegments.push(`Practice ref ${rawPlan.practice_reference}`);

  const [remInt, remDec] = formatRand(prog.remainingAmount).split('.');

  const header = (
    <>
      <div className="flex items-center gap-3">
        <Link
          href="/patient/orders"
          aria-label="Back to plans"
          className="flex-none w-[38px] h-[38px] rounded-full flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,.12)' }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 6-6 6 6 6" />
          </svg>
        </Link>
        <span className="text-[15.5px] font-semibold text-white truncate">{practiceName}</span>
      </div>

      <div className="mt-[24px]">
        <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.18em', color: 'rgba(255,255,255,.55)' }}>
          Left to pay
        </p>
        <p className="mt-[11px] font-bold tabular-nums text-white" style={{ fontSize: 48, lineHeight: '.94', letterSpacing: '-.045em' }}>
          {remInt}<span style={{ fontSize: 28, color: 'rgba(255,255,255,.55)' }}>.{remDec}</span>
        </p>
        <div className="mt-[18px]">
          <InstalmentLadder tone="dark" segments={ladderFromCounts(total, prog.paidCount)} />
        </div>
        <p className="mt-[10px] text-[13px] tabular-nums" style={{ color: 'rgba(255,255,255,.6)' }}>
          {prog.paidCount} of {total} paid on {formatRand(Number(rawPlan.total_amount))} · interest-free
        </p>
      </div>
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* Schedule timeline */}
        <div
          className="rounded-[22px] bg-white overflow-hidden"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <div className="px-[18px] pt-[15px] pb-[13px] text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>
            Schedule
          </div>
          {payments.length === 0 ? (
            <p className="px-[18px] pb-[16px] text-[13px]" style={{ color: '#8496AA' }}>No schedule yet.</p>
          ) : payments.map((p) => {
            const derived   = deriveInstalmentStatus(p, today);
            const collected = derived === 'paid';
            const overdue   = derived === 'overdue';
            const isNext    = !collected && p.instalment_number === nextDueNumber;
            const effDate   = p.next_attempt_date ?? p.due_date;
            const rowDate   = collected
              ? `Paid ${formatDate((p.collected_at ?? p.due_date).slice(0, 10))}`
              : `${overdue ? 'Was due' : 'Due'} ${formatDate(effDate)}`;
            const emphasise = isNext || overdue;
            const ring      = overdue ? '#B42318' : isNext ? '#15A89E' : '#E2E8EE';
            const dateColor = collected ? '#8496AA' : overdue ? '#B42318' : isNext ? '#13294B' : '#8496AA';
            const amtColor  = emphasise ? '#13294B' : '#8496AA';
            return (
              <div
                key={p.id}
                className="flex items-center gap-3 px-[18px] py-[14px]"
                style={{ borderTop: '1px solid #EEF2F5', background: overdue ? '#FEF6F5' : isNext ? '#F5FCFB' : undefined }}
              >
                {collected ? (
                  <span className="flex-none w-6 h-6 rounded-full flex items-center justify-center" style={{ background: '#F0FDF4' }}>
                    <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="#16A34A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 10.5l3 3 7-7" />
                    </svg>
                  </span>
                ) : (
                  <span className="flex-none w-6 h-6 rounded-full" style={{ border: `2px solid ${ring}` }} />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[14px]" style={{ color: dateColor, fontWeight: emphasise ? 600 : 400 }}>{rowDate}</p>
                  {emphasise && (
                    <p className="mt-0.5 text-[12px]" style={{ color: overdue ? '#B42318' : '#8496AA' }}>{relativeDay(effDate, today)}</p>
                  )}
                </div>
                <ScheduleBadge derived={derived} />
                <span className="text-[14px] tabular-nums" style={{ color: amtColor, fontWeight: emphasise ? 600 : 400 }}>
                  {formatRand(Number(p.amount))}
                </span>
              </div>
            );
          })}
        </div>

        {/* Card + dispute */}
        <div
          className="rounded-[22px] bg-white overflow-hidden"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <div className="flex items-center gap-3 px-[18px] py-[16px]">
            <span className="flex-none w-10 h-7 rounded-[7px] flex items-center justify-center text-[9.5px] font-bold" style={{ background: '#F1F5F6', color: '#41556F', letterSpacing: '.06em' }}>
              {cardBrandLabel(chargeCard?.card_brand)}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-semibold tabular-nums" style={{ color: '#13294B' }}>
                {chargeCard?.last_four ? `···· ${chargeCard.last_four}` : 'No card on file'}
              </p>
              <p className="mt-0.5 text-[12.5px]" style={{ color: '#8496AA' }}>Collected the day after your payday</p>
            </div>
            <Link href="/patient/account" className="flex-none text-[13px] font-semibold" style={{ color: '#0F766E' }}>Change</Link>
          </div>
          <a
            href="mailto:support@betternow.co.za?subject=Question about my bill"
            className="flex items-center justify-between gap-3 px-[18px] py-[16px]"
            style={{ borderTop: '1px solid #EEF2F5' }}
          >
            <span className="text-[14px] font-semibold" style={{ color: '#13294B' }}>Something wrong with this bill?</span>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#B6C1CD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden>
              <path d="m9 6 6 6-6 6" />
            </svg>
          </a>
        </div>

        {refSegments.length > 0 && (
          <p className="text-center text-[11.5px]" style={{ color: '#A8B4C2' }}>{refSegments.join(' · ')}</p>
        )}

        {/* Pay actions (active plans only). */}
        {isActive && nextOut && (
          <div
            className="rounded-[22px] bg-white px-[18px] py-[16px]"
            style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
          >
            <PlanSettleAffordance
              planId={rawPlan.id as string}
              outstandingCount={outstanding.length}
              outstandingTotalCents={outstandingTotalCents}
              nextOutstanding={{
                paymentId:         nextOut.id,
                chargeAmountCents: Math.round(Number(nextOut.amount) * 100) + Number(nextOut.dunning_fees_cents ?? 0),
                instalmentNumber:  nextOut.instalment_number,
              }}
              settleInstalment={selfSettleInstalment}
              settleEntirePlan={selfSettleEntirePlan}
            />
          </div>
        )}

        {prog.isPaidInFull && (
          <p className="text-center text-[13px] font-medium" style={{ color: '#1E7A45' }}>
            This plan is paid in full.
          </p>
        )}

      </div>
    </PatientScreen>
  );
}
