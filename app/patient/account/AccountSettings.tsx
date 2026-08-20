import Link from 'next/link';
import ProfileLogoutSection from '@/app/patient/profile/ProfileLogoutSection';

// ─── Account settings — four groups, ONE nav-row pattern ──────────────────
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
// `/patient/account/personal`) is the deep link; the old `resolveSection`
// query-param indirection is gone because there is nothing left for it to
// resolve. The two callers that used to build `?section=...` links
// (app/(auth)/verify-phone/page.tsx, app/patient/orders/[planId]/confirm/
// page.tsx) now link straight at /patient/account/personal.
//
// The four group headers are unchanged from the accordion pass — still
// plain-text, still non-interactive, for the same reason: a group you can
// collapse containing rows you navigate through would be two different
// interaction models stacked on one decision.
//
//   Your details        who you are, plus the two salary fields
//   How you pay          the cards
//   Sign-in & security   how you get in
//   This device          what is true of THIS browser only
//
// Sign out is the one exception to "every row is a route" (2026-08-20,
// reversing the earlier "sign out deserves a whole confirm screen" call):
// ProfileLogoutSection renders directly at the bottom instead of behind its
// own /patient/account/signout screen. It was ONE red button and a line of
// copy — a whole navigable screen for that was a tap of ceremony around an
// action the patient already had to mean to take (the button itself is the
// deliberate tap; a screen in front of it didn't add real friction, just a
// detour). The dedicated route is gone, not left as a redirect: nothing
// else ever linked to it.

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="px-1 pt-2 text-[11px] font-semibold uppercase"
      style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.45)' }}
    >
      {children}
    </p>
  );
}

/** One settings row: title + chevron, navigating to its own screen. Every
 *  row goes through here, so none can drift to another pattern. */
function Row({ href, title }: { href: string; title: string }) {
  return (
    <Link
      href={href}
      className="w-full flex items-center gap-3 px-5 py-4 bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E] focus-visible:ring-inset transition-colors min-h-15"
    >
      <p className="text-sm font-semibold shrink-0" style={{ color: '#13294B' }}>
        {title}
      </p>
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
    </Link>
  );
}

export default function AccountSettings() {
  return (
    <div className="flex flex-col gap-[14px]">

      <GroupHeader>Your details</GroupHeader>
      <Row href="/patient/account/personal" title="Personal details" />

      <GroupHeader>How you pay</GroupHeader>
      <Row href="/patient/account/pay" title="Payment cards" />

      <GroupHeader>Sign-in &amp; security</GroupHeader>
      <Row href="/patient/account/passkeys" title="Passkeys" />
      <Row href="/patient/account/password" title="Password & recovery" />

      <GroupHeader>This device</GroupHeader>
      <Row href="/patient/account/notifications" title="Notifications" />

      <div className="px-1 pt-1">
        <ProfileLogoutSection />
      </div>

    </div>
  );
}
