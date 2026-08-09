import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import { issueCounterSession } from './actions';
import CounterSessionForm from './CounterSessionForm';

// ─── /practice/pos — counter QR bill issuance ───────────────────────────
//
// Till-side counterpart to /practice/bills/new. Same membership/
// trading-gate resolution (see that page for the full reasoning on the
// N>=2-practice-membership fallback); the difference is the form below
// captures an SA ID number instead of an email and renders the result
// as an on-screen QR instead of sending an email.

export type ProviderOption = {
  userId:    string;
  firstName: string;
  lastName:  string;
};

type PracticeInfo = { id: string; name: string };
type SearchParams = { practiceId?: string };

export default async function PosPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const { user, supabase } = await requireConfirmedUser({ next: '/practice/pos' });

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

  const { data: rawMemberships } = await supabase
    .from('practice_members')
    .select('practice_id, created_at, practices(id, name)')
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

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const gate: TradingGateResult = await checkTradingGate(svc, practiceId);
  if (!gate.ok) {
    redirect(`/practice?reason=trading_gate&practiceId=${practiceId}`);
  }

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
            <span className="ml-2 text-sm text-gray-400">— {practice.name} · Counter</span>
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
          <h1 className="text-3xl font-semibold text-gray-900">Counter checkout</h1>
          <p className="mt-2 text-gray-500">
            Enter the amount and the patient&apos;s SA ID number. They scan the QR with their own
            phone to finish signing up and pay — nothing is typed into this screen beyond the
            amount and ID.
          </p>
        </div>

        <CounterSessionForm
          providers={providers}
          practiceId={practiceId}
          issueCounterSession={issueCounterSession}
        />
      </main>
    </div>
  );
}
