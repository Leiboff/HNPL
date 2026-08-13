import { redirect, notFound } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import PracticeShell from '../PracticeShell';
import { resolvePracticeShellAuthority } from '../practiceShellAuthority';
import { resolvePracticeViewer } from '../practiceViewer';
import { resolvePayoutHistory } from '@/lib/practice/payoutHistory';
import MonthlyRevenueChart from '../MonthlyRevenueChart';
import PayoutBatchList from './PayoutBatchList';

// ─── /practice/payouts — every weekly deposit, and what made it up ─────────
//
// The dashboard hero answers "how much is coming and when" for the next
// payout. This answers the question that comes after the money arrives: "which
// plans produced the R15,240.50 that landed on Friday". So it is a list of
// weekly batches, each expandable to its component plans with gross, the
// BetterNow fee and net — the numbers a practice reconciles against a bank
// statement.
//
// WHAT A BATCH IS. Paid UPFRONT, per PLAN: the practice gets the full plan net
// when a plan activates, because BetterNow carries the patient credit risk.
// Instalments 2..N produce no payout activity at all, so a batch is a set of
// activated plans and never a set of instalments. See 0090 and
// lib/practice/payoutHistory.ts.
//
// SETTLEMENT IS MANUAL, AND THE UI SAYS SO. A batch closes automatically
// Thursday 02:00 SAST, but the EFT is a human running a transfer and clicking
// Mark paid in /admin/payouts. So a batch sits CLOSED-BUT-UNPAID in between,
// sometimes for days, and that state must never look like money that has
// arrived. ../payoutCopy owns those words and ./PayoutBatchList's tests assert
// the whole "paid / transferred / received / landed" vocabulary is absent from
// an unpaid row.
//
// ── AUTHORITY: no gate beyond the practice scope ─────────────────────────
//
// Both tables this reads are MEMBER-level SELECT, deliberately:
//
//   payout_batches  is_practice_member  (0090)
//   payouts         is_practice_member  (0092)
//
// 0092 widened payouts from manager-only precisely so that the plan breakdown
// behind a batch total works for everyone who can see the total — before it, an
// ordinary member saw "from N plans" above an empty list. Adding a manager gate
// on this page would re-create by hand exactly the asymmetry that migration
// removed, so there is none: the authority here is the same as the dashboard's
// and the Bills tab's, no narrower and no wider.
//
// There is also nothing to gate. The page is read-only — no server action, no
// form, no mark-paid affordance. A practice can never mark its own money paid
// (0090: no practice-side INSERT/UPDATE policy exists at all), and that stays
// true because this page asks for nothing.
//
// WHY SERVICE-ROLE ON THE BRAND PATH, when the RLS policies already cover a
// brand-admin (0061/0090): the plan lines embed plans → profiles for the
// patient label, and profiles was deliberately never widened for brand-admins.
// A brand-admin-only caller reading with their own client would get batches
// with nameless plans. Same `reader` rule as the dashboard and the Bills tab,
// scoped to the one practice resolvePracticeViewer already authorized.

export const dynamic = 'force-dynamic';

type SearchParams = { practiceId?: string };

export default async function PracticePayoutsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const { user, supabase } = await requireConfirmedUser({ next: '/practice/payouts' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient')    redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const viewer = await resolvePracticeViewer(supabase, svc, user.id, params.practiceId);
  if (viewer.kind === 'setup')  redirect('/practice/setup');
  if (viewer.kind === 'denied') notFound();

  const { practiceId, practiceName, feePercent, canManagePractice, viaBrandAdmin } = viewer.scope;

  const reader = viaBrandAdmin ? svc : supabase;

  // The batches, their plans, and every date they need — all resolved server
  // side. ./PayoutBatchList receives pre-formatted SAST date strings and owns
  // no clock; see its header.
  const history = await resolvePayoutHistory(reader, practiceId);

  // ── The 12-month revenue trend, moved here from the dashboard ───────────
  //
  // It was above the bills card on /practice, which is the screen a practice
  // opens every day to see today's work — a year-scale trend is not that. It
  // belongs on the money screen, read monthly, next to the deposits it
  // explains.
  //
  // A NARROW projection, not the dashboard's: MonthlyRevenueChart reads five
  // fields. Copying the dashboard's full plans select would pull patient names,
  // provider embeds, payouts and invitations across the wire for a chart that
  // renders none of them — and would make this the THIRD place that projection
  // has to stay in step with.
  const { data: chartPlans } = await reader
    .from('plans')
    .select('id, provider_member_id, total_amount, status, created_at')
    .eq('practice_id', practiceId)
    .order('created_at', { ascending: false })
    .limit(2000);

  const { isBrandAdmin, canManageTill, brandPracticeCount } =
    await resolvePracticeShellAuthority(
      supabase, user.id, practiceId, canManagePractice,
    );

  return (
    <PracticeShell
      practiceName={practiceName}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: '#13294B' }}>
            Payouts
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Every weekly deposit, and the plans that make it up.
          </p>
        </div>

        <PayoutBatchList history={history} />

        {/* ── Revenue, for context under the deposits ─────────────────── */}
        <section className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4 sm:p-5">
          <h2 className="text-base font-semibold text-gray-900">Revenue</h2>
          <p className="mt-0.5 mb-4 text-xs text-gray-500">
            Net of the BetterNow fee, by month.
          </p>
          <MonthlyRevenueChart plans={chartPlans ?? []} feePercent={feePercent} />
        </section>
      </main>
    </PracticeShell>
  );
}
