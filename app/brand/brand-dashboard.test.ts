import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import { buildMonthlySeries, lastTwelveMonthsFrom, type PlanForTrend } from '@/lib/brand/monthlyRevenue';

// ─── Brand group-dashboard build — source-text + unit tests ────────────
//
// Pins for:
//   • Group dashboard hero = sum of branch revenues (ACTIVE_FOR_REVENUE only).
//   • Toggle flips all figures consistently.
//   • Trend series aggregates only active+completed plans.
//   • Per-branch delta computed from the branch's own monthly series.
//   • Doctor management actions guard FIRST + never touch locked columns.
//   • Shared invite implementation (no fork between practice-admin
//     addMember and brand-admin addDoctor).
//   • Cross-group isolation: memberId → practice → group resolve BEFORE
//     any read/write.
//   • n=1 redirect preserved.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const ACTIONS      = read('app/brand/actions.ts');
const PAGE         = read('app/brand/page.tsx');
const BRANCH_PAGE  = read('app/brand/branch/[practiceId]/page.tsx');
const GROUP_DASH   = read('app/brand/GroupDashboard.tsx');
const PERF         = read('app/brand/branch/[practiceId]/BranchPerformance.tsx');
const DOCTORS      = read('app/brand/branch/[practiceId]/DoctorsSection.tsx');
const CHART        = read('app/brand/BrandMonthlyChart.tsx');
const INVITE       = read('lib/brand/inviteMember.ts');
const MEMBERS_ACT  = read('app/practice/members/actions.ts');
const MONTHLY      = read('lib/brand/monthlyRevenue.ts');

// ─── Unit: computeRevenue reconciles hero vs per-branch strip ─────────

describe('Group hero = sum of branch revenues (ACTIVE_FOR_REVENUE only)', () => {
  const practices: RevenuePractice[] = [
    { id: 'p1', name: 'Branch A', fee_percent: 10 },
    { id: 'p2', name: 'Branch B', fee_percent: 15 },
  ];
  const plans: RevenuePlan[] = [
    { id: '1', practice_id: 'p1', provider_id: 'd1', total_amount: 1000, status: 'active' },
    { id: '2', practice_id: 'p1', provider_id: 'd2', total_amount:  500, status: 'completed' },
    { id: '3', practice_id: 'p1', provider_id: 'd1', total_amount:  700, status: 'pending_acceptance' },  // EXCLUDED
    { id: '4', practice_id: 'p2', provider_id: 'd3', total_amount: 2000, status: 'active' },
    { id: '5', practice_id: 'p2', provider_id: 'd3', total_amount:  300, status: 'defaulted' },           // EXCLUDED
  ];
  const summary = computeRevenue(plans, practices, [], {});

  it('totalGross = sum of every branch gross (no pending_acceptance, no defaulted)', () => {
    const perBranchGross = summary.byPractice.reduce((s, r) => s + r.gross, 0);
    expect(perBranchGross).toBeCloseTo(summary.totalGross, 2);
    expect(summary.totalGross).toBeCloseTo(1000 + 500 + 2000, 2);   // 3500
  });

  it('totalNet = sum of every branch net', () => {
    const perBranchNet = summary.byPractice.reduce((s, r) => s + r.net, 0);
    expect(perBranchNet).toBeCloseTo(summary.totalNet, 2);
  });

  it('totalCount matches active + completed plans only', () => {
    expect(summary.totalCount).toBe(3);
  });

  it('branch strip is sortable by revenue DESC (helper produces DESC order already)', () => {
    // computeRevenue.byPractice is sorted DESC by gross — the dashboard
    // resorts by selected mode, but the initial order matches gross.
    expect(summary.byPractice[0].gross).toBeGreaterThanOrEqual(summary.byPractice[1].gross);
  });

  it('pending_acceptance contributes nothing to the strip either', () => {
    const branchA = summary.byPractice.find((r) => r.id === 'p1');
    // Branch A active+completed only: 1000 + 500 = 1500 gross.
    expect(branchA?.gross).toBeCloseTo(1500, 2);
  });
});

// ─── Unit: buildMonthlySeries — group series = sum of branch series ───

describe('Monthly trend: group = sum of branch series; mode-consistent', () => {
  const NOW = new Date('2026-06-15T00:00:00Z');   // deterministic reference

  const feeByPractice = new Map<string, number>([['p1', 10], ['p2', 20]]);

  const plans: PlanForTrend[] = [
    // Both plans in current month (2026-06)
    { id: '1', practice_id: 'p1', provider_id: 'd1', total_amount: 1000, status: 'active',    created_at: '2026-06-05T10:00:00Z' },
    { id: '2', practice_id: 'p2', provider_id: 'd2', total_amount:  500, status: 'completed', created_at: '2026-06-10T10:00:00Z' },
    // Previous month (2026-05)
    { id: '3', practice_id: 'p1', provider_id: 'd1', total_amount: 2000, status: 'active',    created_at: '2026-05-05T10:00:00Z' },
    // Excluded — pending_acceptance
    { id: '4', practice_id: 'p1', provider_id: 'd1', total_amount: 9999, status: 'pending_acceptance', created_at: '2026-06-05T10:00:00Z' },
  ];

  it('the last-12-months window is deterministic from a reference date', () => {
    const months = lastTwelveMonthsFrom(NOW);
    expect(months.length).toBe(12);
    expect(months[11]).toEqual({ year: 2026, month: 6, label: 'Jun' });
    expect(months[10]).toEqual({ year: 2026, month: 5, label: 'May' });
  });

  it('group series (all plans) equals sum of per-branch series month-by-month', () => {
    const groupSeries = buildMonthlySeries(plans, feeByPractice, NOW);
    const p1Series = buildMonthlySeries(plans.filter((p) => p.practice_id === 'p1'), feeByPractice, NOW);
    const p2Series = buildMonthlySeries(plans.filter((p) => p.practice_id === 'p2'), feeByPractice, NOW);
    for (let i = 0; i < 12; i += 1) {
      expect(groupSeries[i].gross).toBeCloseTo(p1Series[i].gross + p2Series[i].gross, 2);
      expect(groupSeries[i].net  ).toBeCloseTo(p1Series[i].net   + p2Series[i].net,   2);
    }
  });

  it('pending_acceptance contributes ZERO to every month', () => {
    const series = buildMonthlySeries(plans, feeByPractice, NOW);
    // Current month gross should be 1000 (p1 active) + 500 (p2 completed) = 1500,
    // NOT 1500 + 9999.
    expect(series[11].gross).toBeCloseTo(1500, 2);
  });

  it('imports the shared isActiveForRevenue predicate — not a duplicate filter', () => {
    expect(MONTHLY).toMatch(/isActiveForRevenue/);
    expect(MONTHLY).toMatch(/from ['"]@\/lib\/brand\/revenue['"]/);
  });
});

// ─── Unit: per-doctor breakdown sums to branch total (same mode) ──────

describe('Per-doctor breakdown sums to the branch total in the same mode', () => {
  const practices: RevenuePractice[] = [{ id: 'p1', name: 'Branch A', fee_percent: 10 }];
  const providers: RevenueProvider[] = [
    { id: 'd1', fullName: 'Dr One' },
    { id: 'd2', fullName: 'Dr Two' },
  ];
  const plans: RevenuePlan[] = [
    { id: '1', practice_id: 'p1', provider_id: 'd1', total_amount: 1000, status: 'active'    },
    { id: '2', practice_id: 'p1', provider_id: 'd1', total_amount:  500, status: 'completed' },
    { id: '3', practice_id: 'p1', provider_id: 'd2', total_amount:  700, status: 'active'    },
  ];
  const summary = computeRevenue(plans, practices, providers, {});

  it('sum(byProvider.gross) === totalGross for the branch', () => {
    const sum = summary.byProvider.reduce((s, r) => s + r.gross, 0);
    expect(sum).toBeCloseTo(summary.totalGross, 2);
  });

  it('sum(byProvider.net) === totalNet for the branch', () => {
    const sum = summary.byProvider.reduce((s, r) => s + r.net, 0);
    expect(sum).toBeCloseTo(summary.totalNet, 2);
  });
});

// ─── Doctor actions — guard-first + locked-column absence ─────────────

describe('Brand-admin doctor actions — guard resolves memberId → practice → group BEFORE any write', () => {
  it('guardBrandAdminOfMember exists and reads practice_members + practices + practice_group_members', () => {
    expect(ACTIONS).toMatch(/async function guardBrandAdminOfMember/);
    expect(ACTIONS).toMatch(/\.from\('practice_members'\)/);
    expect(ACTIONS).toMatch(/practices!inner \( group_id \)/);
    expect(ACTIONS).toMatch(/\.from\('practice_group_members'\)/);
  });

  it('addDoctor guards on the target practice BEFORE calling inviteMemberIntoPractice', () => {
    const fnStart = ACTIONS.indexOf('export async function addDoctor');
    expect(fnStart).toBeGreaterThan(0);
    const body = ACTIONS.slice(fnStart);
    const guardIdx  = body.indexOf('guardBrandAdminOfPractice(');
    const inviteIdx = body.indexOf('inviteMemberIntoPractice(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(inviteIdx).toBeGreaterThan(guardIdx);
  });

  it('updateDoctor guards on the memberId BEFORE the update', () => {
    const fnStart = ACTIONS.indexOf('export async function updateDoctor');
    const body = ACTIONS.slice(fnStart);
    const guardIdx  = body.indexOf('guardBrandAdminOfMember(');
    const updateIdx = body.indexOf('.update(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });

  it('deactivateDoctor guards on the memberId BEFORE the update', () => {
    const fnStart = ACTIONS.indexOf('export async function deactivateDoctor');
    const body = ACTIONS.slice(fnStart);
    const guardIdx  = body.indexOf('guardBrandAdminOfMember(');
    const updateIdx = body.indexOf('.update(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });

  it('reactivateDoctor guards on the memberId BEFORE the update', () => {
    const fnStart = ACTIONS.indexOf('export async function reactivateDoctor');
    const body = ACTIONS.slice(fnStart);
    const guardIdx  = body.indexOf('guardBrandAdminOfMember(');
    const updateIdx = body.indexOf('.update(');
    expect(guardIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(guardIdx);
  });
});

describe('Brand-admin doctor actions — locked columns never in any doctor UPDATE payload', () => {
  // Locked administrative fields we must NEVER write from the brand-
  // admin doctor surface. Some are 0054-locked (status, fee_percent
  // — those are on practices, not practice_members, but they matter
  // here as a defence-in-depth pin). Others are membership-domain
  // locks (payout_destination, personal_bank_*, can_manage_practice,
  // can_create_bills, sa_id_number).
  const FORBIDDEN_IN_DOCTOR_UPDATE = [
    'status',
    'fee_percent',
    'owner_id',
    'group_id',
    'can_manage_practice',
    'can_create_bills',
    'payout_destination',
    'personal_bank_name',
    'personal_account_holder',
    'personal_account_number',
    'personal_branch_code',
    'personal_account_type',
    'sa_id_number',
    'email',
    'role',
  ];

  it.each(['updateDoctor'])('%s payload only writes {specialty, hpcsa_number}', (fnName) => {
    const fnStart = ACTIONS.indexOf(`export async function ${fnName}`);
    // Slice from function body to the next top-level export or EOF
    const body = ACTIONS.slice(fnStart);
    const nextExport = body.indexOf('\nexport async function', 20);
    const scope = nextExport > 0 ? body.slice(0, nextExport) : body;
    const m = scope.match(/\.update\(\s*\{([\s\S]*?)\}\s*\)/);
    expect(m).not.toBeNull();
    const payload = (m?.[1] ?? '');
    for (const col of FORBIDDEN_IN_DOCTOR_UPDATE) {
      expect(payload).not.toMatch(new RegExp(`\\b${col}\\s*:`));
    }
    // Positive: must contain specialty and hpcsa_number
    expect(payload).toMatch(/\bspecialty\s*:/);
    expect(payload).toMatch(/\bhpcsa_number\s*:/);
  });

  it.each(['deactivateDoctor', 'reactivateDoctor'])('%s payload only touches active', (fnName) => {
    const fnStart = ACTIONS.indexOf(`export async function ${fnName}`);
    const body = ACTIONS.slice(fnStart);
    const nextExport = body.indexOf('\nexport async function', 20);
    const scope = nextExport > 0 ? body.slice(0, nextExport) : body;
    const m = scope.match(/\.update\(\s*\{([\s\S]*?)\}\s*\)/);
    expect(m).not.toBeNull();
    const payload = (m?.[1] ?? '');
    for (const col of FORBIDDEN_IN_DOCTOR_UPDATE) {
      expect(payload).not.toMatch(new RegExp(`\\b${col}\\s*:`));
    }
    expect(payload).toMatch(/\bactive\s*:/);
  });
});

describe('deactivateDoctor / reactivateDoctor scope to role = provider', () => {
  it('deactivateDoctor refuses roles other than provider', () => {
    const fnStart = ACTIONS.indexOf('export async function deactivateDoctor');
    const body = ACTIONS.slice(fnStart);
    expect(body).toMatch(/role !== 'provider'/);
  });

  it('reactivateDoctor refuses roles other than provider', () => {
    const fnStart = ACTIONS.indexOf('export async function reactivateDoctor');
    const body = ACTIONS.slice(fnStart);
    expect(body).toMatch(/role !== 'provider'/);
  });
});

describe('addDoctor HPCSA validation happens INSIDE the shared invite (not forked at the caller)', () => {
  it('addDoctor forwards hpcsaNumber to inviteMemberIntoPractice without a separate checkHpcsa call', () => {
    const fnStart = ACTIONS.indexOf('export async function addDoctor');
    const nextExport = ACTIONS.indexOf('\nexport async function', fnStart + 20);
    const scope = nextExport > 0 ? ACTIONS.slice(fnStart, nextExport) : ACTIONS.slice(fnStart);
    // addDoctor does NOT re-check HPCSA — the shared helper does.
    expect(scope).not.toMatch(/checkHpcsa\s*\(/);
    expect(scope).toMatch(/hpcsaNumber:\s*input\.hpcsaNumber/);
  });

  it('the shared invite helper checks HPCSA format when supplied', () => {
    expect(INVITE).toMatch(/checkHpcsa\(/);
  });
});

// ─── Shared invite: no fork ────────────────────────────────────────────

describe('Shared invite implementation — practice-admin and brand-admin use ONE path', () => {
  it('lib/brand/inviteMember exports inviteMemberIntoPractice', () => {
    expect(INVITE).toMatch(/export async function inviteMemberIntoPractice/);
  });

  it('practice-admin addMember calls inviteMemberIntoPractice (no local invite)', () => {
    expect(MEMBERS_ACT).toMatch(/inviteMemberIntoPractice\(/);
    // The old inline invite path is gone — no direct auth.admin.invite
    // call inside addMember.
    const addStart = MEMBERS_ACT.indexOf('export async function addMember');
    const nextExport = MEMBERS_ACT.indexOf('\nexport async function', addStart + 20);
    const scope = nextExport > 0 ? MEMBERS_ACT.slice(addStart, nextExport) : MEMBERS_ACT.slice(addStart);
    expect(scope).not.toMatch(/auth\.admin\.inviteUserByEmail/);
    expect(scope).not.toMatch(/\.from\('profiles'\)/);   // duplicate-email check moved into shared
  });

  it('brand-admin addDoctor calls inviteMemberIntoPractice', () => {
    expect(ACTIONS).toMatch(/inviteMemberIntoPractice\(/);
    const addStart = ACTIONS.indexOf('export async function addDoctor');
    const nextExport = ACTIONS.indexOf('\nexport async function', addStart + 20);
    const scope = nextExport > 0 ? ACTIONS.slice(addStart, nextExport) : ACTIONS.slice(addStart);
    expect(scope).not.toMatch(/auth\.admin\.inviteUserByEmail/);
  });

  it('shared invite writes the SAME shape into practice_members as the old inline path', () => {
    // The invite helper inserts a row into practice_members with the
    // exact column set both callers used previously.
    expect(INVITE).toMatch(/\.from\('practice_members'\)/);
    expect(INVITE).toMatch(/\.insert\(/);
    // Core columns must be in the row literal.
    expect(INVITE).toMatch(/practice_id:/);
    expect(INVITE).toMatch(/user_id:/);
    expect(INVITE).toMatch(/role:/);
    expect(INVITE).toMatch(/active:/);
    expect(INVITE).toMatch(/specialty:/);
    expect(INVITE).toMatch(/hpcsa_number:/);
    expect(INVITE).toMatch(/payout_destination:/);
  });
});

// ─── Group dashboard scoping ──────────────────────────────────────────

describe('/brand page — scoped to caller\'s OWN group_ids; never from URL', () => {
  it('reads practice_group_members for the caller before ANY data query', () => {
    const idxMember = PAGE.indexOf("from('practice_group_members')");
    const idxPlans  = PAGE.indexOf("from('plans')");
    const idxBranch = PAGE.indexOf("from('practices')");
    expect(idxMember).toBeGreaterThan(0);
    expect(idxPlans).toBeGreaterThan(idxMember);
    expect(idxBranch).toBeGreaterThan(idxMember);
  });

  it('filters practices + plans on the caller\'s OWN group_ids — never a URL-supplied list', () => {
    expect(PAGE).toMatch(/\.in\('group_id', groupIds\)/);
    expect(PAGE).not.toMatch(/searchParams\.group\b/);
    expect(PAGE).not.toMatch(/params\.group\b/);
    // No practice_id from searchParams either — the dashboard is
    // group-wide, drill-down goes through /brand/branch/[id].
    expect(PAGE).not.toMatch(/searchParams\.practice/);
  });

  it('does NOT pull payment/instalment/collection state', () => {
    expect(PAGE).not.toMatch(/from\(['"]payments['"]\)/);
    expect(PAGE).not.toMatch(/from\(['"]payouts['"]\)/);
    // The plans select should not include collection fields.
    const m = PAGE.match(/\.from\('plans'\)\s*\.select\(\s*['"`]([^'"`]+)['"`]/);
    expect(m).not.toBeNull();
    const selected = (m?.[1] ?? '').toLowerCase();
    for (const forbidden of ['collected', 'remaining', 'instalment', 'mandate', 'paystack']) {
      expect(selected).not.toContain(forbidden);
    }
  });

  it('preserves the n=1 redirect rule to /practice', () => {
    // Two redirects: n=0 → /practice/setup, n=1 → /practice?practiceId=…
    expect(PAGE).toMatch(/branchRows\.length === 0[\s\S]*?redirect\('\/practice\/setup'\)/);
    expect(PAGE).toMatch(/branchRows\.length === 1[\s\S]*?redirect\(`\/practice\?practiceId=/);
  });

  it('handles n=0 memberships by redirecting away', () => {
    expect(PAGE).toMatch(/memberships\.length === 0[\s\S]*?redirect\('\/practice'\)/);
  });
});

// ─── Group dashboard component: single mode state drives every figure ─

describe('GroupDashboard component — single toggle drives hero, trend, and strip', () => {
  it('one `mode` state variable controls every mode-dependent figure', () => {
    // No accidental per-widget mode — a regression that adds a second
    // useState<'gross'|'net'> would introduce a divergence.
    const modeStates = GROUP_DASH.match(/useState<'gross' \| 'net'>/g) ?? [];
    expect(modeStates.length).toBe(1);
  });

  it('the strip sorts by the CURRENT mode (not fixed to gross)', () => {
    expect(GROUP_DASH).toMatch(/mode === 'gross' \? a\.gross : a\.net/);
    expect(GROUP_DASH).toMatch(/mode === 'gross' \? b\.gross : b\.net/);
  });

  it('renders BrandMonthlyChart with the CURRENT mode', () => {
    expect(GROUP_DASH).toMatch(/<BrandMonthlyChart points={monthly} mode={mode}/);
  });

  it('hero label consistently reflects "active plans"', () => {
    expect(GROUP_DASH).toMatch(/Group revenue — active plans/);
  });
});

describe('BranchPerformance component — same single-mode discipline', () => {
  it('one `mode` state variable', () => {
    const modeStates = PERF.match(/useState<'gross' \| 'net'>/g) ?? [];
    expect(modeStates.length).toBe(1);
  });

  it('the doctor breakdown sorts by current mode', () => {
    expect(PERF).toMatch(/mode === 'gross' \? a\.gross : a\.net/);
    expect(PERF).toMatch(/mode === 'gross' \? b\.gross : b\.net/);
  });

  it('renders BrandMonthlyChart with the current mode', () => {
    expect(PERF).toMatch(/<BrandMonthlyChart points={monthly} mode={mode}/);
  });
});

// ─── BrandMonthlyChart primitive ──────────────────────────────────────

describe('BrandMonthlyChart is a rendering primitive — no filtering logic', () => {
  it('does NOT filter plans (no isActiveForRevenue / COUNTED_STATUSES / status checks)', () => {
    // The chart receives already-aggregated MonthPoint[] — a
    // regression that introduces status filtering inside the chart
    // would double-filter (or worse, use a different filter) and
    // fail this pin.
    expect(CHART).not.toMatch(/isActiveForRevenue/);
    expect(CHART).not.toMatch(/COUNTED_STATUSES/);
    expect(CHART).not.toMatch(/status ===/);
  });

  it('accepts a gross|net mode prop', () => {
    expect(CHART).toMatch(/mode:\s+'gross' \| 'net'/);
  });
});

// ─── Doctors section wiring ───────────────────────────────────────────

describe('DoctorsSection — uses the 4 brand-admin actions', () => {
  it('renders add-doctor button + form', () => {
    expect(DOCTORS).toMatch(/data-testid="brand-add-doctor"/);
    expect(DOCTORS).toMatch(/data-testid="brand-add-doctor-form"/);
  });

  it('confirms deactivation before flipping active', () => {
    expect(DOCTORS).toMatch(/confirm\(`Deactivate/);
  });

  it('wires all four actions from app/brand/actions', () => {
    expect(BRANCH_PAGE).toMatch(/addDoctor,\s+updateDoctor,\s+deactivateDoctor,\s+reactivateDoctor/);
  });

  it('separates active vs deactivated in the list', () => {
    expect(DOCTORS).toMatch(/data-testid="brand-doctors-active"/);
    expect(DOCTORS).toMatch(/data-testid="brand-doctors-inactive"/);
  });
});

// ─── Cross-group isolation — no leaks in the dashboard queries ────────

describe('Branch detail page — cross-group isolation preserved', () => {
  it('resolves the practice via service-role BEFORE checking brand-admin membership', () => {
    const idxPractice   = BRANCH_PAGE.indexOf("from('practices')");
    const idxMembership = BRANCH_PAGE.indexOf("from('practice_group_members')");
    expect(idxPractice).toBeGreaterThan(0);
    expect(idxMembership).toBeGreaterThan(idxPractice);
  });

  it('doctor queries scope to the SAME practiceId (never a URL-supplied id)', () => {
    // The practice_members read filters by the resolved practiceId
    // AND by role='provider' (this surface is doctor-only; admin/staff
    // stay on /practice/members).
    expect(BRANCH_PAGE).toMatch(/\.from\('practice_members'\)[\s\S]*?\.eq\('practice_id', practiceId\)[\s\S]*?\.eq\('role', 'provider'\)/);
  });

  it('branch plans query scopes to the resolved practiceId', () => {
    expect(BRANCH_PAGE).toMatch(/\.from\('plans'\)[\s\S]*?\.eq\('practice_id', practiceId\)/);
  });
});
