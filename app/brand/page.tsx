import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { computeRevenue, type RevenuePlan } from '@/lib/brand/revenue';
import GroupDashboard, {
  type BranchOption,
  type ProviderOption,
} from './GroupDashboard';
import BrandShell from './BrandShell';
import BrandQuickActions from './BrandQuickActions';
import BrandPayoutBlock from './BrandPayoutBlock';
import { resolveBrandPayouts } from '@/lib/brand/brandPayouts';
import {
  PROVIDER_MEMBER_SELECT,
  providerMemberName,
  type ProviderMemberRef,
} from '@/lib/practice/providerIdentity';

// ─── /brand — the Overview tab ──────────────────────────────────────────
//
// n=1 rule (unchanged):
//   n = 0  → /practice/setup
//   n = 1  → /practice
//   n >= 2 → render the brand portal.
//
// WHAT OVERVIEW ANSWERS
//   "What money is coming, and which practice do I need to open?"
// In that order, which is why the payout block is the first thing under
// the nav and the revenue analysis sits below it. Analysis happens one
// level down or on Reports; this page is a hero and a set of doorways.
//
// TWO KINDS OF NUMBER, KEPT APART
//   The payout block is MONEY IN FLIGHT — server-resolved per practice
//   and NOT subject to the revenue filters below it. A filtered payout
//   figure would be an amount nobody is owed, so it is resolved here,
//   above the client component that owns the filter state, and passed
//   in already final.
//
//   The revenue section is ANALYSIS. Server sends RAW plans
//   (RevenuePlan + created_at) + practice + doctor dropdowns; the client
//   owns filter state and calls computeRevenue + buildMonthlySeries on
//   the filtered subset — no new aggregation logic, no new views.
//
//   The ONE figure that crosses the line is each practice's active plan
//   count on a payout row. It is computed HERE from the same
//   computeRevenue the revenue section uses, UNFILTERED, so "active"
//   cannot come to mean two different things on one page.
//
// The scoping reads below are deliberately left inline rather than moved
// to lib/brand/brandViewer (which /brand/practices uses): this page's
// membership-before-data ordering and its .in('group_id', groupIds) are
// pinned directly by brand-dashboard.test.ts, and the payouts loader
// needs the practice list either way. Folding this page into the shared
// resolver is a follow-up, not part of adding a tab.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type PlanRow = RevenuePlan & { created_at: string };

export default async function BrandDashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: rawMemberships } = await supabase
    .from('practice_group_members')
    .select('group_id, active')
    .eq('user_id', user.id)
    .eq('active', true);

  const memberships = (rawMemberships ?? []) as Array<{ group_id: string }>;
  if (memberships.length === 0) redirect('/practice');

  const groupIds = memberships.map((m) => m.group_id);
  const s = svc();

  const { data: rawBranches } = await s
    .from('practices')
    .select('id, name, status, city, suburb, group_id, fee_percent')
    .in('group_id', groupIds)
    .order('name');
  const branchRows = (rawBranches ?? []) as Array<{
    id: string; name: string; status: string;
    city: string | null; suburb: string | null;
    group_id: string; fee_percent: number | null;
  }>;

  if (branchRows.length === 0) redirect('/practice/setup');
  if (branchRows.length === 1) redirect(`/practice?practiceId=${branchRows[0].id}`);

  const practiceIds = branchRows.map((b) => b.id);

  const { data: rawBrands } = await s
    .from('practice_groups')
    .select('id, name')
    .in('id', groupIds);
  const brands = (rawBrands ?? []).map((g) => ({
    id:   g.id as string,
    name: (g.name as string) ?? '—',
  }));

  const { data: rawPlans } = await s
    .from('plans')
    .select('id, practice_id, provider_member_id, total_amount, status, created_at')
    .in('practice_id', practiceIds)
    .limit(5000);
  const plans = (rawPlans ?? []) as PlanRow[];

  // Provider dropdown — MEMBERSHIP ids that appear on any of the group's
  // plans, with their display names. Resolved from practice_members, not
  // profiles: a roster-only practitioner has no profile and would otherwise
  // vanish from the dropdown while their bills still counted in the totals.
  const providerIds = Array.from(new Set(plans.map((p) => p.provider_member_id).filter((id): id is string => !!id)));
  let providers: ProviderOption[] = [];
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

  const branches: BranchOption[] = branchRows.map((b) => ({
    id:      b.id,
    name:    b.name,
    status:  b.status,
    suburb:  b.suburb,
    city:    b.city,
    groupId: b.group_id,
    feePct:  Number(b.fee_percent ?? 0),
  }));

  // ── Next payouts, per practice ────────────────────────────────────────
  //
  // Service-role, scoped to the practice ids resolved from the caller's own
  // group memberships above — the same authority pattern every read on this
  // page already uses. resolveBrandPayouts makes no scoping decision of its
  // own; it delegates to resolveNextPayout per practice, which applies
  // .eq('practice_id', …) unconditionally.
  const payouts = await resolveBrandPayouts(s, branches.map((b) => ({ id: b.id, name: b.name })));

  // Active plan count per practice, UNFILTERED — computeRevenue's own
  // definition of active, so the count on a payout row and the count in the
  // revenue section below cannot drift apart.
  const unfiltered = computeRevenue(
    plans,
    branches.map((b) => ({ id: b.id, name: b.name, fee_percent: b.feePct })),
    providers,
    {},
  );
  const activePlanCounts: Record<string, number> = {};
  for (const row of unfiltered.byPractice) activePlanCounts[row.id] = row.count;

  return (
    <BrandShell brandName={brands[0]?.name ?? null} brandCount={brands.length}>
      <BrandQuickActions />
      <BrandPayoutBlock rollup={payouts} activePlanCounts={activePlanCounts} />
      <GroupDashboard
        branches={branches}
        providers={providers}
        plans={plans}
      />
    </BrandShell>
  );
}
