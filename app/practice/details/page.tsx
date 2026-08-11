import { redirect, notFound } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import { updateBranchDetails, updateBranchBanking } from '@/app/brand/actions';
import PracticeShell from '../PracticeShell';
import { resolvePracticeShellAuthority } from '../practiceShellAuthority';
import BranchDetailsForm from './BranchDetailsForm';
import BranchBankingForm from './BranchBankingForm';

// ─── /practice/details — practice settings (details + banking) ──────────
//
// This is the settings surface the sidebar's "Practice details" link
// points at. It replaces the double duty /brand/branch/[practiceId] was
// doing: that route was simultaneously a multi-branch PERFORMANCE view
// and the de-facto settings page, which meant a single practice opened
// "Practice details" and got a revenue rollup restating their own
// dashboard, a redundant Team roster, and no practice nav (it sits
// outside the /practice tree, so PracticeShell never wrapped it).
//
// Living under /practice/** is the point: the shell comes for free, so
// there is no hand-rolled nav or slim back-header here.
//
// Contents are deliberately ONLY details + banking:
//   • no revenue / performance rollup — cross-branch comparison lives at
//     /brand, the one place several branches are seen side by side
//   • no Team section — /practice/members is the team surface
//   • no by-doctor breakdown — that moved to /brand alongside the rest
//     of the rollup
//
// GATING — matches, and does not loosen, what already guards this
// content's WRITES. Both save actions (app/brand/actions.ts
// updateBranchDetails / updateBranchBanking) are guarded by
// guardBrandAdminOfPractice: an active practice_group_members row for
// the practice's group. NOT can_manage_practice. So viewing is gated on
// exactly that same brand-admin authority, resolved through the shared
// resolver — a practice manager who is not a brand-admin gets
// notFound(), which is what /brand/branch/[practiceId] did before and
// why the sidebar link is isBrandAdmin-gated in the first place.
//
// Post-0062 the solo owner is auto-brand-admin of their own 1-practice
// brand, so the standalone practice reaches this page normally.
//
// The practice row is read via SERVICE-ROLE once authorized, for the
// same documented reason app/practice/pos/devices/page.tsx does it:
// RLS's is_practice_member / is_practice_manager only recognise
// practice_members, so a brand-admin-only caller (a
// practice_group_members row with no practice_members row on this
// branch) would pass the app-level guard and then read nothing.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type SearchParams = { practiceId?: string };

export default async function PracticeDetailsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const { user, supabase } = await requireConfirmedUser({ next: '/practice/details' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient')    redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  // Target practice: an explicit ?practiceId= (how the sidebar link
  // always arrives) or, for a direct hit with none, the caller's own
  // first active membership — the same fallback shape every other
  // /practice/** screen uses. A pure brand-admin with no
  // practice_members row anywhere has no "first practice" to guess, so
  // they must arrive via an explicit ?practiceId= link.
  let practiceId = params.practiceId ?? null;
  if (!practiceId) {
    const { data: memberships } = await supabase
      .from('practice_members')
      .select('practice_id')
      .eq('user_id', user.id)
      .eq('active', true)
      .order('created_at', { ascending: true })
      .limit(1);
    if (!memberships || memberships.length === 0) redirect('/practice');
    practiceId = memberships[0].practice_id as string;
  }

  // The caller's own can_manage_practice on THIS practice — an input to
  // canManageTill, never a substitute for the brand-admin check below.
  const { data: myMembership } = await supabase
    .from('practice_members')
    .select('can_manage_practice')
    .eq('user_id',     user.id)
    .eq('practice_id', practiceId)
    .eq('active',      true)
    .maybeSingle();

  const { isBrandAdmin, canManageTill, brandPracticeCount } =
    await resolvePracticeShellAuthority(
      supabase, user.id, practiceId, !!myMembership?.can_manage_practice,
    );

  // THE authorization boundary for this screen — same authority the two
  // save actions enforce. Fails closed: a caller who cannot even read
  // the practices row resolves to isBrandAdmin=false and lands here.
  if (!isBrandAdmin) notFound();

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

  // Drives the co-located "add banking below" hint only — the same
  // check the dashboard and the bill-creation action already run
  // (lib/practice/tradingGate.ts). Nothing here changes the gate.
  const gate: TradingGateResult = await checkTradingGate(s, practiceId);

  const practiceName = (practice.name as string) ?? 'Practice';

  return (
    <PracticeShell
      practiceName={practiceName}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-10 max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>
            Practice details
          </h1>
          <p className="mt-1 text-sm text-gray-500">{practiceName}</p>

          {/* Read-only, set by BetterNow — same posture and wording the
              branch page used (the 0054 column-lock trigger blocks these
              from any non-service-role caller anyway). */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
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

        {/* Banking is on this page, so the hint anchors down to it rather
            than routing the user off-screen. */}
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
      </main>
    </PracticeShell>
  );
}
