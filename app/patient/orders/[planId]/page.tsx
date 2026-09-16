import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '@/app/patient/PatientScreen';
import InstalmentLadder, { ladderFromCounts } from '@/app/patient/InstalmentLadder';
import PlanSettleAffordance from '../PlanSettleAffordance';
import DeclinedPlanDetail from '../DeclinedPlanDetail';
import PlanReceiptSheet from './PlanReceiptSheet';
import { selfSettleInstalment, selfSettleEntirePlan } from '../settle-actions';
import { computePlanProgress } from '@/lib/planProgress';
import { isDeclinedPlan } from '@/lib/patient/planBucket';
import {
  deriveInstalmentStatus,
  type InstalmentStatus,
} from '@/lib/patient/instalmentStatus';
import CollectionStatusBadge, { type CollectionBucket } from '@/app/admin/_components/CollectionStatusBadge';
import { cardBrandLabel } from '@/lib/patient/cardBrand';
import { formatRand, formatDate, todaySAST } from '@/app/patient/_format';
import { getRequestUser } from '@/lib/auth/requestUser';

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

// ─── Schedule badge ─────────────────────────────────────────────────
//
// The schedule rows used to carry a fourth badge palette of their own
// (a local BADGE_STYLE map), which is how the app came to describe the
// same instalment as "Overdue" in three slightly different reds. The row
// state is still DERIVED here — deriveInstalmentStatus against today, never
// the raw stored status, so a `scheduled` row whose due date has passed
// reads Overdue rather than Upcoming — and that derived verdict is then
// mapped onto the shared CollectionStatusBadge buckets. One vocabulary:
// what the patient reads on this row is what an agent reads on the same
// row in the admin collections list.
/** The v5 card surface — one shadow and one border across the portal. */
const CARD_SHADOW = '0 2px 8px -3px rgba(15,31,58,.09)';
const CARD_BORDER = '1px solid rgba(19,41,75,.06)';
const DANGER      = '#B42318';
const DANGER_WASH = 'rgba(180,35,24,.10)';

const BUCKET_FOR: Record<InstalmentStatus, CollectionBucket> = {
  paid:        'collected',
  processing:  'processing',
  due_today:   'upcoming',
  upcoming:    'upcoming',
  overdue:     'overdue',
  written_off: 'written_off',
};

export default async function PlanDetailPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const supabase = await createClient();

  const user = await getRequestUser();
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
      .select('card_brand, last_four, is_default, token')
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

  const cards       = (rawCards ?? []) as { card_brand: string | null; last_four: string | null; is_default: boolean | null; token: string | null }[];
  // Show the card THIS plan actually collects from (its own bound
  // peach_registration_id) — not the account default, which now applies to
  // NEW plans only and may differ. Fall back to the default only when the
  // plan's card can't be resolved (legacy/orphaned token).
  const boundCard   = rawPlan.peach_registration_id
    ? cards.find((c) => c.token === rawPlan.peach_registration_id) ?? null
    : null;
  const chargeCard  = boundCard ?? cards.find((c) => c.is_default) ?? cards[0] ?? null;

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

  const cardLabel = chargeCard?.last_four
    ? `Off ${cardBrandLabel(chargeCard.card_brand)} ···· ${chargeCard.last_four}`
    : 'No card on file';

  const header = (
    <>
      <Link
        href="/patient/orders"
        aria-label="Back to plans"
        className="flex-none w-9 h-9 rounded-full flex items-center justify-center"
        style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.14)' }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#fff" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m15 6-6 6 6 6" />
        </svg>
      </Link>

      {/* The practice becomes the EYEBROW and the amount becomes the
          headline. v4 had it the other way round — a 15.5px practice name
          beside the back button, then a "Left to pay" label over the
          figure. But "left to pay" is what this screen is; naming it costs
          a line to say nothing, while the practice is the one fact that
          tells the patient WHICH plan they opened. */}
      <p className="mt-5 text-[11px] font-semibold uppercase truncate" style={{ letterSpacing: '.18em', color: 'rgba(255,255,255,.5)' }}>
        {practiceName}
      </p>
      <p className="mt-2.5 font-bold tabular-nums text-white" style={{ fontSize: 44, lineHeight: 1, letterSpacing: '-.045em' }}>
        {remInt}<span style={{ fontSize: 26, color: 'rgba(255,255,255,.5)' }}>.{remDec}</span>
      </p>
      <p className="mt-[9px] text-[13px] tabular-nums" style={{ color: 'rgba(255,255,255,.6)' }}>
        left of {formatRand(Number(rawPlan.total_amount))} · {prog.paidCount} of {total} paid
      </p>
      <div className="mt-5">
        <InstalmentLadder tone="dark" segments={ladderFromCounts(total, prog.paidCount)} />
      </div>
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* ── Schedule ─────────────────────────────────────────────────
            One row per instalment: a numbered tile, the amount, when it
            went (or goes) off the card, and its state. The collection card
            moved into this card's HEADER — it is a fact ABOUT the schedule
            ("all of these come off this card"), so repeating it as its own
            row below was a second card-shaped object saying the same thing
            the header now says in five words. */}
        <div
          className="bn-up rounded-card bg-white overflow-hidden"
          style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
        >
          <div className="flex items-center justify-between gap-3 px-[18px] pt-[16px] pb-[13px]">
            <span className="text-[14.5px] font-semibold" style={{ color: 'var(--portal-ink)' }}>Schedule</span>
            <span className="text-[12px] tabular-nums" style={{ color: 'var(--portal-faint)' }}>{cardLabel}</span>
          </div>
          {payments.length === 0 ? (
            <p className="px-[18px] pb-[16px] text-[13px]" style={{ color: 'var(--portal-muted)' }}>No schedule yet.</p>
          ) : payments.map((p) => {
            const derived   = deriveInstalmentStatus(p, today);
            const collected = derived === 'paid';
            const overdue   = derived === 'overdue';
            const effDate   = p.next_attempt_date ?? p.due_date;
            // One line, every row: "Collected 17 Jun 2026" / "Due 24 Aug
            // 2026" / "Was due 25 Jul 2026" — never a second wrapped line,
            // which is what made the overdue row taller than its neighbours.
            const rowDate   = collected
              ? `Collected ${formatDate((p.collected_at ?? p.due_date).slice(0, 10))}`
              : `${overdue ? 'Was due' : 'Due'} ${formatDate(effDate)}`;
            return (
              <div
                key={p.id}
                className="flex items-center gap-[13px] px-[18px] py-[14px]"
                style={{ borderTop: '1px solid var(--portal-hairline)' }}
              >
                {/* The instalment's NUMBER, not a tick or an empty ring.
                    The rows are a sequence — "2 of 3" is the thing a
                    patient is orienting by — and the badge on the right
                    already carries the state, so a status glyph on the
                    left was saying it twice. */}
                <span
                  className="flex-none w-[30px] h-[30px] rounded-[10px] flex items-center justify-center text-[12.5px] font-semibold"
                  style={overdue
                    ? { background: DANGER_WASH, color: DANGER }
                    : { background: 'rgba(19,41,75,.05)', color: 'var(--portal-ink)' }}
                  aria-hidden
                >
                  {p.instalment_number}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-semibold tabular-nums" style={{ color: 'var(--portal-ink)' }}>
                    {formatRand(Number(p.amount))}
                  </p>
                  <p className="mt-[3px] text-[12px] truncate" style={{ color: overdue ? DANGER : 'var(--portal-faint)' }}>
                    {rowDate}
                  </p>
                </div>
                <span className="flex-none"><CollectionStatusBadge bucket={BUCKET_FOR[derived]} /></span>
              </div>
            );
          })}
        </div>

        {/* Receipt */}
        <div
          className="bn-up-2 rounded-card bg-white overflow-hidden"
          style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
        >
          <PlanReceiptSheet
            practiceName={practiceName}
            amount={Number(rawPlan.total_amount)}
            isPaidInFull={prog.isPaidInFull}
            createdDate={(rawPlan.created_at as string).slice(0, 10)}
            invoiceNumber={(rawPlan.invoice_number as string | null) ?? null}
            practiceReference={(rawPlan.practice_reference as string | null) ?? null}
          />
        </div>

        {/* ── The terms, then the actions ──────────────────────────────
            The fine print sits WITH the pay buttons rather than at the
            bottom of the screen, because "late fees can apply" is
            something to know before you decide how to settle, not
            afterwards. We say interest-free (true) and we say late fees
            can apply (also true) — never "no fees", which the dunning
            ladder makes false. */}
        {isActive && nextOut && (
          <div
            className="bn-up-3 rounded-card bg-white p-[18px]"
            style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
          >
            <p className="text-[13px] leading-[1.6]" style={{ color: 'var(--portal-muted)' }}>
              Interest-free. Late fees can apply if a collection fails — we retry once before the plan is escalated.
            </p>
            <div className="mt-[14px] flex items-center gap-[9px]">
              <div className="flex-1 min-w-0">
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
              <a
                href="/contact"
                className="bn-btn-wash flex-none text-[14.5px] font-semibold rounded-tile px-[18px] py-[15px]"
                style={{ color: '#2C3E5C' }}
              >
                Get help
              </a>
            </div>
          </div>
        )}

        {refSegments.length > 0 && (
          <p className="text-center text-[11.5px]" style={{ color: 'var(--portal-muted)' }}>{refSegments.join(' · ')}</p>
        )}

        {/* Pay actions (active plans only). */}
        {isActive && nextOut && (
          <div
            className="rounded-card bg-white px-[18px] py-[16px]"
            style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
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
