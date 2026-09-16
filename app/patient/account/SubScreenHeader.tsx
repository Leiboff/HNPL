import Link from 'next/link';

// ─── Shared back-chevron header for an Account sub-screen ────────────────
//
// Every settings section used to be an AccordionSection's expand/collapse
// panel on ONE page. It is now a real, linkable, back-navigable screen —
// same pattern as the plan-detail screen (app/patient/orders/[planId]/page.tsx):
// a circular back button (→ /patient/account) plus the section title.
// Factored here once so the six sub-screens (personal, pay, passkeys,
// password, notifications, signout) can't drift to six slightly different
// back buttons.
//
// It sits ON the light sheet, not in a navy band. v4 gave these screens the
// same dark slab Home uses for the balance; a navy bar whose only content
// is a back arrow and the words "Password & recovery" spends the shell's
// loudest object on the least information on the screen. The band now means
// one thing — this screen leads with a figure — and none of these do. See
// the `plain` tone in PatientScreen.

export default function SubScreenHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <Link
        href="/patient/account"
        aria-label="Back to account"
        className="flex-none w-9 h-9 rounded-full flex items-center justify-center"
        style={{ background: '#fff', border: '1px solid var(--portal-hairline)', color: 'var(--portal-ink)' }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m15 6-6 6 6 6" />
        </svg>
      </Link>
      <span className="text-[17px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{title}</span>
    </div>
  );
}
