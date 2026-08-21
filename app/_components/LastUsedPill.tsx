// ─── "Last used" flag — shared between /login's three sign-in options ────
//
// Same small teal pill above whichever of passkey / Google / password
// succeeded last on this browser (see lib/auth/lastSignInMethod.ts). Lives
// here, not inlined in each spot, because it's rendered from both
// ContinueWithGoogleButton.tsx and app/(auth)/login/page.tsx — two call
// sites is exactly the point where a shared component earns its keep
// rather than staying duplicated.

export default function LastUsedPill() {
  return (
    <p
      className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase"
      style={{ color: '#0C8579', letterSpacing: '.04em' }}
    >
      <svg viewBox="0 0 20 20" width="9" height="9" fill="none" stroke="#0C8579" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 10l4 4 8-8" />
      </svg>
      Last used
    </p>
  );
}
