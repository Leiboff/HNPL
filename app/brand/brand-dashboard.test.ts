import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import { buildMonthlySeries, lastTwelveMonthsFrom, type PlanForTrend } from '@/lib/brand/monthlyRevenue';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Brand surface — team management + filtered dashboard + net-only ───
//
// Pins for this build:
//   • Group dashboard is NET-only (no gross toggle, no gross value
//     rendered).
//   • Chart + hero + strip follow the SAME filters (practice / doctor
//     / range). Filter IDs clamp to caller's own group data.
//   • Team actions (addTeamMember / updateTeamMember /
//     deactivateTeamMember / reactivateTeamMember) guard FIRST +
//     locked-column allowlist + brick-prevention (last-admin refused).
//   • Shared AddMemberForm imported by BOTH practice and brand
//     surfaces — one form, two entry points.
//   • Single entry point: no /practice?practiceId=… link on the
//     brand surface. Only "Open branch" remains.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const ACTIONS       = read('app/brand/actions.ts');
const PAGE          = read('app/brand/page.tsx');
const BRANCH_PAGE   = read('app/brand/branch/[practiceId]/page.tsx');
const GROUP_DASH    = read('app/brand/GroupDashboard.tsx');
const PERF          = read('app/brand/branch/[practiceId]/BranchPerformance.tsx');
const TEAM          = read('app/brand/branch/[practiceId]/TeamSection.tsx');
const CHART         = read('app/brand/BrandMonthlyChart.tsx');
const INVITE        = read('lib/brand/inviteMember.ts');
const MEMBERS_ACT   = read('app/practice/members/actions.ts');
const MEMBERS_VIEW  = read('app/practice/members/MembersView.tsx');
const ADD_FORM      = read('app/practice/members/AddMemberForm.tsx');
const MONTHLY       = read('lib/brand/monthlyRevenue.ts');
const REV_CLIENT    = read('app/brand/revenue/RevenueClient.tsx');

// ─── Where the old group dashboard's pieces live now ──────────────────
//
// The brand portal restructure split GroupDashboard — which used to BE
// the whole /brand screen — into the Overview tab's parts. Five pins in
// this file used to read GROUP_DASH for things that moved; each one is
// RELOCATED below rather than dropped, because the invariant it states
// is still an invariant, just about a different file:
//
//   quick actions              → ./BrandQuickActions.tsx
//   the "Open branch" doorway  → ./BrandPayoutBlock.tsx (payout rows)
//   the Till devices link      → ./practices/PracticesTable.tsx
//   the performance strip      → RETIRED; nothing on it was lost, see
//                                GroupDashboard's own header for where
//                                each column went
const QUICK         = read('app/brand/BrandQuickActions.tsx');
const PAYOUT_BLOCK  = read('app/brand/BrandPayoutBlock.tsx');
const SETUP_TABLE   = read('app/brand/practices/PracticesTable.tsx');

// ─── Unit: computeRevenue reconciles hero vs per-branch strip ─────────

describe('Group hero = sum of branch revenues (ACTIVE_FOR_REVENUE only, net)', () => {
  const practices: RevenuePractice[] = [
    { id: 'p1', name: 'Branch A', fee_percent: 10 },
    { id: 'p2', name: 'Branch B', fee_percent: 15 },
  ];
  const plans: RevenuePlan[] = [
    { id: '1', practice_id: 'p1', provider_member_id: 'd1', total_amount: 1000, status: 'active' },
    { id: '2', practice_id: 'p1', provider_member_id: 'd2', total_amount:  500, status: 'completed' },
    { id: '3', practice_id: 'p1', provider_member_id: 'd1', total_amount:  700, status: 'pending_acceptance' },
    { id: '4', practice_id: 'p2', provider_member_id: 'd3', total_amount: 2000, status: 'active' },
    { id: '5', practice_id: 'p2', provider_member_id: 'd3', total_amount:  300, status: 'defaulted' },
  ];
  const summary = computeRevenue(plans, practices, [], {});

  it('totalNet = sum of every branch net (active + completed only)', () => {
    const perBranchNet = summary.byPractice.reduce((s, r) => s + r.net, 0);
    expect(perBranchNet).toBeCloseTo(summary.totalNet, 2);
  });

  it('totalCount matches active + completed plans only', () => {
    expect(summary.totalCount).toBe(3);
  });

  it('pending_acceptance contributes nothing', () => {
    const branchA = summary.byPractice.find((r) => r.id === 'p1');
    expect(branchA?.gross).toBeCloseTo(1500, 2);   // 1000 + 500 only
  });
});

// ─── Unit: buildMonthlySeries — group series = sum of branch series ───

describe('Monthly trend: group series = sum of branch series (net)', () => {
  const NOW = new Date('2026-06-15T00:00:00Z');
  const feeByPractice = new Map<string, number>([['p1', 10], ['p2', 20]]);

  const plans: PlanForTrend[] = [
    { id: '1', practice_id: 'p1', provider_member_id: 'd1', total_amount: 1000, status: 'active',    created_at: '2026-06-05T10:00:00Z' },
    { id: '2', practice_id: 'p2', provider_member_id: 'd2', total_amount:  500, status: 'completed', created_at: '2026-06-10T10:00:00Z' },
    { id: '3', practice_id: 'p1', provider_member_id: 'd1', total_amount: 2000, status: 'active',    created_at: '2026-05-05T10:00:00Z' },
    { id: '4', practice_id: 'p1', provider_member_id: 'd1', total_amount: 9999, status: 'pending_acceptance', created_at: '2026-06-05T10:00:00Z' },
  ];

  it('the last-12-months window is deterministic from a reference date', () => {
    const months = lastTwelveMonthsFrom(NOW);
    expect(months.length).toBe(12);
    expect(months[11]).toEqual({ year: 2026, month: 6, label: 'Jun' });
  });

  it('group series (all plans) equals sum of per-branch series month-by-month', () => {
    const groupSeries = buildMonthlySeries(plans, feeByPractice, NOW);
    const p1Series    = buildMonthlySeries(plans.filter((p) => p.practice_id === 'p1'), feeByPractice, NOW);
    const p2Series    = buildMonthlySeries(plans.filter((p) => p.practice_id === 'p2'), feeByPractice, NOW);
    for (let i = 0; i < 12; i += 1) {
      expect(groupSeries[i].net).toBeCloseTo(p1Series[i].net + p2Series[i].net, 2);
    }
  });

  it('pending_acceptance contributes ZERO to every month', () => {
    const series = buildMonthlySeries(plans, feeByPractice, NOW);
    expect(series[11].gross).toBeCloseTo(1500, 2);
  });

  it('imports the shared isActiveForRevenue predicate', () => {
    expect(MONTHLY).toMatch(/isActiveForRevenue/);
    expect(MONTHLY).toMatch(/from ['"]@\/lib\/brand\/revenue['"]/);
  });
});

// ─── Unit: per-doctor breakdown sums to branch total ──────────────────

describe('Per-doctor breakdown sums to the branch total (net)', () => {
  const practices: RevenuePractice[] = [{ id: 'p1', name: 'Branch A', fee_percent: 10 }];
  const providers: RevenueProvider[] = [
    { id: 'd1', fullName: 'Dr One' },
    { id: 'd2', fullName: 'Dr Two' },
  ];
  const plans: RevenuePlan[] = [
    { id: '1', practice_id: 'p1', provider_member_id: 'd1', total_amount: 1000, status: 'active'    },
    { id: '2', practice_id: 'p1', provider_member_id: 'd1', total_amount:  500, status: 'completed' },
    { id: '3', practice_id: 'p1', provider_member_id: 'd2', total_amount:  700, status: 'active'    },
  ];
  const summary = computeRevenue(plans, practices, providers, {});

  it('sum(byProvider.net) === totalNet', () => {
    const sum = summary.byProvider.reduce((s, r) => s + r.net, 0);
    expect(sum).toBeCloseTo(summary.totalNet, 2);
  });
});

// ─── NET-ONLY: no gross toggle, no gross figure on brand surfaces ─────

describe('Brand surface is NET-only — no gross toggle, no gross figure rendered', () => {
  const NO_GROSS_TOGGLE_FILES = [
    { name: 'GroupDashboard',     src: GROUP_DASH },
    { name: 'BranchPerformance',  src: PERF },
    { name: 'RevenueClient',      src: REV_CLIENT },
    { name: 'TeamSection',        src: TEAM },
  ];

  it.each(NO_GROSS_TOGGLE_FILES)('$name has no useState<\'gross\' | \'net\'>', ({ src }) => {
    expect(src).not.toMatch(/useState<'gross' \| 'net'>/);
  });

  it.each(NO_GROSS_TOGGLE_FILES)('$name has no gross-mode testids', ({ src }) => {
    expect(src).not.toMatch(/group-mode-gross/);
    expect(src).not.toMatch(/group-mode-net/);
    expect(src).not.toMatch(/branch-mode-gross/);
    expect(src).not.toMatch(/branch-mode-net/);
    expect(src).not.toMatch(/revenue-toggle-gross/);
    expect(src).not.toMatch(/revenue-toggle-net/);
  });

  it('GroupDashboard hero shows totalNet (not a mode-dependent value)', () => {
    expect(GROUP_DASH).toMatch(/formatRand\(summary\.totalNet\)/);
    expect(GROUP_DASH).not.toMatch(/mode === 'gross' \? summary\.totalGross/);
  });

  it('BranchPerformance hero shows totalNet', () => {
    expect(PERF).toMatch(/formatRand\(totalNet\)/);
  });

  it('The label "net of commission" appears once on GroupDashboard hero and BranchPerformance', () => {
    expect(GROUP_DASH).toMatch(/net of commission/);
    expect(PERF).toMatch(/net of commission/);
  });

  it('BrandMonthlyChart still ACCEPTS a mode prop (kept for the practice-side chart which passes net explicitly), defaulting to net', () => {
    // The practice-side MonthlyRevenueChart delegates here with
    // mode="net". Keep the API for that caller; brand callers omit.
    expect(CHART).toMatch(/mode\?:\s*'gross' \| 'net'/);
    expect(CHART).toMatch(/mode = 'net'/);
  });
});

// ─── Filter clamping + hero+strip follow filters ──────────────────────

describe('GroupDashboard — chart filters (practice / doctor / range) drive hero + trend + strip', () => {
  it('renders all three filter controls with expected testids', () => {
    expect(GROUP_DASH).toMatch(/data-testid="group-filter-practice"/);
    expect(GROUP_DASH).toMatch(/data-testid="group-filter-provider"/);
    // Range presets are rendered via a template literal
    // `group-filter-range-${m}m` over the [3, 6, 12] preset list — pin
    // that shape rather than the three concrete testids.
    expect(GROUP_DASH).toMatch(/data-testid={`group-filter-range-\$\{m\}m`}/);
  });

  it('filter IDs clamp against the caller\'s own group data (never URL-trusted)', () => {
    // The client builds Sets from the caller's own lists and clamps
    // the state value against them.
    expect(GROUP_DASH).toMatch(/validPracticeIds/);
    expect(GROUP_DASH).toMatch(/validProviderIds/);
    expect(GROUP_DASH).toMatch(/\.has\(practiceFilter\)/);
    expect(GROUP_DASH).toMatch(/\.has\(providerFilter\)/);
  });

  it('the hero total, chart AND by-doctor list all consume the SAME filtered plans (single filter state)', () => {
    // The revenue section passes filteredPlans to computeRevenue AND
    // buildMonthlySeries — one source of truth.
    expect(GROUP_DASH).toMatch(/filteredPlans/);
    expect(GROUP_DASH).toMatch(/computeRevenue\(filteredPlans/);
    expect(GROUP_DASH).toMatch(/buildMonthlySeries\(filteredPlans/);
    // By-doctor reads `summary`, which IS computeRevenue over filteredPlans.
    expect(GROUP_DASH).toMatch(/\[\.\.\.summary\.byProvider\]/);
  });

  it('the strip that used to be the third consumer is GONE, not merely unwired', () => {
    // It was the one piece that made Overview a second, richer copy of a
    // practice dashboard. Asserting its absence — rather than deleting the
    // pin — is what stops it drifting back in: nothing on it was lost (see
    // GroupDashboard's header for where each column went), so a
    // reappearance would be a regression, not a feature.
    expect(GROUP_DASH).not.toMatch(/branch-strip/);
    expect(GROUP_DASH).not.toMatch(/perBranchNet/);
    expect(GROUP_DASH).not.toMatch(/sortedBranches/);
    expect(GROUP_DASH).not.toMatch(/Practice performance/);
  });

  it('the PAYOUT block is NOT wired to the filters — a filtered payout is money nobody is owed', () => {
    // The sharpest thing this restructure has to get right. The revenue
    // section narrows an analysis by practice / doctor / date range; the
    // payout figures are what a bank will actually transfer. Passing them
    // through the same filter state would produce an amount that reconciles
    // against nothing.
    //
    // Structural, not stylistic: the payout block is a SERVER component
    // rendered by page.tsx as a sibling of GroupDashboard, so the filter
    // state (useState inside GroupDashboard) is not in scope for it at all.
    // Comments stripped first. The file's own prose NAMES computeRevenue, in
    // order to say that the plan count is taken from it unfiltered — the same
    // distinction monthly-revenue-chart.test.ts draws for 'pending_acceptance'.
    // What must not exist is a real dependency in the code.
    const code = stripComments(PAYOUT_BLOCK);
    expect(code).not.toMatch(/'use client'/);
    expect(code).not.toMatch(/useState|useMemo/);
    expect(code).not.toMatch(/filteredPlans|computeRevenue\(|buildMonthlySeries/);

    // And the page renders it OUTSIDE GroupDashboard, above it.
    const payoutMount = PAGE.indexOf('<BrandPayoutBlock');
    const dashMount   = PAGE.indexOf('<GroupDashboard');
    expect(payoutMount).toBeGreaterThan(0);
    expect(dashMount).toBeGreaterThan(payoutMount);
  });

  it('range presets are 3 / 6 / 12 months only', () => {
    expect(GROUP_DASH).toMatch(/RangeMonths = 3 \| 6 \| 12/);
    expect(GROUP_DASH).toMatch(/\[3, 6, 12\] as const/);
  });

  it('date cutoff at 12-month default is null (no filtering; the whole 12-month window shows)', () => {
    expect(GROUP_DASH).toMatch(/rangeMonths === 12\) return null/);
  });

  it('Clear-all button resets to defaults', () => {
    expect(GROUP_DASH).toMatch(/data-testid="group-filter-clear"/);
    expect(GROUP_DASH).toMatch(/setPracticeFilter\(''\)/);
    expect(GROUP_DASH).toMatch(/setProviderFilter\(''\)/);
    expect(GROUP_DASH).toMatch(/setRangeMonths\(12\)/);
  });
});

// ─── Unit: filter application on the client's shared helpers ──────────

describe('Filter application — filtered plans through computeRevenue + buildMonthlySeries', () => {
  const NOW = new Date('2026-07-15T00:00:00Z');
  const practices: RevenuePractice[] = [
    { id: 'p1', name: 'Branch A', fee_percent: 10 },
    { id: 'p2', name: 'Branch B', fee_percent: 20 },
  ];
  const feeByPractice = new Map([['p1', 10], ['p2', 20]]);
  const plans: Array<RevenuePlan & { created_at: string }> = [
    { id: '1', practice_id: 'p1', provider_member_id: 'd1', total_amount: 1000, status: 'active',    created_at: '2026-07-01T10:00:00Z' },
    { id: '2', practice_id: 'p1', provider_member_id: 'd2', total_amount:  500, status: 'active',    created_at: '2026-07-02T10:00:00Z' },
    { id: '3', practice_id: 'p2', provider_member_id: 'd1', total_amount:  800, status: 'active',    created_at: '2026-06-01T10:00:00Z' },
    { id: '4', practice_id: 'p1', provider_member_id: 'd1', total_amount:  200, status: 'active',    created_at: '2026-01-10T10:00:00Z' }, // 6+ months ago
  ];

  function cutoffFor(rangeMonths: 3 | 6 | 12) {
    if (rangeMonths === 12) return null;
    const d = new Date(NOW);
    d.setMonth(d.getMonth() - rangeMonths);
    d.setDate(1); d.setHours(0, 0, 0, 0);
    return d;
  }
  function applyFilters(
    ps: typeof plans,
    practiceId: string | null, providerId: string | null, rangeMonths: 3 | 6 | 12,
  ) {
    const cutoff = cutoffFor(rangeMonths);
    return ps.filter((p) => {
      if (practiceId && p.practice_id !== practiceId) return false;
      if (providerId && p.provider_member_id !== providerId) return false;
      if (cutoff && new Date(p.created_at) < cutoff) return false;
      return true;
    });
  }

  it('practice filter narrows revenue to that branch', () => {
    const f = applyFilters(plans, 'p1', null, 12);
    const s = computeRevenue(f, practices, [], {});
    // Branch A active plans: 1000 + 500 + 200 = 1700 gross
    expect(s.totalGross).toBeCloseTo(1700, 2);
  });

  it('doctor filter narrows revenue to that provider', () => {
    const f = applyFilters(plans, null, 'd1', 12);
    const s = computeRevenue(f, practices, [], {});
    // d1's plans: 1000 (p1) + 800 (p2) + 200 (p1) = 2000 gross
    expect(s.totalGross).toBeCloseTo(2000, 2);
  });

  it('range = 3 months excludes the 6-months-ago plan', () => {
    const f = applyFilters(plans, null, null, 3);
    const s = computeRevenue(f, practices, [], {});
    // 3-month window from 2026-07-15 = cutoff 2026-04-01. Excludes
    // 2026-01 plan (200). Include 1000 + 500 + 800 = 2300.
    expect(s.totalGross).toBeCloseTo(2300, 2);
  });

  it('filters combine AND (practice=p1 + doctor=d1 + 3-month window)', () => {
    const f = applyFilters(plans, 'p1', 'd1', 3);
    const s = computeRevenue(f, practices, [], {});
    // Only plan 1 matches: p1 + d1 + within 3 months → 1000 gross.
    expect(s.totalGross).toBeCloseTo(1000, 2);
  });

  it('buildMonthlySeries respects the same filtered subset', () => {
    const f = applyFilters(plans, null, null, 3);
    const series = buildMonthlySeries(f as PlanForTrend[], feeByPractice, NOW);
    // Current month (2026-07): 1000 + 500 = 1500 gross. Previous
    // (2026-06): 800. Earlier months: 0 (either no plans, or
    // filtered out by the 3-month window).
    expect(series[11].gross).toBeCloseTo(1500, 2);
    expect(series[10].gross).toBeCloseTo(800, 2);
    expect(series[6].gross).toBeCloseTo(0, 2);
  });
});

// ─── Team actions — guard-first, allowlist, brick-prevention ──────────

describe('Team actions — guard-first + memberId → practice → group resolve', () => {
  it('guardBrandAdminOfMember exists and reads member→practice→group_members', () => {
    expect(ACTIONS).toMatch(/async function guardBrandAdminOfMember/);
    expect(ACTIONS).toMatch(/\.from\('practice_members'\)/);
    expect(ACTIONS).toMatch(/practices!inner \( group_id \)/);
    expect(ACTIONS).toMatch(/\.from\('practice_group_members'\)/);
  });

  it('addTeamMember guards on target practice BEFORE calling inviteMemberIntoPractice', () => {
    const fnStart = ACTIONS.indexOf('export async function addTeamMember');
    expect(fnStart).toBeGreaterThan(0);
    const body = ACTIONS.slice(fnStart);
    const guardIdx  = body.indexOf('guardBrandAdminOfPractice(');
    const inviteIdx = body.indexOf('inviteMemberIntoPractice(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(inviteIdx).toBeGreaterThan(guardIdx);
  });

  it.each(['updateTeamMember', 'deactivateTeamMember', 'reactivateTeamMember'])(
    '%s guards on the memberId BEFORE any write',
    (fnName) => {
      const fnStart = ACTIONS.indexOf(`export async function ${fnName}`);
      const body = ACTIONS.slice(fnStart);
      const guardIdx  = body.indexOf('guardBrandAdminOfMember(');
      const updateIdx = body.indexOf('.update(');
      expect(guardIdx).toBeGreaterThan(0);
      expect(updateIdx).toBeGreaterThan(guardIdx);
    },
  );
});

describe('Team actions — allowlist (no locked columns in any UPDATE)', () => {
  const FORBIDDEN = [
    'status',
    'fee_percent',
    'owner_id',
    'group_id',
    'sa_id_number',
    'email',
    'role',
    'payout_destination',
    'personal_bank_name',
    'personal_account_holder',
    'personal_account_number',
    'personal_branch_code',
    'personal_account_type',
  ];

  it('updateTeamMember payload only writes {specialty, hpcsa_number, can_manage_practice, can_create_bills}', () => {
    const fnStart = ACTIONS.indexOf('export async function updateTeamMember');
    const nextExport = ACTIONS.indexOf('\nexport async function', fnStart + 20);
    const scope = nextExport > 0 ? ACTIONS.slice(fnStart, nextExport) : ACTIONS.slice(fnStart);
    // The payload is built via `const payload: Record<...> = { ... }`
    // then `.update(payload)`. Extract the literal.
    const m = scope.match(/const payload:[\s\S]*?=\s*\{([\s\S]*?)\};/);
    expect(m).not.toBeNull();
    const literal = (m?.[1] ?? '');
    for (const col of FORBIDDEN) {
      expect(literal).not.toMatch(new RegExp(`\\b${col}\\s*:`));
    }
    // Positive: contains the four allowed columns.
    expect(scope).toMatch(/can_manage_practice:\s*input\.canManagePractice/);
    expect(scope).toMatch(/can_create_bills:\s*input\.canCreateBills/);
    expect(scope).toMatch(/payload\.specialty\s*=/);
    expect(scope).toMatch(/payload\.hpcsa_number\s*=/);
  });

  it.each(['deactivateTeamMember', 'reactivateTeamMember'])('%s only touches active', (fnName) => {
    const fnStart = ACTIONS.indexOf(`export async function ${fnName}`);
    const nextExport = ACTIONS.indexOf('\nexport async function', fnStart + 20);
    const scope = nextExport > 0 ? ACTIONS.slice(fnStart, nextExport) : ACTIONS.slice(fnStart);
    const m = scope.match(/\.update\(\s*\{([\s\S]*?)\}\s*\)/);
    expect(m).not.toBeNull();
    const payload = (m?.[1] ?? '');
    for (const col of FORBIDDEN) {
      expect(payload).not.toMatch(new RegExp(`\\b${col}\\s*:`));
    }
    expect(payload).toMatch(/\bactive\s*:/);
  });
});

describe('Brick-prevention — every practice needs at least one active admin', () => {
  it('countActiveManagersExcept helper exists (indexed lookup on active + can_manage_practice)', () => {
    expect(ACTIONS).toMatch(/countActiveManagersExcept/);
    expect(ACTIONS).toMatch(/\.eq\('active', true\)/);
    expect(ACTIONS).toMatch(/\.eq\('can_manage_practice', true\)/);
    expect(ACTIONS).toMatch(/\.neq\('id', excludeMemberId\)/);
  });

  it('LAST_ADMIN_ERROR uses the required clear wording', () => {
    expect(ACTIONS).toMatch(/Every practice needs at least one active admin/);
  });

  it('deactivateTeamMember calls countActiveManagersExcept when target is an active admin', () => {
    const fnStart = ACTIONS.indexOf('export async function deactivateTeamMember');
    const body = ACTIONS.slice(fnStart);
    expect(body).toMatch(/target\.can_manage_practice/);
    expect(body).toMatch(/countActiveManagersExcept\(/);
    expect(body).toMatch(/LAST_ADMIN_ERROR/);
  });

  it('updateTeamMember refuses to flip can_manage_practice → false when target is the only admin', () => {
    const fnStart = ACTIONS.indexOf('export async function updateTeamMember');
    const body = ACTIONS.slice(fnStart);
    expect(body).toMatch(/input\.canManagePractice === false/);
    expect(body).toMatch(/countActiveManagersExcept\(/);
    expect(body).toMatch(/LAST_ADMIN_ERROR/);
  });

  it('the UI in TeamSection surfaces the same wording near the last-admin toggle', () => {
    expect(TEAM).toMatch(/Every practice needs at least one active admin/);
  });

  it('the deactivate button on the last-admin row is disabled with a title tooltip', () => {
    expect(TEAM).toMatch(/disabled=\{isPending \|\| isOnlyAdmin\}/);
    expect(TEAM).toMatch(/title=\{isOnlyAdmin \?/);
  });
});

describe('addTeamMember + shared invite implementation', () => {
  it('lib/brand/inviteMember still exports inviteMemberIntoPractice', () => {
    expect(INVITE).toMatch(/export async function inviteMemberIntoPractice/);
  });

  it('brand addTeamMember delegates to inviteMemberIntoPractice (no inline auth.admin.invite)', () => {
    const fnStart = ACTIONS.indexOf('export async function addTeamMember');
    const nextExport = ACTIONS.indexOf('\nexport async function', fnStart + 20);
    const scope = nextExport > 0 ? ACTIONS.slice(fnStart, nextExport) : ACTIONS.slice(fnStart);
    expect(scope).toMatch(/inviteMemberIntoPractice\(/);
    expect(scope).not.toMatch(/auth\.admin\.inviteUserByEmail/);
  });

  it('practice-admin addMember still delegates to the shared helper', () => {
    expect(MEMBERS_ACT).toMatch(/inviteMemberIntoPractice\(/);
    const addStart = MEMBERS_ACT.indexOf('export async function addMember');
    const nextExport = MEMBERS_ACT.indexOf('\nexport async function', addStart + 20);
    const scope = nextExport > 0 ? MEMBERS_ACT.slice(addStart, nextExport) : MEMBERS_ACT.slice(addStart);
    expect(scope).not.toMatch(/auth\.admin\.inviteUserByEmail/);
  });

  it('addTeamMember does NOT re-check HPCSA at the caller (the shared helper checks)', () => {
    const fnStart = ACTIONS.indexOf('export async function addTeamMember');
    const nextExport = ACTIONS.indexOf('\nexport async function', fnStart + 20);
    const scope = nextExport > 0 ? ACTIONS.slice(fnStart, nextExport) : ACTIONS.slice(fnStart);
    expect(scope).not.toMatch(/checkHpcsa\s*\(/);
  });
});

// ─── Shared AddMemberForm — one form, two surfaces ────────────────────

describe('Shared AddMemberForm — imported by BOTH practice and brand surfaces', () => {
  it('practice MembersView imports AddMemberForm', () => {
    expect(MEMBERS_VIEW).toMatch(/from ['"]\.\/AddMemberForm['"]/);
    expect(MEMBERS_VIEW).toMatch(/<AddMemberForm/);
  });

  it('brand TeamSection imports the same AddMemberForm', () => {
    expect(TEAM).toMatch(/from ['"]@\/app\/practice\/members\/AddMemberForm['"]/);
    expect(TEAM).toMatch(/<AddMemberForm/);
  });

  it('both surfaces render the shared specialty vocabulary, not their own copy', () => {
    // The list moved out of AddMemberForm into lib/specialties.ts,
    // reaching every dropdown through <SpecialtyOptions> — four files
    // needed it, which made this form the wrong owner.
    expect(ADD_FORM).not.toMatch(/const SPECIALTIES = \[/);
    for (const src of [ADD_FORM, MEMBERS_VIEW, TEAM]) {
      expect(src).toMatch(/from ['"]@\/components\/SpecialtyOptions['"]/);
      expect(src).toMatch(/<SpecialtyOptions/);
      expect(src).not.toMatch(/const SPECIALTIES = \[/);
    }
    expect(MEMBERS_VIEW).toMatch(/from ['"]\.\/AddMemberForm['"]/);
  });

  it('BANKS is still exported, though nothing consumes it now', () => {
    // It only ever fed the per-provider personal-banking sub-form, which was
    // removed with the provider payout destination (migration 0090). Kept
    // because it is the codebase's only canonical SA bank list and the
    // practice banking form on /practice/details is free-text that should
    // arguably use it. Deleting it is a separate decision.
    expect(ADD_FORM).toMatch(/export const BANKS/);
  });

  it('practice-side passes saIdRequired=true; brand-side passes saIdRequired=false', () => {
    expect(MEMBERS_VIEW).toMatch(/saIdRequired=\{true\}/);
    expect(TEAM).toMatch(/saIdRequired=\{false\}/);
  });

  it('NEITHER surface offers payout fields — the prop is gone, not just false', () => {
    // Was: practice-side showPayoutFields={true}, brand-side {false}. The
    // per-provider payout destination is removed (one practice = one bank
    // account = one deposit — migration 0090), so the prop went with it
    // rather than lingering as dead API surface that could be switched on.
    // Comments stripped first: these files legitimately record in prose what
    // used to be here and why it went, which is worth keeping.
    for (const src of [ADD_FORM, MEMBERS_VIEW, TEAM]) {
      expect(stripComments(src, { jsxBraces: true })).not.toMatch(/showPayoutFields/);
    }
    // And the sub-form it gated is gone from the shared component.
    const addFormCode = stripComments(ADD_FORM);
    expect(addFormCode).not.toMatch(/payoutDestination/);
    expect(addFormCode).not.toMatch(/personalAccountNumber/);
  });

  it('AddMemberForm has role picker with the two expected options', () => {
    // Role testids are rendered via a template literal
    // `add-member-role-${opt.value}` over ['provider', 'manager'].
    expect(ADD_FORM).toMatch(/data-testid={`add-member-role-\$\{opt\.value\}`}/);
    expect(ADD_FORM).toMatch(/value: 'provider' as const/);
    expect(ADD_FORM).toMatch(/value: 'manager' as const/);
  });
});

// ─── Single entry — no /practice?practiceId= link on brand surface ────

describe('Single entry point — the pivot is the only doorway from the brand surface', () => {
  it('no brand surface writes a /practice?practiceId= doorway of its own', () => {
    // Unchanged rule, now enforced across every surface that carries a
    // per-practice link rather than only the retired strip. The pivot
    // (/brand/branch/[id]) sets ?practiceId= itself; a second hand-written
    // /practice URL is a second entry point to keep in step.
    for (const [name, src] of [
      ['GroupDashboard',  GROUP_DASH],
      ['BrandPayoutBlock', PAYOUT_BLOCK],
      ['PracticesTable',   SETUP_TABLE],
    ] as const) {
      expect(src, name).not.toMatch(/href=\{`\/practice\?practiceId=/);
      expect(src, name).not.toMatch(/href="\/practice\?practiceId=/);
      expect(src, name).not.toMatch(/Practice dashboard/);
    }
  });

  it('the drilldown link is present on BOTH surfaces that list practices', () => {
    // Relocated from the strip. The payout rows are Overview's doorways and
    // the Practices table's name column is the other; both go through the
    // pivot, and neither invents its own destination.
    expect(PAYOUT_BLOCK).toMatch(/href=\{`\/brand\/branch\/\$\{row\.practiceId\}`\}/);
    expect(SETUP_TABLE).toMatch(/href=\{`\/brand\/branch\/\$\{p\.practiceId\}`\}/);
  });

  it('GroupDashboard no longer links anywhere — it is a revenue section now', () => {
    expect(GROUP_DASH).not.toMatch(/from 'next\/link'/);
    expect(GROUP_DASH).not.toMatch(/<Link/);
  });
});

// ─── Till devices entry point — missing-entry-point fix ────────────────
//
// Till/PIN admin (/practice/pos/devices) was previously reachable from
// the brand branch strip only by typing the URL directly. Each branch
// card now carries a second, parallel link, parameterised by that
// branch's own id — "Brand user overseeing branch X sees a link to X's
// device admin" is true by construction here since GroupDashboard only
// ever receives `branches` already scoped to the caller's own groups
// (see the brand/page.tsx query-scoping test above,
// `.in('group_id', groupIds)`) — a branch the caller does NOT oversee
// never reaches this component at all, so there is no per-branch runtime
// check to test here; the scoping test already covers "no link for a
// branch you don't oversee".

describe('Till devices link — parameterised per practice, now in the Practices table', () => {
  it('renders a till-devices link scoped to each practice id', () => {
    // RELOCATED, not weakened: the link moved off the retired strip and onto
    // the Practices table's till column, which is where the till's STATE is
    // now reported. Same href shape, same per-practice scoping, and the same
    // "you only ever see practices you oversee" guarantee — the table is fed
    // by resolveBrandViewer, whose .in('group_id', …) is built from the
    // caller's own membership rows.
    expect(SETUP_TABLE).toMatch(/data-testid=\{`brand-practice-till-link-\$\{p\.practiceId\}`\}/);
    expect(SETUP_TABLE).toMatch(/href=\{`\/practice\/pos\/devices\?practiceId=\$\{p\.practiceId\}`\}/);
  });

  it('the till column reports STATE as well as offering the link', () => {
    // The link on its own was the old strip's entire contribution. The point
    // of moving it is that a brand admin can now see whether the till is set
    // up before deciding to click.
    expect(SETUP_TABLE).toMatch(/Front desk till/);
    expect(SETUP_TABLE).toMatch(/Registered · PIN set/);
    expect(SETUP_TABLE).toMatch(/Registered · no PIN/);
  });
});

// ─── The branch page became a pivot; what happened to its sections ────
//
// /brand/branch/[practiceId] was doing double duty — a multi-branch
// PERFORMANCE view AND the de-facto practice SETTINGS page — and it sat
// outside the /practice tree, so PracticeShell never wrapped it. It now
// redirects into the practice's own dashboard. Its sections went:
//
//   performance + by-doctor → /brand (this file's own by-doctor pins
//                             below cover the new home)
//   details + banking       → /practice/details
//   team                    → /practice/members
//
// BranchPerformance.tsx and TeamSection.tsx are deliberately KEPT on
// disk, unmounted, rather than deleted:
//   • BranchPerformance's content is fully reproduced at /brand (hero
//     net, trend, and now the by-doctor list) — the file is redundant,
//     not load-bearing.
//   • TeamSection is the one section whose removal is NOT purely
//     redundant. /practice/members covers it for any brand-admin holding
//     a practice_members row — which createBranch always creates
//     (role='admin', can_manage_practice=true), so it covers every brand
//     admin the product itself makes. A brand-admin with NO such row
//     reads the roster there but gets no editing UI, because
//     app/practice/members/actions.ts guardManager() is
//     can_manage_practice-only. Keeping the component and its four
//     still-guarded actions means covering that case later is a mount,
//     not a rewrite.

describe('the branch page is now a pivot into the practice dashboard', () => {
  it('DoctorsSection.tsx no longer exists (unchanged)', () => {
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/DoctorsSection.tsx'))).toBe(false);
  });

  it('redirects to the practice dashboard carrying the branch id', () => {
    expect(BRANCH_PAGE).toMatch(/redirect\(`\/practice\?practiceId=\$\{encodeURIComponent\(practiceId\)\}`\)/);
  });

  it('renders nothing itself — no sections, no data reads, no service-role client', () => {
    expect(BRANCH_PAGE).not.toMatch(/<TeamSection/);
    expect(BRANCH_PAGE).not.toMatch(/<BranchPerformance/);
    expect(BRANCH_PAGE).not.toMatch(/<BranchDetailsForm/);
    expect(BRANCH_PAGE).not.toMatch(/<BranchBankingForm/);
    expect(BRANCH_PAGE).not.toMatch(/createServiceClient/);
    expect(BRANCH_PAGE).not.toMatch(/computeRevenue/);
  });

  it('does NOT re-implement its own authorization gate', () => {
    // Authorization belongs to the destination: /practice resolves the
    // viewer via practiceViewer.ts, which authorises an explicit
    // ?practiceId= by an active practice_members row OR an active
    // practice_group_members row for the practice's group, and
    // notFound()s anything else. A narrower duplicate gate here is what
    // made the brand-admin path 404 on /practice/pos/devices once before.
    // Comments stripped first — the file explains the delegation in prose,
    // naming both notFound() and practice_group_members. What must not
    // exist is a real gate in the code.
    const code = stripComments(BRANCH_PAGE);
    expect(code).not.toMatch(/notFound\(/);
    expect(code).not.toMatch(/practice_group_members/);

    const VIEWER = read('app/practice/practiceViewer.ts');
    expect(VIEWER).toMatch(/practice_group_members/);
    expect(VIEWER).toMatch(/kind: 'denied'/);
  });

  it('the route still EXISTS so every inbound link resolves (no 404s)', () => {
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/page.tsx'))).toBe(true);
    // Both of Overview's and the Practices table's doorways still point here,
    // as do the revalidatePath calls in app/brand/actions.ts. The pin moved
    // off GroupDashboard with the strip; the route's obligation is unchanged.
    expect(PAYOUT_BLOCK).toMatch(/\/brand\/branch\//);
    expect(SETUP_TABLE).toMatch(/\/brand\/branch\//);
    expect(ACTIONS).toMatch(/\/brand\/branch\//);
  });

  it('the two unmounted components are still on disk, ready to re-home', () => {
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/TeamSection.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/BranchPerformance.tsx'))).toBe(true);
    // And the four brand-side team actions they need are untouched.
    expect(ACTIONS).toMatch(/export async function addTeamMember/);
    expect(ACTIONS).toMatch(/export async function updateTeamMember/);
    expect(ACTIONS).toMatch(/export async function deactivateTeamMember/);
    expect(ACTIONS).toMatch(/export async function reactivateTeamMember/);
  });

  it('the details + banking forms moved to /practice/details, not copied', () => {
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/BranchDetailsForm.tsx'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/BranchBankingForm.tsx'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'app/practice/details/BranchDetailsForm.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/practice/details/BranchBankingForm.tsx'))).toBe(true);
  });
});

// ─── By doctor moved to /brand — the ONE view the pivot would have lost ─
//
// /brand/branch/[practiceId] was the only place a per-doctor ranked list
// was rendered. /brand had a doctor FILTER but no breakdown, and the
// practice dashboard has a provider filter but no breakdown either — so
// you could read one doctor's total at a time and never see them ranked.
// computeRevenue has always returned byProvider; it was simply unused on
// the group screen.

describe('GroupDashboard renders the per-doctor breakdown the branch page used to own', () => {
  it('renders a ranked by-doctor list from the already-computed byProvider rows', () => {
    expect(GROUP_DASH).toMatch(/summary\.byProvider/);
    expect(GROUP_DASH).toMatch(/group-doctor-breakdown/);
    expect(GROUP_DASH).toMatch(/By doctor/);
  });

  it('ranks by net descending — same ordering the branch page used', () => {
    expect(GROUP_DASH).toMatch(/sort\(\(a, b\) => b\.net - a\.net\)/);
  });

  it('has an empty state rather than a bare heading', () => {
    expect(GROUP_DASH).toMatch(/group-doctor-breakdown-empty/);
    expect(GROUP_DASH).toMatch(/No plans attributed to a doctor yet/);
  });

  it('follows the SAME filter state as the hero and trend', () => {
    // It reads `summary`, which is computeRevenue over filteredPlans —
    // so setting the Practice filter reproduces exactly the per-branch
    // list the branch page gave, and leaving it clear ranks across
    // branches, which the branch page could not do.
    expect(GROUP_DASH).toMatch(/const sortedDoctors = useMemo\(\s*\n?\s*\(\) => \[\.\.\.summary\.byProvider\]/);
    expect(GROUP_DASH).toMatch(/computeRevenue\(filteredPlans/);
  });

  it('stays NET-only, like every other figure on the brand surface', () => {
    const idx = GROUP_DASH.indexOf('group-doctor-breakdown');
    const block = GROUP_DASH.slice(idx, idx + 900);
    expect(block).toMatch(/formatRand\(d\.net\)/);
    expect(block).not.toMatch(/d\.gross/);
  });

  it('the header copy no longer promises per-doctor performance behind a tap', () => {
    // It used to read "Tap a practice to see per-doctor performance and
    // manage its team" — both halves became false when the branch page
    // stopped rendering either.
    expect(GROUP_DASH).not.toMatch(/Tap a practice to see per-doctor performance/);
    expect(GROUP_DASH).toMatch(/Per-doctor performance is below/);
  });
});

// ─── n=1 unchanged; brand data scoping ────────────────────────────────

describe('/brand page — scoping + n=1 rule unchanged', () => {
  it('resolves the caller\'s own brand memberships before any data query', () => {
    // RELOCATED, not weakened. This used to look for the literal
    // from('practice_group_members') in this page; the four-line read is now the
    // shared resolveBrandGroupIds (lib/brand/brandViewer), which every brand
    // screen calls. The invariant is identical — authority first, data second —
    // and it is still asserted on THIS page's ordering.
    const idxMember = PAGE.indexOf('resolveBrandGroupIds(supabase, user.id)');
    const idxPlans  = PAGE.indexOf("from('plans')");
    expect(idxMember).toBeGreaterThan(0);
    expect(idxPlans).toBeGreaterThan(idxMember);
    // And the read still goes through the caller's OWN client, not service-role
    // — which is the half of the invariant that actually gates anything.
    expect(PAGE).not.toMatch(/resolveBrandGroupIds\(s,/);
  });

  it('filters practices + plans on the caller\'s OWN group_ids — never URL-supplied', () => {
    expect(PAGE).toMatch(/\.in\('group_id', groupIds\)/);
    expect(PAGE).not.toMatch(/searchParams\.group\b/);
    expect(PAGE).not.toMatch(/searchParams\.practice/);
  });

  it('preserves the n=1 redirect (single-branch → /practice)', () => {
    expect(PAGE).toMatch(/branchRows\.length === 1[\s\S]*?redirect\(`\/practice\?practiceId=/);
  });

  it('sends RAW plans + provider list to the client (client owns filtering)', () => {
    expect(PAGE).toMatch(/plans=\{plans\}/);
    expect(PAGE).toMatch(/providers=\{providers\}/);
    expect(PAGE).toMatch(/branches=\{branches\}/);
  });

  it('does NOT pull payment/collection state (mirrors the /brand/revenue discipline)', () => {
    expect(PAGE).not.toMatch(/from\(['"]payments['"]\)/);
    expect(PAGE).not.toMatch(/from\(['"]payouts['"]\)/);
    const m = PAGE.match(/\.from\('plans'\)\s*\.select\(\s*['"`]([^'"`]+)['"`]/);
    expect(m).not.toBeNull();
    const selected = (m?.[1] ?? '').toLowerCase();
    for (const forbidden of ['collected', 'remaining', 'instalment', 'mandate', 'paystack']) {
      expect(selected).not.toContain(forbidden);
    }
  });
});

// ─── BrandMonthlyChart is a primitive — no status logic ───────────────

describe('BrandMonthlyChart is a rendering primitive', () => {
  it('does NOT filter plans (no isActiveForRevenue, no status ===, no COUNTED_STATUSES)', () => {
    expect(CHART).not.toMatch(/isActiveForRevenue/);
    expect(CHART).not.toMatch(/COUNTED_STATUSES/);
    expect(CHART).not.toMatch(/status ===/);
  });
});

// ─── Quick-actions layout ─────────────────────────────────────────────

describe('Overview layout — quick actions above the money, money above the analysis', () => {
  // RELOCATED. The rule used to be "quick actions above the revenue hero" and
  // read GroupDashboard, because GroupDashboard was the whole screen. The
  // ordering is now a property of the page that composes three components, so
  // the pin reads the page — and the rule got STRONGER, because there is a
  // third thing in the order now and the payout hero has to be above the
  // analysis, not merely below the actions.

  it('the quick actions tiles survived the move intact', () => {
    // Same testids, same hrefs, same wording — a relocation, not a redesign,
    // and the two things they link to both predate this change.
    expect(QUICK).toMatch(/data-testid="group-quick-actions-top"/);
    expect(QUICK).toMatch(/data-testid="group-add-practice"/);
    expect(QUICK).toMatch(/data-testid="group-settings"/);
    expect(QUICK).toMatch(/href="\/brand\/new-practice"/);
    expect(QUICK).toMatch(/href="\/brand\/group"/);
    // And they are gone from where they used to live, so they cannot render twice.
    expect(GROUP_DASH).not.toMatch(/group-quick-actions-top/);
  });

  it('page.tsx renders quick actions → payouts → revenue, in that order', () => {
    const quick  = PAGE.indexOf('<BrandQuickActions');
    const payout = PAGE.indexOf('<BrandPayoutBlock');
    const dash   = PAGE.indexOf('<GroupDashboard');
    expect(quick).toBeGreaterThan(0);
    expect(payout).toBeGreaterThan(quick);
    expect(dash).toBeGreaterThan(payout);
  });

  it('the revenue hero is still inside the revenue section, below all of it', () => {
    expect(GROUP_DASH).toMatch(/data-testid="group-hero-total"/);
  });
});

// ─── Diff scope — no payment / webhook / finance-math changes ─────────

describe('Diff scope — team + net-only + filters, no payment logic touched', () => {
  const NEW_FILES = [
    'app/practice/members/AddMemberForm.tsx',
    'app/brand/branch/[practiceId]/TeamSection.tsx',
  ];

  it.each(NEW_FILES)('%s exists', (path) => {
    expect(existsSync(resolve(ROOT, path))).toBe(true);
  });

  const FORBIDDEN = [
    '@/lib/payments/',
    '@/lib/paystack/',
    '@/lib/bills/lifecycle',
    'app/api/webhooks/paystack',
  ];

  it.each(FORBIDDEN)('brand/actions.ts does not import %s', (mod) => {
    expect(ACTIONS).not.toContain(`from '${mod}`);
    expect(ACTIONS).not.toContain(`from "${mod}`);
  });

  it.each(FORBIDDEN)('TeamSection does not import %s', (mod) => {
    expect(TEAM).not.toContain(`from '${mod}`);
    expect(TEAM).not.toContain(`from "${mod}`);
  });

  it.each(FORBIDDEN)('AddMemberForm does not import %s', (mod) => {
    expect(ADD_FORM).not.toContain(`from '${mod}`);
    expect(ADD_FORM).not.toContain(`from "${mod}`);
  });
});
