import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import type { RevenuePlan } from '@/lib/brand/revenue';
import GroupDashboard, {
  type BrandInfo,
  type BranchOption,
  type ProviderOption,
} from './GroupDashboard';

// ─── Brand-admin dashboard ──────────────────────────────────────────────
//
// n=1 rule (unchanged):
//   n = 0  → /practice/setup
//   n = 1  → /practice
//   n >= 2 → render the group dashboard.
//
// Server sends RAW plans (RevenuePlan + created_at) + practice + doctor
// dropdowns. The client owns filter state and calls computeRevenue +
// buildMonthlySeries on the filtered subset — no new aggregation
// logic, no new views.

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
    .select('id, name, logo_url')
    .in('id', groupIds);
  const brands: BrandInfo[] = (rawBrands ?? []).map((g) => ({
    id:      g.id as string,
    name:    (g.name as string) ?? '—',
    logoUrl: (g.logo_url as string | null) ?? null,
  }));

  const { data: rawPlans } = await s
    .from('plans')
    .select('id, practice_id, provider_id, total_amount, status, created_at')
    .in('practice_id', practiceIds)
    .limit(5000);
  const plans = (rawPlans ?? []) as PlanRow[];

  // Provider dropdown — user_ids that appear on any of the group's
  // active plans, with their display names.
  const providerIds = Array.from(new Set(plans.map((p) => p.provider_id).filter((id): id is string => !!id)));
  let providers: ProviderOption[] = [];
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

  const branches: BranchOption[] = branchRows.map((b) => ({
    id:      b.id,
    name:    b.name,
    status:  b.status,
    suburb:  b.suburb,
    city:    b.city,
    groupId: b.group_id,
    feePct:  Number(b.fee_percent ?? 0),
  }));

  return (
    <GroupDashboard
      brands={brands}
      branches={branches}
      providers={providers}
      plans={plans}
    />
  );
}
