import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import RevenueClient from './RevenueClient';

// ─── Brand revenue dashboard ───────────────────────────────────────────
//
// Active-only revenue for the brand-admin's group, with a gross⇄net
// toggle (commission = fee_percent, derivable as gross − net), filter
// by practice (branch) and by doctor (practitioner). No patient
// collection / instalment progress is shown — providers see
// bill-level gross/net on activated plans only.
//
// Scoping
//   The page resolves the caller's brand_admin memberships from
//   practice_group_members (session client, RLS-enforced). It then
//   uses the service-role client to pull plans/practices/providers
//   scoped to those group_ids. Service-role is used so the join to
//   profiles for practitioner names works without adding a brand-
//   admin-specific RLS policy on profiles; the page-level guard is
//   the security boundary (cross-group isolation tested adversarially
//   in app/brand/brand-scope-isolation.test.ts).

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type SearchParams = { practice?: string; provider?: string };

export default async function BrandRevenuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // What groups is this caller a brand_admin of?
  const { data: rawMemberships } = await supabase
    .from('practice_group_members')
    .select('group_id, active')
    .eq('user_id', user.id)
    .eq('active', true);

  const memberships = (rawMemberships ?? []) as Array<{ group_id: string }>;
  if (memberships.length === 0) redirect('/practice');

  const groupIds = memberships.map((m) => m.group_id);
  const s = svc();

  // ── 1. Practices in this caller's group(s) ─────────────────────────
  // The brand_admin_select_branches RLS policy (0061) gates the
  // session-client view of these, but we use service-role here so
  // we never accidentally leak rows from a group the caller doesn't
  // belong to — the guard above is the authz boundary.
  const { data: rawPractices } = await s
    .from('practices')
    .select('id, name, fee_percent, group_id')
    .in('group_id', groupIds)
    .order('name');

  const practices = (rawPractices ?? []) as Array<RevenuePractice & { group_id: string }>;
  const practiceIds = practices.map((p) => p.id);

  // Early exit if the brand has no practices yet (rare but possible
  // when a brand row pre-exists its first practice). Show an empty
  // state instead of running the plans query for nothing.
  if (practiceIds.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10">
        <h1 className="text-2xl font-semibold mb-1" style={{ color: '#13294B' }}>Group revenue</h1>
        <p className="text-sm text-gray-500 mb-6">Active-plan revenue across your group.</p>
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No practices in your brand yet.</p>
        </div>
      </div>
    );
  }

  // ── 2. Plans across those practices ────────────────────────────────
  // Pull only what computeRevenue needs. NO payment/instalment data
  // — providers don't see collection state on this dashboard.
  const { data: rawPlans } = await s
    .from('plans')
    .select('id, practice_id, provider_id, total_amount, status')
    .in('practice_id', practiceIds)
    .limit(5000);

  const plans = (rawPlans ?? []) as RevenuePlan[];

  // ── 3. Providers — names for the doctor breakdown ─────────────────
  // Get the distinct provider_ids touched by ANY plan (including
  // not-active-for-revenue ones — the dropdown should still let the
  // brand-admin pick a doctor whose only plans are pending; they'll
  // just see zero revenue for that filter, which is informative).
  const providerIds = [...new Set(plans.map((p) => p.provider_id).filter((id): id is string => !!id))];
  let providers: RevenueProvider[] = [];
  if (providerIds.length > 0) {
    const { data: profilesData } = await s
      .from('profiles')
      .select('id, first_name, last_name')
      .in('id', providerIds);
    providers = (profilesData ?? []).map((p) => ({
      id:       p.id as string,
      fullName: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '—',
    }));
  }

  // ── 4. Parse + clamp the filter from the URL ──────────────────────
  // The filter must be one of the brand's own practice/provider ids
  // — a tampered `?practice=otherGroupBranch` simply falls back to
  // "no filter" (clamped here AND in the computeRevenue layer).
  const params = await searchParams;
  const validPracticeIds = new Set(practiceIds);
  const validProviderIds = new Set(providerIds);
  const filter = {
    practiceId: params.practice && validPracticeIds.has(params.practice) ? params.practice : null,
    providerId: params.provider && validProviderIds.has(params.provider) ? params.provider : null,
  };

  // ── 5. Aggregate ──────────────────────────────────────────────────
  const summary = computeRevenue(
    plans,
    practices.map((p) => ({ id: p.id, name: p.name, fee_percent: Number(p.fee_percent ?? 0) })),
    providers,
    filter,
  );

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>Group revenue</h1>
        <p className="text-sm text-gray-500 mt-1">
          Active-plan revenue across your group. Gross is the bill value; net is what you receive after BetterNow&apos;s commission.
          Collection of patient instalments is handled by BetterNow.
        </p>
      </header>

      <RevenueClient
        summary={summary}
        practices={practices.map((p) => ({ id: p.id, name: p.name }))}
        providers={providers}
        selectedPracticeId={filter.practiceId}
        selectedProviderId={filter.providerId}
      />
    </div>
  );
}
