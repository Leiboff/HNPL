import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { computeRevenue, type RevenuePlan, type RevenuePractice } from '@/lib/brand/revenue';
import { buildMonthlySeries, type PlanForTrend, type MonthPoint } from '@/lib/brand/monthlyRevenue';
import GroupDashboard, { type BrandInfo, type BranchInfo } from './GroupDashboard';

// ─── Brand-admin dashboard ──────────────────────────────────────────────
//
// Post-0062 every customer account is rooted at a brand. The brand
// concept is HIDDEN at n=1 — the solo practitioner experiences the
// product as "my practice", not "my brand with one practice in it".
// This page enforces that rule:
//
//   n = 0  → /practice/setup (no membership at all)
//   n = 1  → /practice       (brand invisible; their one practice IS
//                              their experience)
//   n >= 2 → render the group dashboard — hero + trend + per-branch
//            performance strip with drill-down. Doctor management
//            lives on the branch detail page (screen 2).
//
// Data flow: this server component aggregates by-branch revenue on
// the request (service-role queries scoped to the caller's group_ids,
// gated by the practice_group_members guard) and hands pre-aggregated
// arrays to the client GroupDashboard. The client component owns the
// gross/net toggle state.

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

  // Brand memberships — session client so RLS scopes to the caller's
  // own rows. A tampered ?group=<other> would never enter this list.
  const { data: rawMemberships } = await supabase
    .from('practice_group_members')
    .select('group_id, active')
    .eq('user_id', user.id)
    .eq('active', true);

  const memberships = (rawMemberships ?? []) as Array<{ group_id: string }>;
  if (memberships.length === 0) redirect('/practice');

  const groupIds = memberships.map((m) => m.group_id);

  // All practices in their brand(s). Service-role read so we never
  // silently leak or hide rows against RLS drift — the guard above
  // is the authz boundary.
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

  // Brand row(s) for logo + name.
  const { data: rawBrands } = await s
    .from('practice_groups')
    .select('id, name, logo_url')
    .in('id', groupIds);
  const brands: BrandInfo[] = (rawBrands ?? []).map((g) => ({
    id:      g.id as string,
    name:    (g.name as string) ?? '—',
    logoUrl: (g.logo_url as string | null) ?? null,
  }));

  // Plans across those practices — same columns computeRevenue needs,
  // plus created_at for the monthly series. NO payment / collection
  // state (mirrors the /brand/revenue page's discipline).
  const { data: rawPlans } = await s
    .from('plans')
    .select('id, practice_id, provider_id, total_amount, status, created_at')
    .in('practice_id', practiceIds)
    .limit(5000);
  const plans = (rawPlans ?? []) as PlanRow[];

  // fee_percent lookup used by both totals and the monthly trend.
  const feeByPractice = new Map<string, number>();
  for (const b of branchRows) feeByPractice.set(b.id, Number(b.fee_percent ?? 0));

  const revenuePractices: RevenuePractice[] = branchRows.map((b) => ({
    id: b.id, name: b.name, fee_percent: Number(b.fee_percent ?? 0),
  }));

  // Group-level totals + per-branch slices in ONE pass (computeRevenue
  // does both). byPractice rows are keyed by practice_id.
  const groupSummary = computeRevenue(plans, revenuePractices, [], {});

  const perBranchTotals = new Map<string, { gross: number; net: number; count: number }>();
  for (const row of groupSummary.byPractice) {
    perBranchTotals.set(row.id, { gross: row.gross, net: row.net, count: row.count });
  }

  // Group-level 12-month series.
  const plansForTrend = plans as PlanForTrend[];
  const groupMonthly: MonthPoint[] = buildMonthlySeries(plansForTrend, feeByPractice);

  // Per-branch 12-month series. Same helper, plans scoped by branch.
  const branches: BranchInfo[] = branchRows.map((b) => {
    const branchPlans = plansForTrend.filter((p) => p.practice_id === b.id);
    const monthly = buildMonthlySeries(branchPlans, feeByPractice);
    const t = perBranchTotals.get(b.id) ?? { gross: 0, net: 0, count: 0 };
    return {
      id:              b.id,
      name:            b.name,
      status:          b.status,
      suburb:          b.suburb,
      city:            b.city,
      groupId:         b.group_id,
      gross:           t.gross,
      net:             t.net,
      activePlanCount: t.count,
      monthly,
    };
  });

  return (
    <GroupDashboard
      brands={brands}
      branches={branches}
      totalGross={groupSummary.totalGross}
      totalNet={groupSummary.totalNet}
      totalActive={groupSummary.totalCount}
      monthly={groupMonthly}
    />
  );
}
