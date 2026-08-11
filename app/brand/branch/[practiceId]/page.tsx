import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import { buildMonthlySeries, type PlanForTrend } from '@/lib/brand/monthlyRevenue';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import CreateBillButton from '@/app/practice/CreateBillButton';
import {
  updateBranchDetails,
  updateBranchBanking,
  addTeamMember,
  updateTeamMember,
  deactivateTeamMember,
  reactivateTeamMember,
} from '@/app/brand/actions';
import BranchDetailsForm from './BranchDetailsForm';
import BranchBankingForm from './BranchBankingForm';
import BranchPerformance from './BranchPerformance';
import TeamSection, { type TeamMemberRow } from './TeamSection';

// ─── Brand-admin: branch detail (Team + performance + details) ─────────
//
// Three sections top to bottom:
//   1. Performance — net-only branch revenue, 12-month trend, per-doctor breakdown.
//   2. Team — full membership roster (admins + providers), add / edit /
//      deactivate / reactivate. Brick-prevention on last admin.
//   3. Practice details + banking — the existing edit-mode cards.
//
// LOCKED columns stay READ-ONLY at the header (status, fee_percent).

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export default async function BrandBranchEditPage({
  params,
}: {
  params: Promise<{ practiceId: string }>;
}) {
  const { practiceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const s = svc();
  const { data: practice } = await s
    .from('practices')
    .select(`
      id, name, status, group_id,
      phone, fee_percent,
      address_line1, address_line2, suburb, city, practice_province, postal_code,
      latitude, longitude,
      bank_name, bank_account_number, branch_code, account_holder, account_type
    `)
    .eq('id', practiceId)
    .maybeSingle();

  if (!practice) notFound();

  const { data: membership } = await supabase
    .from('practice_group_members')
    .select('user_id')
    .eq('group_id', practice.group_id as string)
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle();
  if (!membership) notFound();

  // ── How many branches does this brand have? ───────────────────────────
  //
  // For a MULTI-branch brand this page's value is cross-branch comparison,
  // so the performance rollup leads. For a SINGLE-branch practice the
  // "brand" and the "branch" are the same entity, so that rollup just
  // restates /practice's own dashboard — while the things the user actually
  // came here for (practice details, banking) sit below it. Same route,
  // audience-appropriate content.
  //
  // A null group_id can't be counted against, so treat it as single.
  const groupId = practice.group_id as string | null;
  let branchCount = 1;
  if (groupId) {
    const { count } = await s
      .from('practices')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId);
    branchCount = count ?? 1;
  }
  const isMultiBranch = branchCount > 1;

  // Plans on this branch (scoped, service-role).
  const { data: rawPlans } = await s
    .from('plans')
    .select('id, practice_id, provider_id, total_amount, status, created_at')
    .eq('practice_id', practiceId)
    .limit(5000);
  const plans = (rawPlans ?? []) as Array<RevenuePlan & { created_at: string }>;

  // Team — ALL members on this practice (any role), active or not.
  // Previously scoped to role='provider'; the Team surface now
  // surfaces admins too.
  const { data: rawMembers } = await s
    .from('practice_members')
    .select(`
      id, active, role, specialty, hpcsa_number,
      can_manage_practice, can_create_bills, user_id,
      profiles ( first_name, last_name, email )
    `)
    .eq('practice_id', practiceId);
  const memberRows = (rawMembers ?? []) as Array<{
    id: string; active: boolean; role: string;
    specialty: string | null; hpcsa_number: string | null;
    can_manage_practice: boolean; can_create_bills: boolean;
    user_id: string;
    profiles: { first_name: string | null; last_name: string | null; email: string | null } |
              { first_name: string | null; last_name: string | null; email: string | null }[] | null;
  }>;

  const teamMembers: TeamMemberRow[] = memberRows.map((m) => {
    const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
    return {
      memberId:          m.id,
      firstName:         profile?.first_name ?? '',
      lastName:          profile?.last_name  ?? '',
      email:             profile?.email      ?? null,
      role:              (m.role as 'admin' | 'provider' | 'staff'),
      active:            m.active,
      canManagePractice: m.can_manage_practice,
      canCreateBills:    m.can_create_bills,
      specialty:         m.specialty,
      hpcsaNumber:       m.hpcsa_number,
    };
  });

  // Per-doctor revenue breakdown scoped to providers on this branch.
  const providers = teamMembers.filter((m) => m.role === 'provider');
  const providerRefs: RevenueProvider[] = providers.map((d) => ({
    id:       d.memberId,   // placeholder — we key byProvider on user_id below
    fullName: `${d.firstName} ${d.lastName}`.trim() || '—',
  }));
  // computeRevenue's byProvider keys off plan.provider_id which is a
  // user_id, not a membership id. Build the ref list from user_id.
  const providerRefsByUserId: RevenueProvider[] = memberRows
    .filter((m) => m.role === 'provider')
    .map((m) => {
      const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
      return {
        id: m.user_id,
        fullName: `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim() || '—',
      };
    });
  void providerRefs;

  const revenuePractices: RevenuePractice[] = [{
    id:          practiceId,
    name:        practice.name as string,
    fee_percent: Number(practice.fee_percent ?? 0),
  }];
  const branchSummary = computeRevenue(plans, revenuePractices, providerRefsByUserId, {});

  const doctorRows = branchSummary.byProvider.map((r) => ({
    providerId: r.id,
    fullName:   r.label,
    count:      r.count,
    gross:      r.gross,
    net:        r.net,
  }));

  const feeByPractice = new Map<string, number>([[practiceId, Number(practice.fee_percent ?? 0)]]);
  const monthly = buildMonthlySeries(plans as PlanForTrend[], feeByPractice);

  // ── Trading gate — governs the "Create a bill" CTA on this page ──
  //
  // Same three-condition check the practice dashboard and the
  // bill-creation server action enforce (lib/practice/tradingGate.ts).
  // Reuses the service-role client already built above at line 51.
  // Server-side reject in bills/new/actions.ts remains authoritative;
  // this drives the UI state only.
  const gate: TradingGateResult = await checkTradingGate(s, practiceId);

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/brand" className="text-xs text-gray-500 hover:underline">← Back to my practices</Link>
          <h1 className="text-2xl font-semibold mt-1" style={{ color: '#13294B' }}>{practice.name as string}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded-full font-medium ${
              practice.status === 'approved'  ? 'bg-green-100 text-green-700' :
              practice.status === 'pending'   ? 'bg-amber-100 text-amber-700' :
              practice.status === 'suspended' ? 'bg-red-100 text-red-700' :
                                                'bg-gray-100 text-gray-500'
            }`}>
              {practice.status as string}
            </span>
            <span className="text-gray-500">Commission: {Number(practice.fee_percent ?? 0)}%</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Status and commission are set by BetterNow — contact support to change them.
          </p>
        </div>
        <CreateBillButton gate={gate} variant="primary" practiceId={practiceId} />
      </header>

      {/* Co-located hint when the gate fails on banking — BranchBankingForm
          is on this same page, so anchor down to it rather than route
          the admin off-page. */}
      {!gate.ok && gate.reason === 'no_banking' && (
        <div
          role="status"
          data-testid="branch-banking-hint"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p>
            Add banking below to enable billing.{' '}
            <a href="#banking" className="font-semibold underline underline-offset-2" style={{ color: '#13294B' }}>
              Jump to Banking →
            </a>
          </p>
        </div>
      )}

      {/* Section 1 — Performance. MULTI-BRANCH ONLY: cross-branch
          comparison is the whole point of this page for a brand, but for a
          single-branch practice it duplicates /practice's dashboard and
          pushes details/banking below the fold. */}
      {isMultiBranch && (
        <div data-testid="branch-performance-section">
          <BranchPerformance
            branchName={practice.name as string}
            totalNet={branchSummary.totalNet}
            activePlanCount={branchSummary.totalCount}
            monthly={monthly}
            doctorRows={doctorRows}
          />
        </div>
      )}

      {/* Section 2 — Team. MULTI-BRANCH keeps its original slot here
          (Performance → Team → Details → Banking). Single-branch moves it
          below details/banking instead — see the block at the bottom. */}
      {isMultiBranch && (
        <TeamSection
          practiceId={practiceId}
          members={teamMembers}
          actions={{ addTeamMember, updateTeamMember, deactivateTeamMember, reactivateTeamMember }}
        />
      )}

      {/* Practice details + banking. Leads the page for a single-branch
          practice (what they actually came for); stays below Performance
          and Team for a brand. */}
      <BranchDetailsForm
        practiceId={practiceId}
        initial={{
          name:          (practice.name           as string)        ?? '',
          phone:         (practice.phone          as string | null) ?? null,
          addressLine1:  (practice.address_line1  as string | null) ?? '',
          addressLine2:  (practice.address_line2  as string | null) ?? null,
          suburb:        (practice.suburb         as string | null) ?? null,
          city:          (practice.city           as string | null) ?? null,
          province:      (practice.practice_province as string | null) ?? null,
          postalCode:    (practice.postal_code    as string | null) ?? null,
          latitude:      practice.latitude  != null ? Number(practice.latitude)  : null,
          longitude:     practice.longitude != null ? Number(practice.longitude) : null,
        }}
        saveAction={updateBranchDetails}
      />

      <div id="banking">
        <BranchBankingForm
          practiceId={practiceId}
          initial={{
            bankName:          (practice.bank_name           as string | null) ?? null,
            bankAccountNumber: (practice.bank_account_number as string | null) ?? null,
            branchCode:        (practice.branch_code         as string | null) ?? null,
            accountHolder:     (practice.account_holder      as string | null) ?? null,
            accountType:       (practice.account_type        as 'current' | 'savings' | null) ?? null,
          }}
          saveAction={updateBranchBanking}
        />
      </div>

      {/* Team last for a SINGLE-branch practice — details/banking are why
          they opened this page, and the roster is already fully manageable
          from /practice/members. */}
      {!isMultiBranch && (
        <TeamSection
          practiceId={practiceId}
          members={teamMembers}
          actions={{ addTeamMember, updateTeamMember, deactivateTeamMember, reactivateTeamMember }}
        />
      )}
    </div>
  );
}
