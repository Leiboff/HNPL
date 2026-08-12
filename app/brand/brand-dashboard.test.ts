import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import { buildMonthlySeries, lastTwelveMonthsFrom, type PlanForTrend } from '@/lib/brand/monthlyRevenue';

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

  it('the hero total, chart, AND strip all consume the SAME filtered plans (single filter state)', () => {
    // The dashboard passes filteredPlans to computeRevenue AND
    // buildMonthlySeries — one source of truth.
    expect(GROUP_DASH).toMatch(/filteredPlans/);
    expect(GROUP_DASH).toMatch(/computeRevenue\(filteredPlans/);
    expect(GROUP_DASH).toMatch(/buildMonthlySeries\(filteredPlans/);
    // Strip reads from summary.byPractice via perBranchNet — same
    // filtered summary.
    expect(GROUP_DASH).toMatch(/perBranchNet/);
    // The strip's bucket lookup uses the FILTERED summary, not raw
    // per-branch data.
    expect(GROUP_DASH).toMatch(/for \(const row of summary\.byPractice\) m\.set/);
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

  it('AddMemberForm exports the SPECIALTIES list that both surfaces reuse', () => {
    expect(ADD_FORM).toMatch(/export const SPECIALTIES/);
    // The two surfaces MUST reference the exported list, not
    // hardcode their own copies.
    expect(MEMBERS_VIEW).toMatch(/from ['"]\.\/AddMemberForm['"]/);
    expect(TEAM).toMatch(/SPECIALTIES/);
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
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    for (const src of [ADD_FORM, MEMBERS_VIEW, TEAM]) {
      expect(stripComments(src)).not.toMatch(/showPayoutFields/);
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

describe('Single entry point — only "Open branch" links from the brand surface', () => {
  it('GroupDashboard has NO /practice?practiceId= secondary link', () => {
    expect(GROUP_DASH).not.toMatch(/href=\{`\/practice\?practiceId=/);
    expect(GROUP_DASH).not.toMatch(/href="\/practice\?practiceId=/);
    // The "Practice dashboard" wording is gone from the card.
    expect(GROUP_DASH).not.toMatch(/Practice dashboard/);
  });

  it('the drilldown link testid is still present (Open branch)', () => {
    expect(GROUP_DASH).toMatch(/data-testid={`branch-drilldown-\${b\.id}`}/);
    expect(GROUP_DASH).toMatch(/Open branch/);
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

describe('Till devices link — parameterised per branch, alongside Open branch', () => {
  it('renders a till-devices link scoped to each branch id', () => {
    expect(GROUP_DASH).toMatch(/data-testid={`branch-till-devices-\${b\.id}`}/);
    expect(GROUP_DASH).toMatch(/href={`\/practice\/pos\/devices\?practiceId=\$\{b\.id\}`}/);
    expect(GROUP_DASH).toMatch(/Till devices/);
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
    const code = BRANCH_PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/notFound\(/);
    expect(code).not.toMatch(/practice_group_members/);

    const VIEWER = read('app/practice/practiceViewer.ts');
    expect(VIEWER).toMatch(/practice_group_members/);
    expect(VIEWER).toMatch(/kind: 'denied'/);
  });

  it('the route still EXISTS so every inbound link resolves (no 404s)', () => {
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/page.tsx'))).toBe(true);
    // "Open branch →" on the brand index, and the revalidatePath calls in
    // app/brand/actions.ts, both still point here.
    expect(GROUP_DASH).toMatch(/href=\{`\/brand\/branch\/\$\{b\.id\}`\}/);
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

  it('follows the SAME filter state as the hero, trend and strip', () => {
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
  it('reads practice_group_members for caller before any data query', () => {
    const idxMember = PAGE.indexOf("from('practice_group_members')");
    const idxPlans  = PAGE.indexOf("from('plans')");
    expect(idxMember).toBeGreaterThan(0);
    expect(idxPlans).toBeGreaterThan(idxMember);
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

describe('GroupDashboard layout — quick actions ABOVE revenue hero', () => {
  it('quick actions render BEFORE the hero total in DOM order', () => {
    const quickTop = GROUP_DASH.indexOf('data-testid="group-quick-actions-top"');
    const heroTotal = GROUP_DASH.indexOf('data-testid="group-hero-total"');
    expect(quickTop).toBeGreaterThan(0);
    expect(heroTotal).toBeGreaterThan(0);
    expect(quickTop).toBeLessThan(heroTotal);
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
