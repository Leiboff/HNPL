import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '../PatientScreen';
import InstalmentLadder, { type LadderSegment } from '../InstalmentLadder';
import AccountSettings from './AccountSettings';
import { deriveInstalmentStatus } from '@/lib/patient/instalmentStatus';
import EmptyState from '@/components/EmptyState';
import { resolveAppVersion } from '@/lib/appVersion';
import { todaySAST, formatDate } from '../_format';
import { getRequestUser } from '@/lib/auth/requestUser';
import { cardBrandLabel } from '@/lib/patient/cardBrand';
import AccountInstallRow from './AccountInstallRow';
import { maskEmail } from './mask';

// ─── Account — the settings index ─────────────────────────────────────────
//
// Account and Profile are ONE page. This screen is now an INDEX: the record
// (earned, read-only, so it stays here rather than behind a tap) plus a menu
// of settings rows, each of which opens its own screen — see AccountSettings
// for the four groups and app/patient/account/*/page.tsx for the screens
// themselves.
//
// ─── WHAT CHANGED, AND WHY (2026-08-20) ───────────────────────────────
//
// This used to be a single page holding everything: four accordion sections
// that expanded IN PLACE. Direct product decision: expanding in place read
// as poor UX on a settings page — a row should open a real screen with the
// details, the same way every other "tap a row, see more" surface in this
// app already works (Plans, Practitioner). So the section bodies moved out
// to their own routes, and this page's job shrank to "the record, plus the
// menu that gets you to everything else." It no longer fetches payment
// cards, phone, SA ID, or salary — each of those now lives on the screen
// that shows them and fetches only what IT needs.
//
// ─── THE RECORD IS NOT A SETTING ──────────────────────────────────────
//
// "Your record" stays outside the settings menu, directly under the navy
// header, as the sheet's first and largest object. Three reasons: it is the
// only thing on this page that was EARNED rather than configured; it is
// read-only, so "tap to open a screen" does not apply to it; and the
// InstalmentLadder is the app's signature object (Home, both Plans lists,
// Plan detail), so the page that summarises it should lead with it rather
// than filing it under a menu row.
//
// Honesty (unchanged): the record shows the count of payments actually made —
// no invented rewards tier, no "we'll review your limit" promise, because
// that policy does not exist in code.

/** Discreet provenance under a field or in the footer. Renders NOTHING when
 *  `children` is null/undefined — the whole point: a missing timestamp must
 *  produce no element at all, never the string "undefined". */
/** The v5 card surface — one shadow and one border across the portal. */
const CARD_SHADOW = '0 2px 8px -3px rgba(15,31,58,.09)';
const CARD_BORDER = '1px solid rgba(19,41,75,.06)';

function Provenance({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p className="text-[11.5px]" style={{ color: 'var(--portal-muted)' }} data-testid="provenance">
      {children}
    </p>
  );
}

export default async function AccountPage() {
  const supabase = await createClient();

  const user = await getRequestUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { data: rawPayments }, { data: rawCards }] = await Promise.all([
    supabase
      .from('profiles')
      .select('first_name, last_name, created_at, terms_accepted_at, terms_version')
      .eq('id', user.id)
      .single(),
    supabase.from('payments').select('status, due_date, next_attempt_date').eq('patient_id', user.id).eq('kind', 'instalment'),
    // Just enough to label the Payment cards row with the card that is
    // actually on file. A settings list a patient has to tap to find out
    // what is already set is a list of questions, not a list of settings.
    supabase
      .from('payment_methods')
      .select('card_brand, last_four, is_default')
      .eq('patient_id', user.id)
      .is('archived_at', null)
      .order('is_default', { ascending: false })
      .limit(1),
  ]);

  const firstName = (profile?.first_name as string | null) ?? '';
  const lastName  = (profile?.last_name  as string | null) ?? '';
  const fullName  = [firstName, lastName].filter(Boolean).join(' ') || '—';

  // Initials for the identity circle. Falls back to the first letter of
  // the email when the profile has no name yet — never to a placeholder
  // glyph, which reads as a broken avatar rather than as a new account.
  const initials = [firstName, lastName].filter(Boolean).map((n) => n[0]!.toUpperCase()).join('')
    || (user.email?.[0]?.toUpperCase() ?? '?');

  const defaultCard = (rawCards ?? [])[0] as { card_brand: string | null; last_four: string | null } | undefined;
  // null, never undefined: this page's rule is that an absent value
  // produces no element at all, and `null` is the shape the rest of the
  // page (Provenance, the detail slot) already reads as "nothing here".
  const cardDetail: string | null = defaultCard?.last_four
    ? `${cardBrandLabel(defaultCard.card_brand)} ···· ${defaultCard.last_four}`
    : null;

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

  // ── An identity row, not a navy band ──────────────────────────────
  //
  // v4 put the patient's name on the same dark slab Home uses for the
  // balance. Account has no figure to lead with, so the band was carrying
  // a name — and the name is not news to the person reading it. As a
  // plain row it does the one job it should: confirm WHICH account this
  // is, which is what the masked email under it is for.
  const header = (
    <div className="flex items-center gap-[14px]">
      <span
        className="flex-none w-[52px] h-[52px] rounded-full flex items-center justify-center text-[18px] font-semibold text-white"
        style={{ background: 'var(--brand-navy-deep)' }}
        aria-hidden
      >
        {initials}
      </span>
      <div className="min-w-0">
        <p className="text-[17px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{fullName}</p>
        {maskEmail(user.email) && (
          <p className="mt-[3px] text-[12.5px] truncate" style={{ color: 'var(--portal-faint)' }}>
            {maskEmail(user.email)}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <PatientScreen tone="plain" header={header} sheetClassName="px-[18px] pb-6">
      <div className="flex flex-col gap-[14px]">

        {/* ── On-time record ───────────────────────────────────────────
            Stays outside the settings menu and first on the sheet. It is
            the only thing on this page that was EARNED rather than
            configured; it is read-only, so "tap to open a screen" does not
            apply to it; and the ladder is the app's signature object, so
            the page that summarises it should lead with it.

            Honest: it counts payments actually made. No invented rewards
            tier and no "we'll review your limit" promise — that policy
            does not exist in code. */}
        <div
          className="bn-up rounded-card bg-white p-[18px] flex flex-col gap-[13px]"
          style={{ border: CARD_BORDER, boxShadow: CARD_SHADOW }}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.16em', color: 'var(--portal-faint)' }}>
              On-time record
            </p>
            {cleanRecord && (
              <span className="flex-none w-[26px] h-[26px] rounded-full flex items-center justify-center" style={{ background: 'rgba(21,168,158,.13)', color: 'var(--portal-accent-ink)' }} aria-hidden>
                <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
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
              <p className="text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
                {recordHeading} · every payment you keep on time builds your record with betternow.
              </p>
            </>
          )}
        </div>

        {/* Settings — four groups, seven rows, each its own screen. */}
        <AccountSettings cardDetail={cardDetail} />

        <AccountInstallRow />

        {/* ── Footer ──────────────────────────────────────────────────────
            Page FURNITURE, not a section — which is why it is plain text on
            the sheet rather than an eighth row. "Get help" used to be a
            chevron nav-row card, a competing pattern; as a footer link it
            stops competing with the menu above it and still sits where a
            patient looks for it.

            It points at /contact rather than a bare mailto:. The page
            carries every channel (email, phone, hours, address), so a
            patient without a configured mail client is no longer stuck.
            The two CONTEXT-SPECIFIC support links are deliberately left as
            mailto: — the locked-fields one on the Personal details screen,
            and the declined-bill one on app/patient/orders/DeclinedPlanDetail.tsx,
            which pre-fills a subject line. Sending those through a page
            would add a hop and lose the pre-filled context.

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
            style={{ color: 'var(--portal-ink)' }}
          >
            Get help
          </a>
          <Provenance>{memberSince}</Provenance>
          <Provenance>{termsLine}</Provenance>
          <Provenance>{appVersion}</Provenance>
        </div>

      </div>
    </PatientScreen>
  );
}
