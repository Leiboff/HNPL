import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import PracticeShell from './PracticeShell';
import PracticeDashboardClient from './PracticeDashboardClient';
import CreateBillButton from './CreateBillButton';
import { PlanSummary } from './billHelpers';

type SearchParams = { reason?: string; practiceId?: string };

export default async function PracticeDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const cameFromGatedBillsPage = params.reason === 'trading_gate';

  // Defense-in-depth — bounces to /login or /verify-email before any work.
  const { user, supabase } = await requireConfirmedUser({ next: '/practice' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient') redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  // Post-0062: a brand owner can be a member of multiple practices (one
  // per practice in their brand). The dashboard scopes to ONE practice
  // at a time — picked either by ?practiceId= (when switching from the
  // brand index) or, when absent, the first practice the user joined.
  // .single() would fail for n=2+; .order().limit(1) is safe at n=1
  // and consistent at n>=2.
  const { data: memberships } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice, created_at, practices(name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true });

  // Supabase typegen leans toward `{ practices: T[] }` for joined
  // rows even when the FK is to-one — we cast through unknown and
  // normalise below so the rest of the page sees the to-one shape we
  // expect.
  const memberRowsRaw = (memberships ?? []) as unknown as Array<{
    practice_id:         string;
    can_manage_practice: boolean;
    created_at:          string;
    practices: { name: string; fee_percent: number } | Array<{ name: string; fee_percent: number }> | null;
  }>;
  const memberRows = memberRowsRaw.map((m) => ({
    ...m,
    practices: Array.isArray(m.practices) ? (m.practices[0] ?? null) : m.practices,
  }));

  if (memberRows.length === 0) redirect('/practice/setup');

  const requestedId = params.practiceId;
  const picked =
    (requestedId && memberRows.find((m) => m.practice_id === requestedId)) ||
    memberRows[0];

  const practiceInfo = picked.practices;
  const practiceName = practiceInfo?.name ?? '';
  const feePercent   = Number(practiceInfo?.fee_percent ?? 6);
  const practiceId   = picked.practice_id;

  // Brand context — how many practices does this user own / belong to?
  // Drives the n=1-vs-n>=2 UX rule: brand wording is hidden at n=1
  // and surfaces at n>=2. We DO NOT compute brand name here — the
  // dashboard shouldn't say "brand X" for a solo user even if they
  // have a (silent, auto-created) brand row.
  const practiceCount = memberRows.length;

  const { data: rawPlans } = await supabase
    .from('plans')
    .select(`
      id, total_amount, status, created_at, invoice_number, practice_reference,
      provider_id,
      patient:profiles!plans_patient_id_fkey(first_name, last_name),
      provider:profiles!plans_provider_id_fkey(first_name, last_name),
      payouts(net_amount, status),
      invitations:patient_invitations(viewed_at, accepted_at, expires_at)
    `)
    .eq('practice_id', practiceId)
    .order('created_at', { ascending: false })
    .limit(500);

  const plans = (rawPlans ?? []) as PlanSummary[];

  // ── Trading gate ───────────────────────────────────────────────────────
  // Same check the bill-creation server action enforces. Drives whether the
  // "+ Create a bill" CTA renders or whether we show a status panel pointing
  // at the unmet condition. Server-action is still the authoritative reject.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const gate: TradingGateResult = await checkTradingGate(svc, practiceId);

  const providerIds = [...new Set(plans.map((p) => p.provider_id).filter((id): id is string => Boolean(id)))];
  const specialtyMap: Record<string, string> = {};
  if (providerIds.length > 0) {
    const { data: memberRows } = await supabase
      .from('practice_members')
      .select('user_id, specialty')
      .eq('practice_id', practiceId)
      .in('user_id', providerIds);
    for (const m of (memberRows ?? []) as { user_id: string; specialty: string | null }[]) {
      if (m.specialty) specialtyMap[m.user_id] = m.specialty;
    }
  }

  // ── Brand-admin gate for the "Practice details" sidebar link ─────
  //
  // Resolves whether the caller can reach /brand/branch/{practiceId}
  // successfully — i.e. is an active practice_group_members row for
  // this practice's brand. Post-0062 the solo owner is auto-brand-
  // admin of their own 1-practice brand, so this is true for the
  // standalone case. A branch-admin invited into someone else's
  // brand returns false, and the sidebar link is hidden — matching
  // the /brand/branch page's notFound() guard.
  const { data: practiceGroupRow } = await supabase
    .from('practices')
    .select('group_id')
    .eq('id', practiceId)
    .maybeSingle();
  let isBrandAdmin = false;
  if (practiceGroupRow?.group_id) {
    const { data: brandMembership } = await supabase
      .from('practice_group_members')
      .select('user_id')
      .eq('group_id', practiceGroupRow.group_id)
      .eq('user_id',  user.id)
      .eq('active',   true)
      .maybeSingle();
    isBrandAdmin = !!brandMembership;
  }

  return (
    <PracticeShell
      practiceName={practiceName}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">

        {/* Heading */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate" style={{ color: '#13294B' }}>
              {practiceName || 'Dashboard'}
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Welcome back, {profile?.first_name ?? user.email}
            </p>
            {/* n>=2: brand-aware switcher. n=1: only the "Add another practice"
                link, no brand wording — the auto-created brand stays invisible. */}
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
              {practiceCount >= 2 && (
                <a href="/brand" className="font-semibold underline underline-offset-2" style={{ color: '#13294B' }}>
                  See all my practices ({practiceCount})
                </a>
              )}
              <a href="/brand/new-practice" className="font-semibold underline underline-offset-2" style={{ color: '#13294B' }}>
                {practiceCount === 1 ? '+ Add another practice' : '+ Add a practice'}
              </a>
            </div>
          </div>
          <CreateBillButton gate={gate} variant="primary" practiceId={practiceId} />
        </div>

        {/* Bounce-back banner — only shown when /practice/bills/new
            redirected us here because the gate was closed. Disappears on
            any subsequent navigation that doesn't carry ?reason=. */}
        {cameFromGatedBillsPage && !gate.ok && (
          <div
            role="alert"
            data-testid="trading-gate-bounce-banner"
            className="rounded-xl border border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-semibold">You can&apos;t create bills yet.</p>
            <p className="mt-1">{gate.message}</p>
          </div>
        )}

        {/* Trading-gate panel — explains why the CTA is disabled when blocked. */}
        {!gate.ok && (
          <div
            role="status"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
            data-testid="trading-gate-panel"
          >
            <p className="font-semibold text-amber-900">
              {gate.reason === 'pending_approval' ? 'Awaiting approval'
                : gate.reason === 'no_providers'   ? 'Add a provider to start billing'
                                                   : 'Add banking to start billing'}
            </p>
            <p className="mt-1 text-amber-800">{gate.message}</p>
            {gate.reason === 'no_providers' && (
              <a
                href="/practice/members"
                className="mt-2 inline-block font-semibold underline underline-offset-2"
                style={{ color: '#13294B' }}
              >
                Go to Team →
              </a>
            )}
            {gate.reason === 'no_banking' && (
              // /practice/setup is the initial-signup flow; it redirects
              // away for anyone who already has a practice_members row
              // (i.e. anyone hitting this panel). Send users to the
              // brand-side branch edit page — the only place where the
              // BankingForm lives and the only path with a working
              // update action (updateBranchBanking). The page's own
              // guard (practice_group_members membership) enforces
              // brand-admin-only edit; a non-brand-admin lands on
              // notFound() there, which is correct — they can't set
              // their branch's banking.
              <a
                href={`/brand/branch/${practiceId}`}
                className="mt-2 inline-block font-semibold underline underline-offset-2"
                style={{ color: '#13294B' }}
              >
                Go to Banking →
              </a>
            )}
          </div>
        )}

        {/* Dashboard: global filters + chart + bills */}
        <PracticeDashboardClient
          plans={plans}
          feePercent={feePercent}
          specialtyMap={specialtyMap}
          practiceName={practiceName}
          gate={gate}
          practiceId={practiceId}
        />

      </main>
    </PracticeShell>
  );
}
