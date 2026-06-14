import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import PracticeShell from './PracticeShell';
import PracticeDashboardClient from './PracticeDashboardClient';
import { PlanSummary } from './billHelpers';

export default async function PracticeDashboardPage() {
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
      payouts(net_amount, status)
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
          {gate.ok ? (
            <a
              href="/practice/bills/new"
              className="shrink-0 rounded-lg px-4 py-2 sm:px-5 sm:py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 transition-all hover:shadow-lg"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              + Create a bill
            </a>
          ) : (
            <button
              type="button"
              disabled
              title={gate.message}
              aria-disabled
              className="shrink-0 rounded-lg px-4 py-2 sm:px-5 sm:py-2.5 text-sm font-semibold text-white opacity-50 cursor-not-allowed"
              style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
            >
              + Create a bill
            </button>
          )}
        </div>

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
        />

      </main>
    </PracticeShell>
  );
}
