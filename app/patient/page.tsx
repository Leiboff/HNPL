import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import InstalmentHero, { type InstalmentRow } from './InstalmentHero';
import ApprovedBalanceCard from './ApprovedBalanceCard';
import FindCareBar from './FindCareBar';
import PushSoftAsk from '@/app/_pwa/PushSoftAsk';
import { availableBalance, type PaymentForBalance } from '@/lib/patient/approvedBalance';

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
  practice:     PracticeEmbed;
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

// ─── Shared card class (applied to every block for consistency) ───────────────
const card = 'bg-white rounded-2xl shadow-sm border border-[rgba(19,41,75,.08)] p-5 sm:p-6';

// Card label: small uppercase navy, used as the title in every card.
function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-xs font-semibold uppercase tracking-widest"
      style={{ color: '#13294B', opacity: 0.6 }}
    >
      {children}
    </p>
  );
}

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
      // practices(name).
      supabase
        .from('plans')
        .select('id, status, total_amount, practice:practices(name)')
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

  // ── Hero: priority A > B > C ───────────────────────────────────────────────
  // A: pending bill(s) need action (amber accent, highest priority)
  // B: upcoming instalments — sum all due on the soonest date, tappable modal
  // C: nothing due — all paid up
  let hero: React.ReactNode;

  if (pendingCount > 0) {
    if (pendingCount === 1) {
      const plan         = pendingPlans[0];
      const practiceName = getPracticeName(plan.practice);
      hero = (
        <div className="bg-white rounded-3xl shadow-sm p-5 sm:p-6 border border-amber-200">
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
      hero = (
        <div className="bg-white rounded-3xl shadow-sm p-5 sm:p-6 border border-amber-200">
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
  } else if (payments.length > 0) {
    const effectiveDate = (p: UpcomingPayment): string =>
      p.next_attempt_date ?? p.due_date;

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

    hero = (
      <InstalmentHero
        dueDate={soonestKey}
        total={total}
        isOverdue={isOverdue}
        isToday={isToday}
        groupState={groupState}
        instalments={instalments}
      />
    );
  } else {
    hero = (
      <div className="bg-white rounded-3xl shadow-sm border border-[rgba(19,41,75,.08)] p-5 sm:p-6">
        <CardLabel>Payments</CardLabel>
        <p
          className="mt-3 text-2xl font-semibold"
          style={{ color: '#13294B' }}
        >
          You&apos;re all paid up
        </p>
        <p className="mt-2 text-sm text-gray-400">
          No instalments due right now.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-[#f7fbfb] min-h-full">
      <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8 space-y-4">

        <p className="text-lg font-semibold" style={{ color: '#13294B' }}>
          Hi, {profile?.first_name ?? user.email?.split('@')[0] ?? 'there'} 👋
        </p>

        {/* PWA push notifications — soft-ask shown only when the patient
            has an active plan and hasn't already been prompted. */}
        <PushSoftAsk enabled={currentCount > 0} />

        {/* Approved balance — renders ONLY when limit is set. Null →
            null render, no placeholder, no "R0 available". */}
        <ApprovedBalanceCard limit={approvedLimit} available={available} />

        {/* Hero: pending bill / next instalment / all-paid-up */}
        {hero}

        {/* Active plans count → tappable to /patient/orders */}
        <Link href="/patient/orders" className={`${card} block hover:shadow-md transition-shadow`}>
          <CardLabel>Your Plans</CardLabel>
          {totalCount === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-gray-200 py-8 text-center">
              <p className="text-sm font-medium text-gray-400">No payment plans yet</p>
              <p className="mt-1 text-xs text-gray-400">Plans appear here when a practice sends you a bill.</p>
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Active</p>
                <p className="text-4xl font-bold tabular-nums mt-0.5" style={{ color: '#13294B' }} data-testid="dashboard-active-plans-count">
                  {currentCount}
                </p>
              </div>
              <span className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm">
                View all →
              </span>
            </div>
          )}
        </Link>

        {/* Find-care search bar (LINK to explore). */}
        <FindCareBar />

      </div>
    </div>
  );
}
