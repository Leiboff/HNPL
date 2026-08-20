import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '../PatientScreen';
import InstalmentLadder, { type LadderSegment } from '../InstalmentLadder';
import PaymentMethods from '../payment-methods/PaymentMethods';
import PhoneField from '../profile/PhoneField';
import SalaryDaySection from '../profile/SalaryDaySection';
import NotificationsToggle from '../profile/NotificationsToggle';
import PasskeysSection from '../profile/PasskeysSection';
import ProfileLogoutSection from '../profile/ProfileLogoutSection';
import AccountSettings from './AccountSettings';
import PasswordSection from './PasswordSection';
import {
  startPhoneChange,
  requestPhoneChangeOtp,
  verifyPhoneChangeOtp,
  cancelPhoneChange,
} from './phoneChangeActions';
import { initializeCardRegistration } from '../actions';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import { decryptIdForDisplay } from '@/lib/idEncryption';
import { maskSaId } from '@/lib/saIdMask';
import { maskEmail } from '@/lib/patient/maskContact';
import EmptyState from '@/components/EmptyState';
import { resolveAppVersion } from '@/lib/appVersion';
import { todaySAST, formatDate } from '../_format';
import { isAllowedSalaryDay, ALLOWED_SALARY_DAYS } from '@/lib/salaryDates';
import { getRequestUser } from '@/lib/auth/requestUser';
import { getPatientProfileForRequest } from '@/lib/patient/requestProfile';
import { PatientDetailBody } from '@/components/loading/PatientShellShape';
import {
  changeDefaultCard,
  removeCard,
  type CardRow,
} from '../payment-methods/actions';

// ─── Account — the single settings surface ───────────────────────────────
//
// Account and Profile are ONE page. This pass gave it a hierarchy: four named
// groups over seven sections, all in ONE interaction pattern.
//
// ─── WHAT WAS WRONG, SPECIFICALLY ─────────────────────────────────────
//
// The consolidation that merged Profile into Account left three interaction
// patterns competing on one screen: four accordion sections, two flat cards
// (the record, and Log out with its own eyebrow label), and one chevron
// nav-row (Get help). Each was defensible where it was written; together they
// made the page read as assembled rather than designed. Everything a patient
// OPERATES is now an AccordionSection — see ./AccountSettings.tsx for the
// grouping and why those four groups.
//
// ─── THE RECORD IS NOT A SETTING ──────────────────────────────────────
//
// "Your record" stays outside the accordion system, directly under the navy
// header, as the sheet's first and largest object. Three reasons: it is the
// only thing on this page that was EARNED rather than configured; it is
// read-only, so the one-pattern rule — which governs sections you operate —
// does not apply to it; and the InstalmentLadder is the app's signature
// object (Home, both Plans lists, Plan detail), so the page that summarises
// it should lead with it rather than file it under a heading.
//
// Honesty (unchanged): the record shows the count of payments actually made —
// no invented rewards tier, no "we'll review your limit" promise, because
// that policy does not exist in code.
//
// ─── PROVENANCE: WHAT RENDERS, AND WHAT DELIBERATELY DOES NOT ─────────
//
// Renders, because the data exists and cannot go stale:
//   • "Member since" from profiles.created_at
//   • terms acceptance from terms_accepted_at + terms_version (NULL on
//     accounts predating migration 0081 — so it renders nothing there)
//   • per-card "Added <date>" from payment_methods.created_at
//
// Renders NOTHING, because the data does not exist:
//   • salary date — there is no change-frequency rule in this codebase and
//     no timestamp for it. See ../profile/SalaryDaySection.tsx.
//   • phone — no change timestamp; phone_verified_at is locked to the OTP
//     path and goes stale on edit. See ../profile/PhoneField.tsx.
//
// Excluded on purpose: liveness_verified_at and credit_check_completed_at.
// Both sit behind feature flags that default OFF, and the liveness check is a
// stub that always returns pass — "Identity verified" from that would be a
// claim the system cannot support.

// ─── Server actions (moved here from the retired profile route) ──────────

// ─── Phone changes do NOT live here any more ─────────────────────────────
//
// This file used to hold an `updateProfile` action that wrote
// `.update({ phone })` directly. That was the bug fixed by migration 0099:
// profiles.phone_verified_at is column-locked to the OTP path, so it stayed
// set from the previous number's verification and the system believed an
// unverified number was verified — while dunningNotifications.ts SMSed the
// patient's arrears reminders to it.
//
// A phone change is now staged and re-verified. The four actions live in
// ./phoneChangeActions.ts, which is where the reasoning is written down.
// Nothing on this page writes profiles.phone.

// Changes apply to FUTURE plans only — a plan's own `salary_day` column is
// snapshotted at plan creation, so existing schedules are untouched. The
// profile is the salary_day source of truth; checkout READS it server-side.
async function saveSalaryDay(day: number): Promise<{ error: string | null }> {
  'use server';

  if (!isAllowedSalaryDay(day)) {
    return { error: `Salary day must be one of: ${ALLOWED_SALARY_DAYS.join(', ')}.` };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired. Please log in again.' };

  const { error } = await supabase
    .from('profiles')
    .update({ salary_day: day })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/account');
  revalidatePath('/patient');
  return { error: null };
}

/**
 * A field the patient cannot change, shown as visibly locked WITH its reason.
 *
 * Before, these were plain label/value pairs and the reason lived in a single
 * footnote at the bottom of the section — so a field was read-only without
 * looking locked, and the explanation was somewhere else. A padlock on the
 * row and the reason under it means the field answers "why can't I edit
 * this?" where the question is actually asked.
 */
function LockedField({
  label,
  value,
  reason,
}: {
  label:  string;
  value:  string;
  /** Why it is locked. Rendered under the value, per field. */
  reason: string;
}) {
  return (
    <div data-testid="locked-field">
      <p
        className="text-[11px] font-semibold uppercase tracking-widest mb-1.5"
        style={{ color: '#13294B', opacity: 0.45 }}
      >
        {label}
      </p>
      <div className="flex items-center gap-1.5">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#8496AA"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-none"
          aria-label="Locked"
          role="img"
          data-testid="locked-field-icon"
        >
          <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        </svg>
        <p className="text-sm font-medium text-gray-800 truncate">{value || '—'}</p>
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.45]" style={{ color: '#A3B1C2' }}>
        {reason}
      </p>
    </div>
  );
}

/** Discreet provenance under a field or in the footer. Renders NOTHING when
 *  `children` is null/undefined — the whole point: a missing timestamp must
 *  produce no element at all, never the string "undefined". */
function Provenance({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p className="text-[11.5px]" style={{ color: '#A3B1C2' }} data-testid="provenance">
      {children}
    </p>
  );
}

export default async function AccountPage() {
  const user = await getRequestUser();
  if (!user) redirect('/login');

  // Fast path — the SAME cached profiles row the layout already read for
  // its role gate (React cache(), see lib/patient/requestProfile.ts), so
  // this costs no extra round trip. It carries exactly what the header
  // needs (name, email), so the header renders for real immediately while
  // AccountBody's heavier queries (cards, payment history, the full
  // profile row) stream in below.
  const fastProfile = await getPatientProfileForRequest(user.id);
  const fastFirstName = (fastProfile?.first_name as string | null) ?? '';
  const fastLastName  = (fastProfile?.last_name  as string | null) ?? '';
  const fullName      = [fastFirstName, fastLastName].filter(Boolean).join(' ') || '—';
  const initials       = [fastFirstName[0], fastLastName[0]].filter(Boolean).join('').toUpperCase() || '?';
  const emailMasked    = maskEmail(fastProfile?.email as string | null | undefined);

  const header = (
    <div className="flex items-center gap-[14px]">
      <span
        className="flex-none w-[52px] h-[52px] rounded-full flex items-center justify-center text-[17px] font-semibold text-white"
        style={{ background: 'rgba(255,255,255,.14)' }}
      >
        {initials}
      </span>
      <div className="min-w-0">
        <p className="text-[19px] font-semibold text-white truncate" style={{ letterSpacing: '-.02em' }}>{fullName}</p>
        <p className="mt-0.5 text-[13px] truncate" style={{ color: 'rgba(255,255,255,.6)' }}>{emailMasked}</p>
      </div>
    </div>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <Suspense fallback={<PatientDetailBody label="Loading your account" cards={3} />}>
        <AccountBody userId={user.id} />
      </Suspense>
    </PatientScreen>
  );
}

async function AccountBody({ userId }: { userId: string }) {
  const supabase = await createClient();

  const [{ data: profile }, { data: rawCards }, { data: rawPayments }, { data: rawPlans }] = await Promise.all([
    supabase
      .from('profiles')
      .select('first_name, last_name, email, phone, phone_pending, phone_verified_at, sa_id_number, salary_day, created_at, terms_accepted_at, terms_version')
      .eq('id', userId)
      .single(),
    // Active cards only — archived (soft-deleted) cards drop off the list.
    // token is read server-side to compute the delete guard; it is NOT
    // passed to the client (CardRow carries no token).
    supabase
      .from('payment_methods')
      .select('id, card_brand, last_four, expiry_month, expiry_year, cardholder_name, is_default, created_at, token')
      .eq('patient_id', userId)
      .is('archived_at', null)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false }),
    supabase.from('payments').select('status, due_date, next_attempt_date').eq('patient_id', userId).eq('kind', 'instalment'),
    // Which cards are currently collecting an active plan → those cards
    // cannot be removed. Determined here (and re-checked in archive_card).
    supabase.from('plans').select('peach_registration_id').eq('patient_id', userId).in('status', ['active', 'pending_first_payment']),
  ]);

  const firstName = (profile?.first_name as string | null) ?? '';
  const lastName  = (profile?.last_name  as string | null) ?? '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || '—';
  const salaryDay = (profile?.salary_day as number | null) ?? null;

  const decryptedSaId = decryptIdForDisplay(profile?.sa_id_number as string | null | undefined);
  const saIdMasked    = maskSaId(decryptedSaId);

  // Email is masked everywhere it appears, including the navy header, where it
  // used to render in full. Same discipline as the SA ID beside it.
  const emailMasked = maskEmail(profile?.email as string | null | undefined);

  // ── Account-level provenance ──────────────────────────────────────
  // Both of these are NULL-able and each resolves to null rather than to a
  // placeholder: created_at is NOT NULL in practice but is typed nullable, and
  // terms_accepted_at is genuinely NULL on accounts predating migration 0081.
  // <Provenance> renders no element for null, which is what keeps "undefined"
  // off the screen.
  const createdAtRaw = profile?.created_at as string | null | undefined;
  const memberSince  = createdAtRaw ? `Member since ${formatDate(createdAtRaw.slice(0, 10))}` : null;

  const termsAtRaw   = profile?.terms_accepted_at as string | null | undefined;
  const termsVersion = profile?.terms_version     as string | null | undefined;
  const termsLine    = termsAtRaw
    ? `Terms${termsVersion ? ` v${termsVersion}` : ''} accepted ${formatDate(termsAtRaw.slice(0, 10))}`
    : null;

  // Null in local dev, a real build id on a deploy. Nothing renders for null.
  const appVersion = resolveAppVersion();

  // Split the server-only token off before handing cards to the client.
  const rawCardRows = (rawCards ?? []) as (CardRow & { token: string })[];
  const cards: CardRow[] = rawCardRows.map(({ token: _token, ...row }) => row);

  // Cards whose token backs an active/pending plan are locked against
  // removal (RULE 2). Set of ids for the client to disable "Remove".
  const activeTokens = new Set(
    ((rawPlans ?? []) as { peach_registration_id: string | null }[])
      .map((p) => p.peach_registration_id)
      .filter((t): t is string => !!t),
  );
  const lockedCardIds = rawCardRows.filter((c) => activeTokens.has(c.token)).map((c) => c.id);

  // ── Honest payment record ─────────────────────────────────────────
  // "All on time" is only true when nothing is currently overdue AND there
  // is no history of a miss. Overdue is derived (due date vs today) via the
  // shared source of truth — the same verdict the Plans header and schedule
  // show — so this card can never contradict them.
  const today       = todaySAST();
  const instalments = (rawPayments ?? []) as { status: string; due_date: string; next_attempt_date: string | null }[];
  const statuses    = instalments.map((p) => p.status);
  const madeCount   = statuses.filter((s) => s === 'collected').length;
  const scheduled   = statuses.filter((s) => s === 'scheduled').length;
  const everMissed  = statuses.some((s) => s === 'failed' || s === 'defaulted' || s === 'retried');
  const anyOverdue  = instalments.some((p) => deriveInstalmentStatus(p, today) === 'overdue');
  const cleanRecord = madeCount > 0 && !everMissed && !anyOverdue;

  const CAP = 8;
  const paidSeg   = Math.min(madeCount, CAP);
  const comingSeg = Math.min(scheduled, CAP - paidSeg);
  const recordSegments: LadderSegment[] = [
    ...Array(paidSeg).fill('paid' as LadderSegment),
    ...Array(comingSeg).fill('coming' as LadderSegment),
  ];

  const recordHeading =
    madeCount === 0 ? 'No payments yet' :
    cleanRecord     ? `${madeCount} payment${madeCount === 1 ? '' : 's'}, all on time` :
                      `${madeCount} payment${madeCount === 1 ? '' : 's'} made`;

  // ── Personal details — locked identity + the one editable field ──────
  //
  // Salary date is NO LONGER nested here: it is its own section now (see
  // AccountSettings). What is left is identity — three locked fields, each
  // carrying its own padlock and its own reason, plus phone, which is the
  // only genuinely editable thing on this screen and edits per-field.
  const personalDetails = (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
        <LockedField
          label="Full name"
          value={fullName}
          reason="Must match your SA ID. Support can change it."
        />
        <LockedField
          label="SA ID number"
          value={saIdMasked || ''}
          reason="Verified at signup and fixed for life."
        />
        <LockedField
          label="Email"
          value={emailMasked}
          reason="Your sign-in address. Support can change it."
        />
      </div>
      <div className="border-t border-gray-100 pt-4">
        <PhoneField
          current={profile?.phone ?? null}
          pending={(profile?.phone_pending as string | null | undefined) ?? null}
          verifiedAt={(profile?.phone_verified_at as string | null | undefined) ?? null}
          startPhoneChange={startPhoneChange}
          requestPhoneChangeOtp={requestPhoneChangeOtp}
          verifyPhoneChangeOtp={verifyPhoneChangeOtp}
          cancelPhoneChange={cancelPhoneChange}
        />
      </div>
      <p className="text-xs border-t border-gray-100 pt-4" style={{ color: '#A3B1C2' }}>
        Locked fields protect your account.{' '}
        <a href="mailto:support@betternow.co.za" className="underline underline-offset-2 hover:text-gray-600 transition-colors">
          Contact support
        </a>{' '}
        if one of them is wrong.
      </p>
    </div>
  );

  // ── Salary date — its own section ────────────────────────────────────
  // No provenance line: there is no change-frequency rule and no timestamp.
  // See ../profile/SalaryDaySection.tsx for the full reasoning.
  const salaryDate = <SalaryDaySection current={salaryDay} saveSalaryDay={saveSalaryDay} />;

  // ── Payment cards — the single card-management surface ───────────────
  // Body only: the section header carries the title, so it isn't repeated.
  const paymentCards = (
    <div className="flex flex-col gap-[10px]">
      <p className="text-[12.5px] leading-[1.5]" style={{ color: '#8496AA' }}>
        Your card details are never stored on betternow — they&rsquo;re held by our PCI-DSS
        certified payment partner. We only keep a secure reference to collect your instalments.
      </p>
      <PaymentMethods
        initialCards={cards}
        lockedCardIds={lockedCardIds}
        initializeCardRegistration={initializeCardRegistration}
        changeDefaultCard={changeDefaultCard}
        removeCard={removeCard}
      />
    </div>
  );

  return (
      <div className="flex flex-col gap-[14px]">

        {/* Your record */}
        <div
          className="rounded-[22px] bg-white p-[18px] flex flex-col gap-[14px]"
          style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.5)' }}>Your record</p>
              <p className="mt-2 text-[17px] font-semibold" style={{ color: '#13294B' }}>{recordHeading}</p>
            </div>
            {cleanRecord && (
              <span className="flex-none w-[34px] h-[34px] rounded-full flex items-center justify-center" style={{ background: 'rgba(21,168,158,.13)', color: '#0F766E' }}>
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 10.5l3 3 7-7" />
                </svg>
              </span>
            )}
          </div>
          {/* No ladder to draw yet — so the card shows an empty state with an
              icon rather than a heading with nothing under it. That is what
              distinguishes "nothing here yet" from "still loading", which
              matters most on the one card that arrives above the fold. */}
          {recordSegments.length === 0 ? (
            <EmptyState icon="record" title="Nothing to show yet">
              Your record starts building the first time an instalment is collected on time.
            </EmptyState>
          ) : (
            <>
              <InstalmentLadder segments={recordSegments} />
              <p className="text-[13px] leading-[1.55]" style={{ color: '#8496AA' }}>
                Every payment you keep on time builds your record with betternow.
              </p>
            </>
          )}
        </div>

        {/* Settings — four groups, seven sections, ONE pattern. */}
        <AccountSettings
          personalDetails={personalDetails}
          salaryDate={salaryDate}
          paymentCards={paymentCards}
          passkeys={<PasskeysSection />}
          password={<PasswordSection />}
          notifications={<NotificationsToggle />}
          signOut={<ProfileLogoutSection />}
        />

        {/* ── Footer ──────────────────────────────────────────────────────
            Page FURNITURE, not a section — which is why it is plain text on
            the sheet rather than an eighth card. "Get help" used to be a
            chevron nav-row card, the page's third interaction pattern; as a
            footer link it stops competing with the sections above it and
            still sits where a patient looks for it.

            It now points at /contact rather than a bare mailto:. The page
            carries every channel (email, phone, hours, address), so a
            patient without a configured mail client is no longer stuck.
            The two CONTEXT-SPECIFIC support links are deliberately left as
            mailto: — the locked-fields one below, and the declined-bill
            one on app/patient/orders/DeclinedPlanDetail.tsx, which
            pre-fills a subject line. Sending those through a page would
            add a hop and lose the pre-filled context.

            A plain <a>, not <Link>: /contact is a MARKETING page with its
            own chrome and stylesheets, so this deliberately leaves the app
            shell rather than prefetching landing.css into the patient
            bundle for a link most patients never tap.

            The provenance lines and the build id render only when their data
            exists, so on an account predating the terms columns, or in local
            dev, this footer is simply shorter. */}
        <div className="flex flex-col items-center gap-1.5 pt-3 pb-1 text-center">
          <a
            href="/contact"
            data-testid="account-get-help"
            className="text-[13px] font-semibold underline underline-offset-2 transition-colors hover:opacity-70"
            style={{ color: '#13294B' }}
          >
            Get help
          </a>
          <Provenance>{memberSince}</Provenance>
          <Provenance>{termsLine}</Provenance>
          <Provenance>{appVersion}</Provenance>
        </div>

      </div>
  );
}
