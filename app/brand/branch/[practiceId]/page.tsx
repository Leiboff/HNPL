import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { computeRevenue, type RevenuePlan, type RevenuePractice, type RevenueProvider } from '@/lib/brand/revenue';
import { buildMonthlySeries, type PlanForTrend } from '@/lib/brand/monthlyRevenue';
import {
  updateBranchDetails,
  updateBranchBanking,
  addDoctor,
  updateDoctor,
  deactivateDoctor,
  reactivateDoctor,
} from '@/app/brand/actions';
import BranchDetailsForm from './BranchDetailsForm';
import BranchBankingForm from './BranchBankingForm';
import BranchPerformance from './BranchPerformance';
import DoctorsSection from './DoctorsSection';

// ─── Brand-admin: branch detail (restructured) ─────────────────────────
//
// Three sections, top to bottom:
//   1. Performance — hero (branch revenue in selected mode) + 12-month
//      trend + per-doctor breakdown.
//   2. Doctors — add / edit / deactivate practitioners on this branch.
//   3. Practice details + banking — the existing edit-mode cards
//      (unchanged; relocated into this structure).
//
// LOCKED columns stay READ-ONLY at the header (status, fee_percent).
// Locked columns never enter any UPDATE payload — see the source-text
// pins in app/brand/brand-management.test.ts + app/brand/brand-dashboard.test.ts.

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

  // Resolve the practice via service-role, then verify the caller is
  // an active brand-admin of THAT practice's group. Cross-group
  // isolation lives here and in every server action below.
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
  if (!membership) notFound();  // 404 rather than 403 — same shape as a stranger asking

  // Plans on this branch (scoped, service-role).
  const { data: rawPlans } = await s
    .from('plans')
    .select('id, practice_id, provider_id, total_amount, status, created_at')
    .eq('practice_id', practiceId)
    .limit(5000);
  const plans = (rawPlans ?? []) as Array<RevenuePlan & { created_at: string }>;

  // Doctors — every provider-role member on this practice, active or
  // deactivated. Include profiles for display names + email.
  const { data: rawMembers } = await s
    .from('practice_members')
    .select('id, active, role, specialty, hpcsa_number, user_id, profiles ( first_name, last_name, email )')
    .eq('practice_id', practiceId)
    .eq('role', 'provider');
  const memberRows = (rawMembers ?? []) as Array<{
    id: string; active: boolean; role: string;
    specialty: string | null; hpcsa_number: string | null;
    user_id: string;
    profiles: { first_name: string | null; last_name: string | null; email: string | null } |
              { first_name: string | null; last_name: string | null; email: string | null }[] | null;
  }>;

  const doctors = memberRows.map((m) => {
    const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
    return {
      memberId:    m.id,
      firstName:   profile?.first_name ?? '',
      lastName:    profile?.last_name  ?? '',
      email:       profile?.email      ?? null,
      specialty:   m.specialty,
      hpcsaNumber: m.hpcsa_number,
      active:      m.active,
      userId:      m.user_id,
    };
  });

  // Per-doctor revenue breakdown — reuse computeRevenue.byProvider,
  // scoped to this branch. We need provider names for the rows; pull
  // from the doctors we already have.
  const providerRefs: RevenueProvider[] = doctors.map((d) => ({
    id:       d.userId,
    fullName: `${d.firstName} ${d.lastName}`.trim() || '—',
  }));
  const revenuePractices: RevenuePractice[] = [{
    id:          practiceId,
    name:        practice.name as string,
    fee_percent: Number(practice.fee_percent ?? 0),
  }];
  const branchSummary = computeRevenue(plans, revenuePractices, providerRefs, {});

  const doctorRows = branchSummary.byProvider.map((r) => ({
    providerId: r.id,
    fullName:   r.label,
    count:      r.count,
    gross:      r.gross,
    net:        r.net,
  }));

  // Branch 12-month series.
  const feeByPractice = new Map<string, number>([[practiceId, Number(practice.fee_percent ?? 0)]]);
  const monthly = buildMonthlySeries(plans as PlanForTrend[], feeByPractice);

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header>
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
      </header>

      {/* Section 1 — Performance (revenue + trend + per-doctor breakdown) */}
      <BranchPerformance
        branchName={practice.name as string}
        totalGross={branchSummary.totalGross}
        totalNet={branchSummary.totalNet}
        activePlanCount={branchSummary.totalCount}
        monthly={monthly}
        doctorRows={doctorRows}
      />

      {/* Section 2 — Doctors */}
      <DoctorsSection
        practiceId={practiceId}
        doctors={doctors.map((d) => ({
          memberId:    d.memberId,
          firstName:   d.firstName,
          lastName:    d.lastName,
          email:       d.email,
          specialty:   d.specialty,
          hpcsaNumber: d.hpcsaNumber,
          active:      d.active,
        }))}
        actions={{ addDoctor, updateDoctor, deactivateDoctor, reactivateDoctor }}
      />

      {/* Section 3 — Practice details + banking (existing edit cards) */}
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
  );
}
