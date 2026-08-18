import { redirect, notFound } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { checkTradingGate } from '@/lib/practice/tradingGate';
import { updateBranchDetails, updateBranchBanking } from '@/app/brand/actions';
import PracticeShell from '../PracticeShell';
import { resolvePracticeShellAuthority } from '../practiceShellAuthority';
import BranchDetailsForm from '../details/BranchDetailsForm';
import BranchBankingForm from '../details/BranchBankingForm';
import DeviceAdminView from '../pos/devices/DeviceAdminView';
import {
  generateDeviceRegistrationCode,
  revokeDevice,
  setTillPin,
  generateTillPinValue,
  listDevices,
  relabelDevice,
} from '../pos/devices/actions';
import {
  visibleSettingsSections,
  canSeeSettingsSection,
  canSeeAnySettingsSection,
} from './settingsSections';

// ─── /practice/settings — practice details, banking, and the till ────────
//
// One tab instead of three sidebar entries. A new practice previously met
// "Practice details" and "Till devices" as two peers of Dashboard and Team,
// with no indication that both are configuration rather than daily work.
// They are sections here; the nav is Dashboard · Bills · Team · Settings.
//
// THE FORMS ARE NOT REWRITTEN. Every section mounts the component that
// already served it, against the same server action:
//   BranchDetailsForm + BranchBankingForm  → updateBranchDetails /
//                                            updateBranchBanking
//   DeviceAdminView                        → the six device/PIN actions
// This is reorganisation. The components stay where they are on disk
// (app/practice/details/**, app/practice/pos/devices/**) because their own
// test suites address them there, and moving files would have meant editing
// tests for a feature that did not change.
//
// GATING — THREE SECTIONS, TWO AUTHORITIES, NEITHER LOOSENED
// ─────────────────────────────────────────────────────────
// Folding the screens together does NOT fold their gates together:
//
//   details + banking   brand-admin of the practice's group. Exactly what
//                       guardBrandAdminOfPractice enforces on both save
//                       actions, and what /practice/details used to
//                       notFound() on.
//   till devices        can_manage_practice OR brand-admin. Exactly what
//                       guardTillManager enforces on every device action.
//
// A plain practice manager who is not a brand-admin therefore sees the till
// section and NOT the other two. They are OMITTED, not disabled: the
// details form carries the practice's address and the banking form its
// account number, so rendering them read-only would disclose to a manager
// what /practice/details currently refuses them outright. A greyed-out
// section is also a dead end, which is the thing the nav's own gating
// exists to avoid.
//
// A viewer with no visible section at all gets notFound(), and never sees
// the nav item — both decided by the same helper (./settingsSections), so
// a link cannot appear for a page that will refuse it.
//
// The write guards are untouched and remain the real boundary. Everything
// here is a read/visibility decision.
//
// Service-role reads happen only AFTER the gate, for the reason
// /practice/details and /practice/pos/devices both documented: RLS's
// is_practice_member / is_practice_manager only recognise practice_members,
// so a brand-admin-only caller (a practice_group_members row with no
// practice_members row on this branch) passes the app-level guard and then
// reads nothing.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

type SearchParams = { practiceId?: string };

export default async function PracticeSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;

  const { user, supabase } = await requireConfirmedUser({ next: '/practice/settings' });

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

  // Target practice: an explicit ?practiceId= (how the nav link always
  // arrives) or, for a direct hit with none, the caller's own first active
  // membership — the same fallback shape every other /practice/** screen
  // uses. A pure brand-admin with no practice_members row anywhere has no
  // "first practice" to guess, so they must arrive via an explicit link.
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
  // canManageTill, never a substitute for the brand-admin check.
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

  const authority = { isBrandAdmin, canManageTill };

  // THE authorization boundary for the page itself: nothing to show means
  // nothing to serve. Fails closed — a caller who cannot even read the
  // practices row resolves to both flags false and lands here.
  if (!canSeeAnySettingsSection(authority)) notFound();

  const sections   = visibleSettingsSections(authority);
  const showDetails = canSeeSettingsSection('details', authority);
  const showBanking = canSeeSettingsSection('banking', authority);
  const showTill    = canSeeSettingsSection('till',    authority);

  // ── The three section reads, one wave ─────────────────────────────────
  //
  // Everything above this point is the authority chain, and it is all still
  // strictly serial because it genuinely is: the profile role gate, then the
  // caller's own can_manage_practice on THIS practice, then
  // resolvePracticeShellAuthority which CONSUMES that flag, then
  // canSeeAnySettingsSection which notFound()s a caller with nothing to see.
  // The wave starts only after that refusal has had its chance.
  //
  // Below it, the three reads are independent of each other and all keyed on
  // the practiceId already resolved. `showTill` is derived from the authority
  // resolved above, so the till read is still gated on exactly the same
  // condition as before.
  //
  // listDevices runs guardTillManager as its own first statement and that is
  // UNCHANGED — it remains the authority for the till section, and a null
  // result still means the guard refused and the section stands down. All
  // that changed is that it is awaited concurrently with two other reads
  // instead of after them.
  //
  // The `if (!practice) notFound()` moves below the wave, so on that path the
  // gate and device reads are issued and discarded. That path means the
  // practice row is unreadable or absent — an error state, not a routine one
  // — and both discarded reads are harmless: the gate result is dropped, and
  // listDevices' own guard governs whether it returns anything at all.
  const s = svc();

  const [{ data: practice }, gate, devicesResult] = await Promise.all([
    s
    .from('practices')
    .select(`
      id, name, status, group_id,
      phone, fee_percent,
      address_line1, address_line2, suburb, city, practice_province, postal_code,
      latitude, longitude,
      bank_name, bank_account_number, branch_code, account_holder, account_type,
      till_pin_hash
    `)
    .eq('id', practiceId)
    .maybeSingle(),
    // Drives the co-located "add banking below" hint only — the same check
    // the dashboard and the bill-creation action already run. Read-only
    // consumption; nothing here changes the gate.
    checkTradingGate(s, practiceId),
    // The till section's data comes through listDevices(), which runs
    // guardTillManager itself. Called only when the section is visible, and
    // its own guard is still the authority — a null result means the guard
    // refused, so the section stands down rather than rendering empty.
    showTill ? listDevices(practiceId) : Promise.resolve(null),
  ]);

  if (!practice) notFound();

  const practiceName = (practice.name as string) ?? 'Practice';

  const devices = devicesResult && !devicesResult.error ? (devicesResult.devices ?? []) : null;

  return (
    <PracticeShell
      practiceName={practiceName}
      practiceId={practiceId}
      isBrandAdmin={isBrandAdmin}
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
    >
      <main className="px-4 sm:px-6 py-6 sm:py-10 max-w-3xl space-y-8">
        <header>
          <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>
            Settings
          </h1>
          <p className="mt-1 text-sm text-gray-500">{practiceName}</p>

          {/* Read-only, set by BetterNow — same posture and wording
              /practice/details used (the 0054 column-lock trigger blocks
              these from any non-service-role caller anyway). */}
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

          {/* In-page jump list, built from the SAME visibility helper as the
              sections themselves — so it can never offer an anchor that
              isn't on the page. Suppressed at one section, where it would
              be a link to the thing directly below it. */}
          {sections.length > 1 && (
            <nav aria-label="Settings sections" className="mt-4 flex flex-wrap gap-3 text-xs">
              {sections.map((sec) => (
                <a
                  key={sec.key}
                  href={`#${sec.anchor}`}
                  data-testid={`settings-jump:${sec.key}`}
                  className="font-semibold underline underline-offset-2"
                  style={{ color: '#13294B' }}
                >
                  {sec.title}
                </a>
              ))}
            </nav>
          )}
        </header>

        {/* Banking is on this page, so the hint anchors down to it rather
            than routing the user off-screen. Only shown to someone who can
            actually act on it. */}
        {showBanking && !gate.ok && gate.reason === 'no_banking' && (
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

        {showDetails && (
          <section id="details" data-testid="settings-section:details">
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
          </section>
        )}

        {showBanking && (
          <section id="banking" data-testid="settings-section:banking">
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
          </section>
        )}

        {showTill && devices !== null && (
          <section id="till" data-testid="settings-section:till">
            <div className="mb-5">
              <h2 className="text-lg font-semibold" style={{ color: '#13294B' }}>
                Till devices
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Register a till PC to issue bills without a personal login, and manage the
                practice&apos;s till PIN.
              </p>
            </div>

            <DeviceAdminView
              practiceId={practiceId}
              initialDevices={devices}
              hasPin={!!practice.till_pin_hash}
              generateDeviceRegistrationCode={generateDeviceRegistrationCode}
              revokeDevice={revokeDevice}
              setTillPin={setTillPin}
              generateTillPinValue={generateTillPinValue}
              relabelDevice={relabelDevice}
            />
          </section>
        )}
      </main>
    </PracticeShell>
  );
}
