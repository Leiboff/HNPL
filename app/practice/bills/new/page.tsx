import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import { createBill } from './actions';
import BillForm from './BillForm';

export type { CreateBillSummary, CreateBillResult, InvitationSummary } from './actions';

export type ProviderOption = {
  userId:    string;
  firstName: string;
  lastName:  string;
};

type PracticeInfo = { id: string; name: string; fee_percent: number };

export default async function NewBillPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/practice/bills/new' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient')  redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  const { data: membership } = await supabase
    .from('practice_members')
    .select('practice_id, practices(id, name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .single();

  if (!membership) redirect('/practice');

  const practice = membership.practices as unknown as PracticeInfo | null;
  if (!practice) redirect('/practice');

  const practiceId = membership.practice_id as string;

  // ── Trading gate ───────────────────────────────────────────────────────
  // Mirror the gate the server action enforces. If the gate is closed we
  // never render the form — we redirect to the dashboard, where the user
  // sees a single source-of-truth status panel explaining which condition
  // is unmet. Server-action call is still the authoritative reject path.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const gate: TradingGateResult = await checkTradingGate(svc, practiceId);
  if (!gate.ok) {
    // A user-token caller can still reach this URL (typed in, stale tab,
    // dashboard navigation that raced an admin action). Don't silently
    // bounce to /practice — the dashboard would just look like a refresh.
    // Append ?reason=trading_gate so the dashboard renders an explanatory
    // banner above the gate panel.
    redirect('/practice?reason=trading_gate');
  }

  // Fetch active providers for this practice. We already know there is at
  // least one (gate passed); this query produces the actual dropdown list.
  const { data: memberRows } = await supabase
    .from('practice_members')
    .select('user_id, profiles(first_name, last_name)')
    .eq('practice_id', practiceId)
    .eq('active', true)
    .eq('role', 'provider');

  const providers: ProviderOption[] = (memberRows ?? []).map((m: { user_id: string; profiles: unknown }) => {
    const profileRow = Array.isArray(m.profiles)
      ? (m.profiles[0] as { first_name?: string; last_name?: string } | undefined)
      : (m.profiles as { first_name?: string; last_name?: string } | null);
    return {
      userId:    m.user_id,
      firstName: profileRow?.first_name ?? '',
      lastName:  profileRow?.last_name  ?? '',
    };
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-3xl px-6 py-4 flex items-center justify-between">
          <div>
            <span className="text-lg font-semibold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
            </span>
            <span className="ml-2 text-sm text-gray-400">— {practice.name}</span>
          </div>
          <a href="/practice" className="text-sm text-[#15A89E] hover:text-[#13294B]">
            ← Back to dashboard
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-gray-900">New Bill</h1>
          <p className="mt-2 text-gray-500">
            Create a payment plan for a patient. They will be charged in{' '}
            <span className="font-medium">interest-free instalments</span> around their salary date.
          </p>
        </div>

        <BillForm
          feePercent={Number(practice.fee_percent)}
          providers={providers}
          createBill={createBill}
        />
      </main>
    </div>
  );
}
