import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import PracticeShell from './PracticeShell';
import PracticeDashboardClient from './PracticeDashboardClient';
import CreateBillButton from './CreateBillButton';
import { PlanSummary } from './billHelpers';

type SearchParams = { reason?: string };

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

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id, can_manage_practice, practices(name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) redirect('/practice/setup');

  const practiceInfo = membership.practices as unknown as { name: string; fee_percent: number } | null;
  const practiceName = practiceInfo?.name ?? '';
  const feePercent   = Number(practiceInfo?.fee_percent ?? 6);
  const practiceId   = membership.practice_id as string;

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

  return (
    <PracticeShell practiceName={practiceName}>
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
          </div>
          <CreateBillButton gate={gate} variant="primary" />
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
              {gate.reason === 'pending_approval'
                ? 'Awaiting approval'
                : 'Add a provider to start billing'}
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
          </div>
        )}

        {/* Dashboard: global filters + chart + bills */}
        <PracticeDashboardClient
          plans={plans}
          feePercent={feePercent}
          specialtyMap={specialtyMap}
          practiceName={practiceName}
          gate={gate}
        />

      </main>
    </PracticeShell>
  );
}
