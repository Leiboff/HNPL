import { redirect, notFound } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
// TradingGateResult is no longer imported: `gate` now comes out of the page's
// parallel wave, where Promise.all's tuple inference already gives it that
// exact type. An explicit annotation there would be redundant, not safer.
import { checkTradingGate } from '@/lib/practice/tradingGate';
import PracticeShell from './PracticeShell';
import { resolvePracticeShellAuthority } from './practiceShellAuthority';
import { resolvePracticeViewer } from './practiceViewer';
import PracticeDashboardClient from './PracticeDashboardClient';
import CreateBillButton from './CreateBillButton';
import NextPayoutHero from './NextPayoutHero';
import PracticeSetupChecklist from './PracticeSetupChecklist';
import {
  loadSetupChecklistFacts,
  buildSetupChecklist,
} from '@/lib/practice/setupChecklist';
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

  // ─── One wave: plans, trading gate, next payout, shell authority ────────
  //
  // These were four sequential awaits; they are now one round trip. Not one of
  // them depends on another — each is keyed on practiceId (plus user.id and
  // canManagePractice, both already resolved by the viewer above) — so the
  // sequence was an artefact of the order the features were written in, and it
  // cost four serial round trips on every load of the busiest staff screen.
  //
  // WHAT IS DELIBERATELY NOT IN HERE. Everything above this point is
  // authorisation and stays strictly sequential: requireConfirmedUser, then
  // the profile role gate, then resolvePracticeViewer, each genuinely needing
  // the previous one's result. Folding any of it into this wave would begin
  // reading practice data before the caller's right to see it was established
  // — the one refactor this file must never accept. The wave starts only after
  // `viewer` has narrowed to an authorised practiceId and `reader` has been
  // chosen from it.
  //
  // The setup checklist is not here either, and that is a real dependency
  // rather than caution: whether it is fetched at all turns on isBrandAdmin /
  // canManageTill, which this wave produces. A reception-level member skips
  // those four reads entirely, which is worth more than folding them in.
  const [
    { data: rawPlans },
    gate,
    nextPayout,
    { isBrandAdmin, canManageTill, brandPracticeCount },
  ] = await Promise.all([
    // Practice-scoped plans. Unchanged query, unchanged reader.
    reader
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
    .limit(500),
    // Same check the bill-creation server action enforces. Drives whether the
    // "+ Create a bill" CTA renders or whether we show a status panel pointing
    // at the unmet condition. Server-action is still the authoritative reject.
    // (Service-role either way — it always was; the gate is a property of the
    // practice, not of the viewer.)
    checkTradingGate(svc, practiceId),
    // Reads through the SAME `reader` as every other practice-scoped query on
    // this page, so it inherits the authority the viewer already resolved and
    // widens nothing. Dates are resolved on the server below, never in the
    // component — see the payoutDates block.
    resolveNextPayout(reader, practiceId),
    // Shared with the other shell-rendering screens via
    // ./practiceShellAuthority rather than copied per screen.
    resolvePracticeShellAuthority(supabase, user.id, practiceId, canManagePractice),
  ]);

  const plans = (rawPlans ?? []) as PlanSummary[];


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
  // (Fetched in the wave above.)
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
  // (Fetched in the wave above — isBrandAdmin / canManageTill / brandPracticeCount.)

  // ── Setup checklist ────────────────────────────────────────────────────
  //
  // Derived live from the same rows the trading gate reads — there is no
  // stored completion flag anywhere in this feature, by design (see
  // lib/practice/setupChecklist.ts for why one would go stale silently).
  //
  // Service-role for the facts, matching checkTradingGate above: how far a
  // practice has got with its setup is a property of the PRACTICE, and
  // reading it through the viewer's client would make the answer depend on
  // that viewer's RLS reach — a brand-admin with no practice_members row
  // reads no till_devices, and the card would report "no till" for a
  // practice that has one.
  //
  // Authority for the LINKS, though, is the viewer's own: each of the three
  // target screens rejects callers who lack the matching right, so the flags
  // resolved just above decide whether an item gets a link or is handed to
  // whoever manages the practice. Both values are already in hand — this
  // adds no authority query of its own.
  //
  // Each right stays attached to the screen that enforces it — NOT collapsed
  // into one "is a manager" flag. canManagePractice is false on the brand
  // path by design (see practiceViewer.ts), and flattening it together with
  // isBrandAdmin is exactly what would let brand authority stand in for
  // practice-member capability.
  const checklistAuthority = {
    canEditDetails: isBrandAdmin,
    canManageTeam:  canManagePractice,
    canManageTill,
  };

  // Shown only to someone who can action at least ONE item — which is the
  // disjunction of those three rights, not a manager check. For a
  // reception-level member the whole card would be four things they cannot
  // do; the trading-gate panel already tells them why billing is blocked, in
  // one line, which is the part that concerns them.
  const canSeeChecklist =
    checklistAuthority.canEditDetails ||
    checklistAuthority.canManageTeam  ||
    checklistAuthority.canManageTill;

  const setupChecklist = canSeeChecklist
    ? buildSetupChecklist(
        await loadSetupChecklistFacts(svc, practiceId),
        checklistAuthority,
      )
    : null;

  // ── Who says what, when both the panel and the card are in play ────────
  //
  // The trading-gate panel and the checklist independently arrived at the same
  // job for two of the gate's three reasons: "add a provider" and "add
  // banking" are a checklist row AND a panel paragraph, in different words,
  // one above the other. Two differently-worded instructions for one task
  // reads as two tasks — the exact confusion the checklist was built to end.
  //
  // So when the card is actually on the page, it owns those two. The panel
  // keeps 'pending_approval', which the card does not cover at all and which
  // nobody at the practice can action.
  //
  // This is conditional, not a narrowing of the panel, and that matters: a
  // reception-level member gets no card (canSeeChecklist is false for them),
  // and on that surface the panel is byte-for-byte what it always was. The
  // suppression can only fire where a replacement is provably present —
  // reason='no_providers' means zero active providers, which is exactly the
  // condition that leaves the card's provider row outstanding, and the same
  // holds for banking. A complete card cannot coexist with either reason.
  const checklistShown = !!setupChecklist && !setupChecklist.complete;
  const showGatePanel =
    !gate.ok && (gate.reason === 'pending_approval' || !checklistShown);

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
            <h1 className="text-xl sm:text-2xl font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>
              {practiceName || 'Dashboard'}
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Welcome back, {profile?.first_name ?? user.email}
            </p>
            {/* n>=2: brand-aware switcher. n=1: only the "Add another practice"
                link, no brand wording — the auto-created brand stays invisible. */}
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
              {practiceCount >= 2 && (
                <a href="/brand" className="font-semibold underline underline-offset-2" style={{ color: 'var(--portal-ink)' }}>
                  See all my practices ({practiceCount})
                </a>
              )}
              <a href="/brand/new-practice" className="font-semibold underline underline-offset-2" style={{ color: 'var(--portal-ink)' }}>
                {practiceCount === 1 ? '+ Add another practice' : '+ Add a practice'}
              </a>
            </div>
          </div>
          <CreateBillButton gate={gate} variant="primary" practiceId={practiceId} />
        </div>

        {/* Bounce-back banner — only shown when /practice/bills/new
            redirected us here because the gate was closed. Disappears on
            any subsequent navigation that doesn't carry ?reason=.

            Its job is to explain the REDIRECT — "you asked for the bill form
            and got sent back here" — which nothing else on the page does. So
            it stays. What it stops doing is repeating the instruction: when the
            checklist is up, the list below is the single place that says what
            to fix, and this points at it instead of restating one item of it in
            the gate's words. */}
        {cameFromGatedBillsPage && !gate.ok && (
          <div
            role="alert"
            data-testid="trading-gate-bounce-banner"
            className="rounded-xl border border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-semibold">You can&apos;t create bills yet.</p>
            <p className="mt-1">
              {checklistShown
                ? 'Everything that’s still outstanding is in the list below.'
                : gate.message}
            </p>
          </div>
        )}

        {/* Trading-gate panel — explains why the CTA is disabled when blocked.
            Suppressed for the two reasons the checklist already covers; see
            showGatePanel above for why that is conditional rather than a
            permanent narrowing. */}
        {showGatePanel && (
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
                style={{ color: 'var(--portal-ink)' }}
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
                style={{ color: 'var(--portal-ink)' }}
              >
                Go to Banking →
              </a>
            )}
          </div>
        )}

        {/* Setup checklist — above the hero ONLY while it exists, and it
            removes itself the moment the last item is ticked (it returns null
            when complete, so there is no empty shell left behind).

            Above, because a practice that still has setup outstanding has
            nothing in the hero yet — no bills means no payout, so the hero is
            showing its empty state and the actionable thing on the page is
            this. Once setup is done the card vanishes and the hero is back at
            the top of the page, where it belongs for every day after the
            first. The hero itself is untouched. */}
        {setupChecklist && (
          <PracticeSetupChecklist checklist={setupChecklist} practiceId={practiceId} />
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
