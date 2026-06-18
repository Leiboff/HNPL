import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import SalaryDayForm from './SalaryDayForm';
import InstalmentHero, { type InstalmentRow } from './InstalmentHero';
import PasskeySetupCard from './PasskeySetupCard';
import PushSoftAsk from '@/app/_pwa/PushSoftAsk';
import { ALLOWED_SALARY_DAYS, isAllowedSalaryDay } from '@/lib/salaryDates';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

// Matches the formatDate / formatRand used in OrdersView.
function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

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
  id:                string;
  amount:            number;
  due_date:          string;
  status:            string;
  instalment_number: number;
  // Supabase returns many-to-one embeds as an object; typed as union to guard
  // against the rare case where it arrives as a single-element array.
  plan: PaymentPlanEmbed | PaymentPlanEmbed[];
};

// ─── Server Action ────────────────────────────────────────────────────────────

async function saveSalaryDay(day: number): Promise<{ error: string | null }> {
  'use server';

  if (!isAllowedSalaryDay(day)) {
    return { error: `Salary day must be one of: ${ALLOWED_SALARY_DAYS.join(', ')}.` };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await supabase
    .from('profiles')
    .update({ salary_day: day })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient');
  return { error: null };
}

// ─── Shared card class (applied to every block for consistency) ───────────────
// hero keeps rounded-3xl per design; all others use rounded-2xl.
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
        .select('first_name, salary_day, passkey_prompt_dismissed_at, passkey_prompt_dismissed_count')
        .eq('id', user.id)
        .single(),
      // No profiles embed here — plans has two FKs to profiles (patient + provider)
      // which causes an ambiguous relationship error. Only embed practices(name).
      supabase
        .from('plans')
        .select('id, status, total_amount, practice:practices(name)')
        .eq('patient_id', user.id),
      // All unpaid instalments ordered soonest-first — no limit so we can sum
      // every payment due on the same date and pass them all to the modal.
      // No profiles embed — same ambiguous-FK reason as above.
      supabase
        .from('payments')
        .select(`
          id, amount, due_date, status, instalment_number,
          plan:plans!payments_plan_id_fkey(
            id, plan_type, practice:practices(name)
          )
        `)
        .eq('patient_id', user.id)
        .in('status', ['scheduled', 'processing'])
        .order('due_date', { ascending: true }),
    ]);

  const salaryDay: number | null = (profile?.salary_day as number | null) ?? null;

  // Passkey nudge: show on first dismissal allowance, and one re-prompt
  // 30+ days after the first dismissal. The card itself self-hides when the
  // patient already has a registered passkey.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const dismissedAtMs  = profile?.passkey_prompt_dismissed_at
    ? new Date(profile.passkey_prompt_dismissed_at as string).getTime()
    : null;
  const dismissedCount = (profile?.passkey_prompt_dismissed_count as number | null) ?? 0;
  const showPasskeyPrompt =
    dismissedCount === 0 ||
    (dismissedCount === 1 && dismissedAtMs !== null && Date.now() - dismissedAtMs > THIRTY_DAYS_MS);

  const allPlans     = (rawPlans   ?? []) as unknown as PlanSummary[];
  const payments     = (rawPayments ?? []) as unknown as UpcomingPayment[];

  const totalCount   = allPlans.length;
  const pendingPlans = allPlans.filter((p) => p.status === 'pending_acceptance');
  const pendingCount = pendingPlans.length;
  const currentCount = allPlans.filter((p) => p.status === 'active').length;

  // Today in SA time — YYYY-MM-DD string compared directly against due_date
  // (also YYYY-MM-DD from the DB). String comparison is timezone-safe and avoids
  // the UTC-midnight-offset bug fixed in finance.ts.
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

  // ── Hero: priority A > B > C ───────────────────────────────────────────────
  // A: pending bill(s) need action (amber accent, highest priority)
  // B: upcoming instalments — sum all due on the soonest date, tappable modal
  // C: nothing due — all paid up
  let hero: React.ReactNode;

  if (pendingCount > 0) {
    // ── A: action needed ────────────────────────────────────────────────────
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
    // ── B: upcoming instalments ─────────────────────────────────────────────
    // Payments are already sorted ascending — first row has the soonest due_date.
    const soonestDate = payments[0].due_date;
    // Group all payments sharing that date (multiple plans can coincide).
    const dueGroup    = payments.filter((p) => p.due_date === soonestDate);
    const total       = dueGroup.reduce((sum, p) => sum + Number(p.amount), 0);

    const isOverdue = soonestDate < todayStr;
    const isToday   = soonestDate === todayStr;

    const instalments: InstalmentRow[] = dueGroup.map((p) => {
      // Guard: Supabase returns many-to-one as object, but handle array defensively.
      const planData = Array.isArray(p.plan) ? (p.plan[0] ?? null) : p.plan;
      return {
        practiceName:     getPracticeName(planData?.practice ?? null),
        instalmentNumber: p.instalment_number,
        planType:         planData?.plan_type ?? null,
        amount:           Number(p.amount),
      };
    });

    hero = (
      <InstalmentHero
        dueDate={soonestDate}
        total={total}
        isOverdue={isOverdue}
        isToday={isToday}
        instalments={instalments}
      />
    );
  } else {
    // ── C: all paid up ──────────────────────────────────────────────────────
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

        {/* Greeting */}
        <p className="text-lg font-semibold" style={{ color: '#13294B' }}>
          Hi, {profile?.first_name ?? user.email?.split('@')[0] ?? 'there'} 👋
        </p>

        {showPasskeyPrompt && <PasskeySetupCard />}

        {/* PWA push notifications — soft-ask shown only when the patient
            has an active plan and hasn't already been prompted. Dismisses
            permanently. Settings toggle in /profile remains the canonical
            on/off control after dismissal. */}
        <PushSoftAsk enabled={currentCount > 0} />

        {/* ── HERO CARD ─────────────────────────────────────────────────────────
            Priority A: pending bill(s) to review (amber border, action CTA)
            Priority B: sum of all instalments due on soonest date — tappable,
                        opens InstalmentBreakdownModal with per-plan breakdown
            Priority C: all paid up
            This slot is also designed to later hold a credit-limit display.
        ──────────────────────────────────────────────────────────────────── */}
        {hero}

        {/* ── SALARY DATE CARD ─────────────────────────────────────────────── */}
        <div className={`${card} space-y-3`}>
          <CardLabel>Salary Date</CardLabel>
          {salaryDay === null && (
            <p className="text-sm text-amber-700">
              Set your salary date so we can time your payments.
            </p>
          )}
          <div className="flex flex-col sm:flex-row sm:items-start gap-5">
            <div
              className="sm:order-last sm:w-44 sm:ml-auto rounded-xl p-4 text-xs leading-relaxed space-y-1.5"
              style={{ background: 'rgba(19,41,75,.04)' }}
            >
              <p className="font-semibold text-[#13294B]">Heads up</p>
              <p className="text-gray-500">
                Your salary date sets when we collect your monthly instalments.
              </p>
              <p className="text-gray-500">
                Changes here only apply to <span className="font-medium text-gray-700">new plans</span> — existing active plans will continue collecting on their current schedule.
              </p>
            </div>
            <SalaryDayForm currentDay={salaryDay} saveSalaryDay={saveSalaryDay} />
          </div>
        </div>

        {/* ── PLANS CARD ───────────────────────────────────────────────────── */}
        <div className={card}>
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
                <p className="text-4xl font-bold tabular-nums mt-0.5" style={{ color: '#13294B' }}>{currentCount}</p>
              </div>
              <a
                href="/patient/orders"
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
              >
                View all →
              </a>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
