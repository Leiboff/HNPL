import { redirect, notFound } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
// TradingGateResult is no longer annotated explicitly: `gate` comes out of
// the wave below, where Promise.all's tuple inference already gives it that
// exact type.
import { checkTradingGate } from '@/lib/practice/tradingGate';
import PracticeShell from '../PracticeShell';
import { resolvePracticeShellAuthority } from '../practiceShellAuthority';
import { resolvePracticeViewer } from '../practiceViewer';
import CreateBillButton from '../CreateBillButton';
import BillsBrowser from './BillsBrowser';
import type { PlanSummary } from '../billHelpers';

// ─── /practice/bills — every bill, searchable ─────────────────────────────
//
// The dashboard answers "how is the practice doing" and shows recent bills
// under a chart. This answers "where is that one bill" — the whole list,
// with a status filter and a search over patient / invoice / the practice's
// own reference. The dashboard's card now carries a "See all →" here.
//
// NO SECOND TABLE. ./BillsBrowser wraps ../BillsTable, the same component
// the dashboard's card renders. The four-column layout, per-row disclosure,
// status chips and mobile card view are not reimplemented here, and there is
// no copy of that markup to drift.
//
// ROUTING — this does NOT shadow /practice/bills/new. In the App Router a
// directory's own page.tsx serves the directory's path and its children
// serve theirs: app/practice/bills/page.tsx is /practice/bills and
// app/practice/bills/new/page.tsx is /practice/bills/new. They are siblings
// in the URL space, not competitors. (The nav's active-state check does need
// to know: /practice/bills is a string prefix of /practice/bills/new, so
// both nav surfaces match it exactly rather than by prefix — otherwise Bills
// would highlight while the caller is on the new-bill form.)
//
// AUTHORITY — deliberately the same as the dashboard's, no narrower and no
// wider. ../practiceViewer resolves either an active practice_members row or
// real brand-admin authority over an explicit ?practiceId=, and the rows
// shown are the SAME plans query the dashboard already runs for the same
// viewer. There is nothing here a viewer could not already see one tab
// across; making this list manager-only would just mean a member who can
// create bills cannot find the one they created.
//
// The CREATE path is a different question and stays gated: ../CreateBillButton
// is the single sanctioned entry point (app/practice/create-bill-entries.test.ts
// bans a hand-rolled /practice/bills/new href), and it disables itself from
// the trading gate. checkTradingGate is consumed read-only here.

export const dynamic = 'force-dynamic';

type SearchParams = { practiceId?: string };

export default async function PracticeBillsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const { user, supabase } = await requireConfirmedUser({ next: '/practice/bills' });

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

  // Same reader rule as the dashboard: the caller's own client on the member
  // path so RLS decides, service-role on the brand path because RLS's
  // is_practice_member only recognises practice_members — a brand-admin-only
  // caller would otherwise read no plans and no patient names.
  const reader = viaBrandAdmin ? svc : supabase;

  // Byte-identical select to the dashboard's, deliberately: the two surfaces
  // render the same PlanSummary shape through the same table, and a second,
  // slightly-different projection is how one of them ends up missing a field
  // the shared component reads.
  // ─── One wave: plans, trading gate, shell authority ─────────────────────
  //
  // Three sequential awaits became one round trip. None depends on another —
  // each is keyed on practiceId (plus user.id and canManagePractice, already
  // resolved by the viewer above), so the ordering was incidental.
  //
  // Everything ABOVE stays strictly sequential and must: requireConfirmedUser,
  // then the profile role gate, then resolvePracticeViewer. That is the
  // authorisation chain, each step genuinely needing the previous one's
  // result, and no data read may start before it finishes.
  const [
    { data: rawPlans },
    gate,
    { isBrandAdmin, canManageTill, brandPracticeCount },
  ] = await Promise.all([
    // Byte-identical select to the dashboard's, deliberately: the two surfaces
    // render the same PlanSummary shape through the same table, and a second,
    // slightly-different projection is how one of them ends up missing a field
    // the shared component reads.
    reader
    .from('plans')
    .select(`
      id, total_amount, status, created_at, invoice_number, practice_reference,
      provider_member_id,
      patient:profiles!plans_patient_id_fkey(first_name, last_name),
      provider_member:practice_members!plans_provider_member_id_fkey(
        id, user_id, provider_first_name, provider_last_name, specialty,
        profiles(first_name, last_name)
      ),
      payouts(net_amount, status),
      invitations:patient_invitations(viewed_at, accepted_at, expires_at)
    `)
    .eq('practice_id', practiceId)
    .order('created_at', { ascending: false })
    .limit(500),
    checkTradingGate(svc, practiceId),
    resolvePracticeShellAuthority(supabase, user.id, practiceId, canManagePractice),
  ]);

  const plans = (rawPlans ?? []) as PlanSummary[];

  // Specialty rides along on the provider_member embed, keyed on the
  // MEMBERSHIP id — what plans carry since 0094.
  const specialtyMap: Record<string, string> = {};
  for (const p of plans) {
    const m = Array.isArray(p.provider_member) ? p.provider_member[0] : p.provider_member;
    if (m?.id && m.specialty) specialtyMap[m.id] = m.specialty;
  }



  return (
    <PracticeShell
      practiceName={practiceName}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-10 space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: 'var(--portal-ink)' }}>
              Bills
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Every bill this practice has raised.
            </p>
          </div>
          <CreateBillButton gate={gate} variant="primary" practiceId={practiceId} />
        </div>

        <BillsBrowser
          plans={plans}
          feePercent={feePercent}
          specialtyMap={specialtyMap}
        />
      </main>
    </PracticeShell>
  );
}
