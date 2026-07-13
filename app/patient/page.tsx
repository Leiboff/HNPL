import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { InstalmentRow } from './InstalmentBreakdownModal';
import ApprovedBalanceCard from './ApprovedBalanceCard';
import FindCareBar from './FindCareBar';
import MergedPlansCard, { type MergedPlanRow, type MergedHeadline } from './MergedPlansCard';
import { availableBalance, type PaymentForBalance } from '@/lib/patient/approvedBalance';
import { computePlanProgress } from '@/lib/planProgress';

// ─── Patient home dashboard ──────────────────────────────────────────────
//
// Post-0065 rebuild:
//   • Approved balance (widget, renders only when limit is non-null).
//   • Hero — next instalment / bill-to-review / all-paid-up (existing
//     lifecycle logic; restyled into the new dashboard order).
//   • Active plans count (tappable → /patient/orders).
//   • Find-care bar — search-shaped LINK to /patient/explore.
//
// Removed from the dashboard in this build:
//   • The Salary date card. Salary day is now a profile-only field
//     (see /patient/profile). Checkout reads it server-side.
//   • The PasskeySetupCard nudge. The post-login passkey prompt now
//     lives in the layout as a full-sheet overlay, frequency-capped.
//
// The approved-balance widget respects the "real data only" rule: it
// renders nothing when the patient has no limit set. No placeholder
// like "R0 available" is ever shown.

function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

// Matches the defensive pattern in OrdersView — Supabase may return the
// embedded relation as an object or a single-element array.
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
  /** Full instalment set embedded so we can compute per-plan progress
   *  ("X of Y paid") inline. Matches the shape used by the orders page —
   *  the breakdown view is the source of truth for this shape. */
  payments:     Array<{
    amount:  number | string;
    status:  string;
    kind:    string | null;
  }> | null;
};

// Embedded plan data on each payment row (many payments → one plan via plan_id FK).
type PaymentPlanEmbed = {
  id:        string;
  plan_type: number | null;
  practice:  PracticeEmbed;
} | null;

type UpcomingPayment = {
  id:                  string;
  amount:              number;
  due_date:            string;
  status:              string;
  instalment_number:   number;
  dunning_fees_cents:  number | null;
  next_attempt_date:   string | null;
  plan_id:             string | null;
  // Supabase returns many-to-one embeds as an object; union to guard
  // against the rare case where it arrives as a single-element array.
  plan: PaymentPlanEmbed | PaymentPlanEmbed[];
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PatientDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: rawPlans }, { data: rawPayments }] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('first_name, approved_credit_limit')
        .eq('id', user.id)
        .single(),
      // No profiles embed here — plans has two FKs to profiles (patient +
      // provider) which causes an ambiguous relationship error. Only embed
      // practices(name). Payments embed matches the orders page shape so
      // computePlanProgress can render per-plan "X of Y paid" chips on
      // the home dashboard without a second round trip.
      supabase
        .from('plans')
        .select('id, status, total_amount, plan_type, practice:practices(name), payments(amount, status, kind)')
        .eq('patient_id', user.id),
      // All unsettled instalments — soonest-first by *effective* date.
      supabase
        .from('payments')
        .select(`
          id, amount, due_date, status, instalment_number,
          dunning_fees_cents, next_attempt_date, plan_id,
          plan:plans!payments_plan_id_fkey(
            id, plan_type, practice:practices(name)
          )
        `)
        .eq('patient_id', user.id)
        .eq('kind', 'instalment')
        .in('status', ['scheduled', 'processing', 'failed', 'defaulted'])
        .order('due_date', { ascending: true }),
    ]);

  const allPlans   = (rawPlans   ?? []) as unknown as PlanSummary[];
  const payments   = (rawPayments ?? []) as unknown as UpcomingPayment[];

  const totalCount   = allPlans.length;
  const pendingPlans = allPlans.filter((p) => p.status === 'pending_acceptance');
  const pendingCount = pendingPlans.length;
  const currentCount = allPlans.filter((p) => p.status === 'active').length;

  // Approved balance — computed server-side from the raw payment set.
  // Filter to payments that belong to ACTIVE plans (a defaulted /
  // completed plan's balance is not the patient's forward-looking
  // spending capacity). NULL limit → the card component renders null;
  // we still pass a safe zero as `available` for typing.
  const approvedLimit: number | null =
    (profile?.approved_credit_limit as number | null) ?? null;
  const activePlanIds = new Set(
    allPlans.filter((p) => p.status === 'active').map((p) => p.id),
  );
  const paymentsForBalance: PaymentForBalance[] = payments
    .filter((p) => p.plan_id != null && activePlanIds.has(p.plan_id as string))
    .map((p) => ({ amount: Number(p.amount), status: p.status }));
  const available = approvedLimit != null
    ? availableBalance(approvedLimit, paymentsForBalance)
    : 0;

  // Today in SA time — YYYY-MM-DD string compared directly against
  // due_date (also YYYY-MM-DD from the DB). String comparison is
  // timezone-safe.
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

  // ── Per-plan next-instalment lookup ───────────────────────────────
  //
  // For the merged card each active plan needs its OWN next unpaid
  // instalment (any date), not just the aggregated headline group.
  // Group the already-fetched payments by plan_id, pick the earliest
  // effective date per plan. No new query.
  const effectiveDate = (p: UpcomingPayment): string => p.next_attempt_date ?? p.due_date;
  const nextByPlan = new Map<string, { amount: number; date: string }>();
  for (const p of payments) {
    if (!p.plan_id) continue;
    const eff = effectiveDate(p);
    const existing = nextByPlan.get(p.plan_id);
    if (!existing || eff < existing.date) {
      nextByPlan.set(p.plan_id, {
        amount: Number(p.amount) + Number(p.dunning_fees_cents ?? 0) / 100,
        date:   eff,
      });
    }
  }

  // ── Merged-card rows: one per ACTIVE plan ────────────────────────
  //
  // Combines progress data (paid/total/percent from the embedded
  // payments) with the plan's next unpaid instalment amount + date.
  // Sorted least-paid-first so the plan most in-progress sits on top.
  const planRows: MergedPlanRow[] = allPlans
    .filter((p) => p.status === 'active')
    .map((p) => {
      const prog = computePlanProgress({
        status:   p.status,
        payments: (p.payments ?? []).map((pmt) => ({
          amount: pmt.amount,
          status: pmt.status,
          kind:   pmt.kind ?? undefined,
        })),
      });
      const nxt = nextByPlan.get(p.id);
      return {
        id:            p.id,
        practiceName:  getPracticeName(p.practice),
        paid:          prog.paidCount,
        total:         prog.totalPayments || (p.plan_type ?? 0),
        percent:       prog.percent,
        isPaidInFull:  prog.isPaidInFull,
        nextAmount:    nxt?.amount ?? null,
        nextDate:      nxt?.date   ?? null,
      };
    })
    .sort((a, b) => a.percent - b.percent);

  // ── Bill-to-review — highest-priority tile, ALWAYS surfaced first ─────
  //
  // Lifted OUT of the "hero" position (post-plans) into a slot directly
  // under the search bar so the patient sees a bill needing action as
  // their first tile after greeting/search. Amber accent unchanged.
  // When no bill is pending, billReview stays null and the layout is
  // identical to the pre-reorder state.
  let billReview: React.ReactNode = null;
  if (pendingCount > 0) {
    if (pendingCount === 1) {
      const plan         = pendingPlans[0];
      const practiceName = getPracticeName(plan.practice);
      billReview = (
        <div
          className="bg-white rounded-3xl shadow-sm p-5 sm:p-6 border border-amber-200"
          data-testid="bill-to-review-card"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-600">
            Bill to Review
          </p>
          <p
            className="mt-3 text-4xl sm:text-5xl font-bold tabular-nums"
            style={{ color: '#13294B' }}
          >
            {formatRand(Number(plan.total_amount))}
          </p>
          <p className="mt-2 text-sm text-gray-500">from {practiceName}</p>
          <Link
            href={`/patient/orders/${plan.id}/confirm`}
            className="mt-4 inline-flex items-center justify-center rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            Review &amp; accept →
          </Link>
        </div>
      );
    } else {
      billReview = (
        <div
          className="bg-white rounded-3xl shadow-sm p-5 sm:p-6 border border-amber-200"
          data-testid="bill-to-review-card"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-600">
            Bills to Review
          </p>
          <p
            className="mt-3 text-2xl font-bold"
            style={{ color: '#13294B' }}
          >
            {pendingCount} bills awaiting your approval
          </p>
          <Link
            href="/patient/orders"
            className="mt-4 inline-flex items-center justify-center rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            Review →
          </Link>
        </div>
      );
    }
  }

  // ── Headline data for the merged card ────────────────────────────
  //
  // Same aggregation as the old InstalmentHero: sum of the instalments
  // due on the SOONEST effective date, plus a group-state label that
  // dominates in defaulted > failed > scheduled order. The card's
  // headline zone opens the SAME InstalmentBreakdownModal — nothing
  // downstream changed.
  //
  // Set to null when there are no upcoming instalments at all — the
  // merged card renders the plan rows without a headline zone in
  // that case (no misleading "all paid up" tile alongside a pending
  // bill or a fresh active plan without a schedule yet).
  let mergedHeadline: MergedHeadline | null = null;

  if (payments.length > 0) {
    const sorted     = [...payments].sort((a, b) => effectiveDate(a).localeCompare(effectiveDate(b)));
    const soonestKey = effectiveDate(sorted[0]);
    const dueGroup   = sorted.filter((p) => effectiveDate(p) === soonestKey);

    const total = dueGroup.reduce(
      (sum, p) => sum + Number(p.amount) + Number(p.dunning_fees_cents ?? 0) / 100,
      0,
    );

    const isOverdue = soonestKey < todayStr;
    const isToday   = soonestKey === todayStr;

    const groupState: 'defaulted' | 'failed' | 'scheduled' =
      dueGroup.some((p) => p.status === 'defaulted') ? 'defaulted' :
      dueGroup.some((p) => p.status === 'failed')    ? 'failed'    :
                                                       'scheduled';

    const instalments: InstalmentRow[] = dueGroup.map((p) => {
      const planData = Array.isArray(p.plan) ? (p.plan[0] ?? null) : p.plan;
      return {
        practiceName:     getPracticeName(planData?.practice ?? null),
        instalmentNumber: p.instalment_number,
        planType:         planData?.plan_type ?? null,
        amount:           Number(p.amount),
        dunningFeesCents: Number(p.dunning_fees_cents ?? 0),
        status:           p.status,
      };
    });

    mergedHeadline = {
      dueDate: soonestKey,
      total,
      isOverdue,
      isToday,
      groupState,
      instalments,
    };
  }

  return (
    <div className="bg-[#f7fbfb] min-h-full">
      <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8 space-y-4">

        <p className="text-lg font-semibold" style={{ color: '#13294B' }}>
          Hi, {profile?.first_name ?? user.email?.split('@')[0] ?? 'there'} 👋
        </p>

        {/* Find-care search bar (LINK to explore). Placed directly under
            the greeting so it's the first tap-target the patient sees. */}
        <FindCareBar />

        {/* Bill-to-review — highest-priority tile when a bill is
            pending. Lifted OUT of the hero slot (post-plans) so a
            patient with a bill to accept sees it immediately, above
            the balance/plans tiles. Renders null when no bill pends;
            in that case the layout is unchanged from the pre-reorder
            state. */}
        {billReview}

        {/* Approved balance — renders ONLY when limit is set. Null →
            null render, no placeholder, no "R0 available". */}
        <ApprovedBalanceCard limit={approvedLimit} available={available} />

        {/* Merged Next Instalment + Your Plans card. Headline zone at
            top (opens breakdown modal, unchanged), divider, then one
            row per ACTIVE plan (practice name, progress bar + "X of Y
            paid", that plan's next instalment amount right-aligned).
            Replaces both the standalone InstalmentHero and YourPlansCard
            — each practice now appears exactly ONCE on the home page. */}
        <MergedPlansCard
          headline={mergedHeadline}
          activeCount={currentCount}
          totalCount={totalCount}
          rows={planRows}
        />

        {/* NOTE: The "Turn on notifications" soft-ask card lived at the
            tail of the home feed pre-2026-07-13. It now lives in the
            header bell's Action Centre so persistent tasks never
            crowd the home flow. */}

      </div>
    </div>
  );
}
