import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import { createBill } from './actions';
import BillForm from './BillForm';
import PracticeShell from '@/app/practice/PracticeShell';
import { resolvePracticeShellAuthority } from '@/app/practice/practiceShellAuthority';
import {
  PROVIDER_MEMBER_SELECT,
  providerMemberName,
  type ProviderMemberRef,
} from '@/lib/practice/providerIdentity';

export type { CreateBillSummary, CreateBillResult } from './actions';

// Keyed on the practice_members row id, not the auth user id: a roster-only
// practitioner has no auth user, and since 0094 a plan is attributed to the
// membership anyway. Name is pre-resolved because it lives in one of two
// places depending on whether they have a login (see providerIdentity).
export type ProviderOption = {
  memberId: string;
  name:     string;
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
    // can_manage_practice added for the nav shell's permission-gated links
    // (resolved, never assumed — see resolvePracticeShellAuthority below).
    .select('practice_id, created_at, can_manage_practice, practices(id, name, fee_percent)')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true });

  const memberRowsRaw = (rawMemberships ?? []) as unknown as Array<{
    practice_id:         string;
    created_at:          string;
    can_manage_practice: boolean;
    practices:           PracticeInfo | PracticeInfo[] | null;
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

  // Fetch active providers for this practice. No user_id filter: a roster-only
  // practitioner (user_id IS NULL) is a perfectly valid target for a bill since
  // 0094, and excluding them here is what made the roster half-useful.
  const { data: memberRowsForProviders } = await supabase
    .from('practice_members')
    .select(PROVIDER_MEMBER_SELECT)
    .eq('practice_id', practiceId)
    .eq('active', true)
    .eq('role', 'provider');

  const providers: ProviderOption[] = ((memberRowsForProviders ?? []) as unknown as ProviderMemberRef[])
    .map((m) => ({ memberId: m.id, name: providerMemberName(m) }))
    // Stable, human order — the query has none, and a picker whose options
    // reshuffle between renders is its own small bug.
    .sort((a, b) => a.name.localeCompare(b.name));

  const { isBrandAdmin, canManageTill, brandPracticeCount } =
    await resolvePracticeShellAuthority(
      supabase, user.id, practiceId, picked.can_manage_practice,
    );

  return (
    <PracticeShell
      practiceName={practice.name}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-10 max-w-3xl">
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
    </PracticeShell>
  );
}
