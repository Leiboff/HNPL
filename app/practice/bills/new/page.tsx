import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import { createBill } from './actions';
import BillForm from './BillForm';

export type { CreateBillSummary, CreateBillResult } from './actions';

export type ProviderOption = {
  userId:    string;
  firstName: string;
  lastName:  string;
};

type PracticeInfo = { id: string; name: string; fee_percent: number };

// Search-params carry the ?practiceId= scope selector — same shape
// the /practice dashboard reads. A brand-admin with N≥2 branches
// picks the practice from the group dashboard, and the CreateBillButton
// forwards that scope onto this route.
type SearchParams = { practiceId?: string };

export default async function NewBillPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

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

  // ── Membership resolution — matches /practice dashboard pattern ──
  //
  // Post-0062 a brand-admin routinely has N≥2 practice_members rows.
  // The old `.single()` here threw for that case and was the root
  // cause of "group→practice bill issue never confirmed working".
  //
  // Pattern:
  //   • Load ALL active memberships (with joined practice info).
  //   • If ?practiceId= is supplied and matches one, use it.
  //   • Else fall back to the oldest membership (solo case).
  // Same fallback the /practice/page.tsx uses so both surfaces
  // resolve to the same practice for the same URL.
  const { data: rawMemberships } = await supabase
    .from('practice_members')
    .select('practice_id, created_at, practices(id, name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true });

  const memberRowsRaw = (rawMemberships ?? []) as unknown as Array<{
    practice_id: string;
    created_at:  string;
    practices:   PracticeInfo | PracticeInfo[] | null;
  }>;
  const memberRows = memberRowsRaw.map((m) => ({
    ...m,
    practices: Array.isArray(m.practices) ? (m.practices[0] ?? null) : m.practices,
  }));

  if (memberRows.length === 0) redirect('/practice');

  const requestedId = params.practiceId;
  const picked =
    (requestedId && memberRows.find((m) => m.practice_id === requestedId)) ||
    memberRows[0];

  const practice = picked.practices;
  if (!practice) redirect('/practice');

  const practiceId = picked.practice_id;

  // ── Trading gate — scoped to the resolved practice ─────────────────
  //
  // If the caller supplied a ?practiceId= we couldn't match, the fallback
  // just above picked their oldest membership rather than 404'ing. That
  // matches the dashboard's tolerance for stale URL params. The gate
  // runs against the resolved practiceId.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const gate: TradingGateResult = await checkTradingGate(svc, practiceId);
  if (!gate.ok) {
    // Bounce back to the dashboard for THIS practice (not a random one)
    // so the trading-gate explanation lines up with the practice the
    // user was trying to bill from.
    redirect(`/practice?reason=trading_gate&practiceId=${practiceId}`);
  }

  // Fetch active providers for this practice.
  const { data: memberRowsForProviders } = await supabase
    .from('practice_members')
    .select('user_id, profiles(first_name, last_name)')
    .eq('practice_id', practiceId)
    .eq('active', true)
    .eq('role', 'provider');

  const providers: ProviderOption[] = (memberRowsForProviders ?? []).map((m: { user_id: string; profiles: unknown }) => {
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
          <a
            href={`/practice?practiceId=${practiceId}`}
            className="text-sm text-[#15A89E] hover:text-[#13294B]"
          >
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
          practiceId={practiceId}
          createBill={createBill}
        />
      </main>
    </div>
  );
}
