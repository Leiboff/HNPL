import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  PROVIDER_MEMBER_SELECT,
  providerMemberName,
  type ProviderMemberRef,
} from '@/lib/practice/providerIdentity';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import RevenueClient from './RevenueClient';
import BrandShell from '../BrandShell';
import { resolveBrandGroupIds } from '@/lib/brand/brandViewer';

// ─── Brand revenue dashboard — the Reports tab ──────────────────────────
//
// REACHABILITY, NOT REDESIGN
//   This screen was fully built and linked from NOTHING. Not one href in
//   the product pointed at it, so it may as well not have existed. The
//   brand nav (../brandNavLinks) now carries it as "Reports", and the
//   only change made to the page itself is that it renders inside
//   ../BrandShell — because a tab you can reach but cannot navigate out
//   of is not reachable in any useful sense.
//
//   The one addition the wrapper forced is the practice_groups read
//   below, purely so the shell's header can name the brand the way it
//   does on the other two tabs. What this page RENDERS is untouched:
//   same guard, same queries, same filters, same RevenueClient, same
//   empty state.
//
// The label is "Reports" rather than "Revenue" because Overview is now
// where the money owed to you lives; this is the by-practice /
// by-doctor breakdown you go to when you want to analyse it.
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

  // What groups is this caller a brand_admin of? Shared read (the caller's own
  // client, RLS-enforced). This screen deliberately does NOT apply the
  // n=1 rule that /brand and /brand/practices do — it renders for a solo brand
  // admin too, which is why it uses the scope read rather than resolveBrandViewer.
  const groupIds = await resolveBrandGroupIds(supabase, user.id);
  if (groupIds.length === 0) redirect('/practice');

  const s = svc();

  // ── 0. Brand identity, for the shell header only ───────────────────
  // Scoped by the same group_ids the guard above proved. Display data;
  // nothing on this page is gated on it.
  // ─── One wave: the brand rows and the practices in them ─────────────
  //
  // Two sequential awaits became one round trip. Both are keyed on groupIds
  // alone and neither reads the other's result. The plans read below is NOT
  // in here and cannot be: it filters .in('practice_id', practiceIds), which
  // only exists once the practices come back.
  //
  // The authorisation chain above is untouched: auth.getUser(), then
  // resolveBrandGroupIds on the caller's OWN client, then the empty-groups
  // redirect. Both reads below are scoped by the group ids that produced.
  //
  // ── 1. Practices in this caller's group(s) ─────────────────────────
  // The brand_admin_select_branches RLS policy (0061) gates the
  // session-client view of these, but we use service-role here so
  // we never accidentally leak rows from a group the caller doesn't
  // belong to — the guard above is the authz boundary.
  const [
    { data: rawBrands },
    { data: rawPractices },
  ] = await Promise.all([
    s.from('practice_groups')
      .select('id, name')
      .in('id', groupIds),
    s.from('practices')
      .select('id, name, fee_percent, group_id')
      .in('group_id', groupIds)
      .order('name'),
  ]);

  const brands = (rawBrands ?? []) as Array<{ id: string; name: string | null }>;
  const brandName  = brands[0]?.name ?? null;
  const brandCount = brands.length;

  const practices = (rawPractices ?? []) as Array<RevenuePractice & { group_id: string }>;
  const practiceIds = practices.map((p) => p.id);

  // Early exit if the brand has no practices yet (rare but possible
  // when a brand row pre-exists its first practice). Show an empty
  // state instead of running the plans query for nothing.
  if (practiceIds.length === 0) {
    return (
      <BrandShell brandName={brandName} brandCount={brandCount}>
        <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--portal-ink)' }}>Group revenue</h2>
        <p className="text-sm text-gray-500 mb-6">Active-plan revenue across your group.</p>
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No practices in your brand yet.</p>
        </div>
      </BrandShell>
    );
  }

  // ── 2. Plans across those practices ────────────────────────────────
  // Pull only what computeRevenue needs. NO payment/instalment data
  // — providers don't see collection state on this dashboard.
  const { data: rawPlans } = await s
    .from('plans')
    .select('id, practice_id, provider_member_id, total_amount, status')
    .in('practice_id', practiceIds)
    .limit(5000);

  const plans = (rawPlans ?? []) as RevenuePlan[];

  // ── 3. Providers — names for the doctor breakdown ─────────────────
  // Get the distinct MEMBERSHIP ids touched by ANY plan (including
  // not-active-for-revenue ones — the dropdown should still let the
  // brand-admin pick a doctor whose only plans are pending; they'll
  // just see zero revenue for that filter, which is informative).
  //
  // Resolved from practice_members rather than profiles since 0094: a
  // roster-only practitioner has no profiles row, so a profiles lookup would
  // drop them from the by-doctor breakdown entirely and quietly under-report
  // the brand's own revenue. Their name comes from the membership's local
  // columns instead — see providerIdentity.
  const providerIds = [...new Set(plans.map((p) => p.provider_member_id).filter((id): id is string => !!id))];
  let providers: RevenueProvider[] = [];
  if (providerIds.length > 0) {
    const { data: memberData } = await s
      .from('practice_members')
      .select(PROVIDER_MEMBER_SELECT)
      .in('id', providerIds);
    providers = ((memberData ?? []) as unknown as ProviderMemberRef[]).map((m) => ({
      id:       m.id,
      fullName: providerMemberName(m),
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
    <BrandShell brandName={brandName} brandCount={brandCount}>
      <header>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--portal-ink)' }}>Group revenue</h2>
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
    </BrandShell>
  );
}
