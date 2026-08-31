import Link from 'next/link';
import ProfileLogoutSection from '@/app/patient/profile/ProfileLogoutSection';

// ─── Account settings — three grouped cards, ONE nav-row pattern ──────────
//
// Replaces the accordion. Direct product decision (2026-08-20): expanding a
// section in place read as poor UX — tapping a settings row should open a
// full screen with the details, the same way Plans and Practitioner already
// work (app/patient/orders/[planId]/page.tsx, app/patient/practitioner/
// [memberId]/page.tsx), not grow the current page taller. Every former
// AccordionSection is now its own route under /patient/account/*, each
// rendering PatientScreen with a back-chevron header (see SubScreenHeader).
//
// This component itself builds no state and resolves no `?section=`
// deep-link — a row's "detail" IS a route, so linking straight to it (e.g.
// `/patient/account/personal`) is the deep link.
//
// REGROUPED 2026-08-21, matching a reference app's Menu screen: one rounded
// card per group (bold caps header, then rows divided by hairlines) rather
// than a bare-text header floating above a stack of separately-shadowed
// rows. Three groups now, not five — "How you pay" and "This device" each
// had exactly one row, so folding both into General leaves nothing behind:
//
//   General    who you are, your card, and how the app behaves for you
//              (Personal details, Payment cards, Preferences)
//   Security   how you get in (Passkeys, Password & recovery)
//   Support    getting help and the legal documents (Contact us, Terms,
//              Privacy)
//
// "Preferences" is Notifications relabelled, not a new screen — the route
// is still /patient/account/notifications; only the row's title changed,
// so nothing that already linked here needed to move.
//
// Group headers are still plain text, still non-interactive, for the same
// reason as before: a group you can collapse containing rows you navigate
// through would be two different interaction models stacked on one
// decision.
//
// Sign out is still the one exception to "every row is a route" (see the
// prior header this replaced for the full reasoning): ProfileLogoutSection
// renders directly below the cards rather than behind its own screen.

const NAVY = 'var(--portal-ink)';

function GroupCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm overflow-hidden">
      <p
        className="px-5 pt-4 pb-3 text-[11px] font-semibold uppercase"
        style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.45)' }}
      >
        {title}
      </p>
      <div className="border-t border-gray-100 divide-y divide-gray-100">
        {children}
      </div>
    </section>
  );
}

const ROW_CLASS =
  'w-full flex items-center gap-3 px-5 py-4 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--portal-accent)] focus-visible:ring-inset transition-colors min-h-15';

const ChevronRight = (
  <svg
    aria-hidden
    viewBox="0 0 20 20"
    className="w-4 h-4 shrink-0 text-gray-400 ml-auto"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7.5 5l5 5-5 5" />
  </svg>
);

/** One row's leading glyph — small, single-colour outline, same treatment
 *  as components/ProfileFieldRow's icons, kept local because these name
 *  NAVIGATION destinations rather than profile FIELDS. */
type RowIconName = 'person' | 'card' | 'sliders' | 'key' | 'lock' | 'phone' | 'document' | 'shield';

const ROW_ICON_PATHS: Record<RowIconName, React.ReactNode> = {
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.3" />
      <path d="M5.5 20c1-3.2 3.6-5 6.5-5s5.5 1.8 6.5 5" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2.2" />
      <path d="M2.5 10h19" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3" />
      <circle cx="14" cy="7" r="1.8" />
      <circle cx="8" cy="12" r="1.8" />
      <circle cx="14" cy="17" r="1.8" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11.2 11.8 20 3M15.5 6.5l2.5 2.5M13 9l2 2" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="9" rx="2.2" />
      <path d="M7.5 11V7.5a4.5 4.5 0 0 1 9 0V11" />
    </>
  ),
  phone: (
    <path d="M7 3.5c.9 0 1.7.6 2 1.4l.8 2c.3.8.1 1.7-.5 2.3l-1 1c1 2.2 2.7 3.9 4.9 4.9l1-1c.6-.6 1.5-.8 2.3-.5l2 .8c.8.3 1.4 1.1 1.4 2v1.7c0 1.3-1.1 2.3-2.4 2.1-6.7-1-12-6.3-13-13C4.4 5.6 5.4 4.5 6.7 4.5H7Z" />
  ),
  document: (
    <>
      <path d="M6.5 3h8l4 4v14h-12Z" />
      <path d="M14.5 3v4h4M9 12h6M9 15.5h6M9 8.5h2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 19 6v5.5c0 4.6-3 7.9-7 9.3-4-1.4-7-4.7-7-9.3V6Z" />
      <path d="M8.7 12.2 11 14.5l4.3-4.3" />
    </>
  ),
};

function RowIcon({ name }: { name: RowIconName }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={19}
      height={19}
      fill="none"
      stroke={NAVY}
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none"
    >
      {ROW_ICON_PATHS[name]}
    </svg>
  );
}

function RowContent({ title, icon }: { title: string; icon: RowIconName }) {
  return (
    <>
      <RowIcon name={icon} />
      <p className="text-sm font-semibold shrink-0" style={{ color: NAVY }}>
        {title}
      </p>
      {ChevronRight}
    </>
  );
}

/** One settings row: icon + title + chevron, navigating to its own screen.
 *  Every in-app row goes through here, so none can drift to another
 *  pattern. */
function Row({ href, title, icon }: { href: string; title: string; icon: RowIconName }) {
  return (
    <Link href={href} className={ROW_CLASS}>
      <RowContent title={title} icon={icon} />
    </Link>
  );
}

/**
 * Same row, for a destination OUTSIDE the app shell — a plain <a>, not
 * <Link>. /legal/terms and /legal/privacy are marketing-chrome pages
 * (SiteHeader/SiteFooter, their own stylesheets), the same reason the
 * footer's "Get help" link on app/patient/account/page.tsx leaves via a
 * plain <a> rather than prefetching landing.css into the patient bundle.
 */
function ExternalRow({ href, title, icon }: { href: string; title: string; icon: RowIconName }) {
  return (
    <a href={href} className={ROW_CLASS}>
      <RowContent title={title} icon={icon} />
    </a>
  );
}

export default function AccountSettings() {
  return (
    <div className="flex flex-col gap-[14px]">

      <GroupCard title="General">
        <Row href="/patient/account/personal"      title="Personal details" icon="person" />
        <Row href="/patient/account/pay"            title="Payment cards"    icon="card" />
        <Row href="/patient/account/notifications"  title="Preferences"      icon="sliders" />
      </GroupCard>

      <GroupCard title="Security">
        <Row href="/patient/account/passkeys" title="Passkeys" icon="key" />
        <Row href="/patient/account/password" title="Password & recovery" icon="lock" />
      </GroupCard>

      <GroupCard title="Support">
        <Row         href="/patient/account/contact" title="Contact us" icon="phone" />
        <ExternalRow href="/legal/terms"              title="Terms & conditions" icon="document" />
        <ExternalRow href="/legal/privacy"             title="Privacy policy" icon="shield" />
      </GroupCard>

      <div className="px-1 pt-1">
        <ProfileLogoutSection />
      </div>

    </div>
  );
}
