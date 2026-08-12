import { redirect, notFound } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate, type TradingGateResult } from '@/lib/practice/tradingGate';
import PracticeShell from './PracticeShell';
import { resolvePracticeShellAuthority } from './practiceShellAuthority';
import { resolvePracticeViewer } from './practiceViewer';
import PracticeDashboardClient from './PracticeDashboardClient';
import CreateBillButton from './CreateBillButton';
import NextPayoutHero from './NextPayoutHero';
import { resolveNextPayout } from '@/lib/practice/nextPayout';
import { payoutDateFor, windowDates } from '@/lib/payments/payoutSchedule';
import { PlanSummary } from './billHelpers';

type SearchParams = { reason?: string; practiceId?: string };

export default async function PracticeDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const cameFromGatedBillsPage = params.reason === 'trading_gate';

  // Defense-in-depth — bounces to /login or /verify-email before any work.
  const { user, supabase } = await requireConfirmedUser({ next: '/practice' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'practice_admin' && profile?.role !== 'practice_staff') {
    if (profile?.role === 'patient') redirect('/patient');
    else if (profile?.role === 'admin') redirect('/admin');
    else redirect('/login');
  }

  // ── Which practice, and by what authority? ────────────────────────────
  //
  // Post-0062 a brand owner is a member of multiple practices (one per
  // branch), so the dashboard scopes to ONE practice at a time — picked
  // by ?practiceId= or, when absent, the first practice they joined.
  //
  // Extracted to ./practiceViewer because this page is now also where a
  // brand-admin lands when they click into a branch
  // (/brand/branch/[practiceId] pivots here). The resolver keeps the two
  // authority paths distinct — an active practice_members row, or an
  // active practice_group_members row for the practice's group — and
  // never converts brand-admin authority into a practice-member
  // capability. See its header for why the brand path reads with
  // service-role and why an unmatched explicit ?practiceId= is now
  // rejected instead of silently falling back to a different practice.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const viewer = await resolvePracticeViewer(supabase, svc, user.id, params.practiceId);
  if (viewer.kind === 'setup')  redirect('/practice/setup');
  if (viewer.kind === 'denied') notFound();

  const {
    practiceId, practiceName, feePercent,
    canManagePractice, viaBrandAdmin, membershipCount,
  } = viewer.scope;

  // Practice-scoped reads run on the caller's own client (RLS) on the
  // member path — byte-identical to before for a practice's own staff.
  // On the brand path they run with service-role, scoped to the single
  // practice the resolver just authorized: RLS's is_practice_member only
  // recognises practice_members, and profiles was deliberately never
  // widened for brand-admins, so an authenticated-client read would
  // return no plans and no patient/provider names — the same reason
  // /practice/pos/devices and the old branch page read this way.
  const reader = viaBrandAdmin ? svc : supabase;

  // Brand context — how many practices does this user belong to?
  // Drives the n=1-vs-n>=2 UX rule: brand wording is hidden at n=1
  // and surfaces at n>=2. We DO NOT compute brand name here — the
  // dashboard shouldn't say "brand X" for a solo user even if they
  // have a (silent, auto-created) brand row.
  const practiceCount = membershipCount;

  const { data: rawPlans } = await reader
    .from('plans')
    .select(`
      id, total_amount, status, created_at, invoice_number, practice_reference,
      provider_member_id,
      patient:profiles!plans_patient_id_fkey(first_name, last_name),
      provider_member:practice_members!plans_provider_member_id_fkey(
        id, user_id, provider_first_name, provider_last_name, specialty,
        profiles(first_name, last_name)
      ),
      payouts(net_amount, status),
      invitations:patient_invitations(viewed_at, accepted_at, expires_at)
    `)
    .eq('practice_id', practiceId)
    .order('created_at', { ascending: false })
    .limit(500);

  const plans = (rawPlans ?? []) as PlanSummary[];

  // ── Trading gate ───────────────────────────────────────────────────────
  // Same check the bill-creation server action enforces. Drives whether the
  // "+ Create a bill" CTA renders or whether we show a status panel pointing
  // at the unmet condition. Server-action is still the authoritative reject.
  // (Service-role either way — it always was; the gate is a property of
  // the practice, not of the viewer.)
  const gate: TradingGateResult = await checkTradingGate(svc, practiceId);

  // Specialty now rides along on the provider_member embed above, so the extra
  // practice_members round-trip this used to need is gone. Keyed on the
  // MEMBERSHIP id, which is what plans carry since 0094.
  const specialtyMap: Record<string, string> = {};
  for (const p of plans) {
    const m = Array.isArray(p.provider_member) ? p.provider_member[0] : p.provider_member;
    if (m?.id && m.specialty) specialtyMap[m.id] = m.specialty;
  }

  // ── Next payout ────────────────────────────────────────────────────────
  //
  // Reads through the SAME `reader` as every other practice-scoped query on
  // this page, so it inherits the authority the viewer already resolved and
  // widens nothing: on the member path RLS decides (payout_batches is open to
  // any active member, payouts only to is_practice_manager — see nextPayout.ts
  // for what that asymmetry means for what renders), and on the brand path it
  // is the service-role client the resolver authorized for this one practice.
  //
  // Dates are resolved HERE, on the server, via lib/payments/payoutSchedule —
  // never inside the component. The window boundaries are SAST midnights, and
  // formatting one of those in the browser's timezone would name the wrong
  // day. Passing pre-resolved YYYY-MM-DD strings makes that impossible.
  const nextPayout = await resolveNextPayout(reader, practiceId);
  const payoutWindow = nextPayout.next.kind === 'none' ? null : nextPayout.next.window;
  const payoutDates = {
    payoutDate:  payoutWindow ? payoutDateFor(payoutWindow)          : null,
    windowFirst: payoutWindow ? windowDates(payoutWindow).firstDate  : null,
    windowLast:  payoutWindow ? windowDates(payoutWindow).lastDate   : null,
  };

  // ── Nav-shell authority ──────────────────────────────────────────
  //
  // Resolves whether the caller is an active practice_group_members row
  // for this practice's brand, which gates the "Practice details" link
  // (/practice/details — the same authority its two save actions
  // enforce) and, at 2+ practices in the brand, the "← All practices"
  // exit link. Post-0062 the solo owner is auto-brand-admin of their own
  // 1-practice brand, so isBrandAdmin is true for the standalone case —
  // which is exactly why the exit link keys off brandPracticeCount too.
  //
  // Resolved on the caller's OWN client and from canManagePractice as
  // the resolver reported it — on the brand path that is false, so a
  // brand-admin does not pick up practice-member capabilities here.
  //
  // Shared with the other shell-rendering screens via
  // ./practiceShellAuthority rather than copied per screen.
  const { isBrandAdmin, canManageTill, brandPracticeCount } =
    await resolvePracticeShellAuthority(
      supabase, user.id, practiceId, canManagePractice,
    );

  return (
    <PracticeShell
      practiceName={practiceName}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">

        {/* Heading */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate" style={{ color: '#13294B' }}>
              {practiceName || 'Dashboard'}
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Welcome back, {profile?.first_name ?? user.email}
            </p>
            {/* n>=2: brand-aware switcher. n=1: only the "Add another practice"
                link, no brand wording — the auto-created brand stays invisible. */}
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
              {practiceCount >= 2 && (
                <a href="/brand" className="font-semibold underline underline-offset-2" style={{ color: '#13294B' }}>
                  See all my practices ({practiceCount})
                </a>
              )}
              <a href="/brand/new-practice" className="font-semibold underline underline-offset-2" style={{ color: '#13294B' }}>
                {practiceCount === 1 ? '+ Add another practice' : '+ Add a practice'}
              </a>
            </div>
          </div>
          <CreateBillButton gate={gate} variant="primary" practiceId={practiceId} />
        </div>

        {/* Bounce-back banner — only shown when /practice/bills/new
            redirected us here because the gate was closed. Disappears on
            any subsequent navigation that doesn't carry ?reason=. */}
        {cameFromGatedBillsPage && !gate.ok && (
          <div
            role="alert"
            data-testid="trading-gate-bounce-banner"
            className="rounded-xl border border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-semibold">You can&apos;t create bills yet.</p>
            <p className="mt-1">{gate.message}</p>
          </div>
        )}

        {/* Trading-gate panel — explains why the CTA is disabled when blocked. */}
        {!gate.ok && (
          <div
            role="status"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm"
            data-testid="trading-gate-panel"
          >
            <p className="font-semibold text-amber-900">
              {gate.reason === 'pending_approval' ? 'Awaiting approval'
                : gate.reason === 'no_providers'   ? 'Add a provider to start billing'
                                                   : 'Add banking to start billing'}
            </p>
            <p className="mt-1 text-amber-800">{gate.message}</p>
            {gate.reason === 'no_providers' && (
              <a
                href="/practice/members"
                className="mt-2 inline-block font-semibold underline underline-offset-2"
                style={{ color: '#13294B' }}
              >
                Go to Team →
              </a>
            )}
            {gate.reason === 'no_banking' && (
              // /practice/setup is the initial-signup flow; it redirects
              // away for anyone who already has a practice_members row
              // (i.e. anyone hitting this panel). Send users to
              // /practice/details — where the BankingForm and its
              // working update action (updateBranchBanking) live, and
              // straight to the banking anchor on it. That page's guard
              // (practice_group_members membership) enforces
              // brand-admin-only edit; a non-brand-admin lands on
              // notFound() there, which is correct — they can't set
              // their branch's banking.
              <a
                href={`/practice/details?practiceId=${practiceId}#banking`}
                className="mt-2 inline-block font-semibold underline underline-offset-2"
                style={{ color: '#13294B' }}
              >
                Go to Banking →
              </a>
            )}
          </div>
        )}

        {/* Next payout — the money question, answered first. Additive: the
            sections below are untouched. */}
        <NextPayoutHero data={nextPayout} dates={payoutDates} />

        {/* Dashboard: global filters + chart + bills */}
        <PracticeDashboardClient
          plans={plans}
          feePercent={feePercent}
          specialtyMap={specialtyMap}
          practiceName={practiceName}
          gate={gate}
          practiceId={practiceId}
        />

      </main>
    </PracticeShell>
  );
}
