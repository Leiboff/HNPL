import Link from 'next/link';

// ─── Shared back-chevron header for an Account sub-screen ────────────────
//
// Every settings section used to be an AccordionSection's expand/collapse
// panel on ONE page. It is now a real, linkable, back-navigable screen —
// same pattern as the plan-detail screen (app/patient/orders/[planId]/page.tsx):
// a circular back button (→ /patient/account) plus the section title, inside
// PatientScreen's navy header band. Factored here once so the six sub-screens
// (personal, pay, passkeys, password, notifications, signout) can't drift to
// six slightly different back buttons.

export default function SubScreenHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <Link
        href="/patient/account"
        aria-label="Back to account"
        className="flex-none w-[38px] h-[38px] rounded-full flex items-center justify-center"
        style={{ background: 'rgba(255,255,255,.12)' }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m15 6-6 6 6 6" />
        </svg>
      </Link>
      <span className="text-[17px] font-semibold text-white truncate">{title}</span>
    </div>
  );
}
