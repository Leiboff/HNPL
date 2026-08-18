// ─── Password & recovery ──────────────────────────────────────────────────
//
// There was no way to change a password from the patient account page at all.
// The route to do it has always existed (/forgot-password, which is
// role-agnostic and enumeration-safe by design) — nothing on this screen
// pointed at it, so a patient wanting to change their password had to sign
// out and use the "forgot password" link as though they had forgotten it.
//
// This adds the pointer, not a new mechanism. No auth code, no new action, no
// second reset path: the link goes to the existing page and the existing flow
// emails the existing link. What changes is that the door is now visible from
// inside the account.
//
// PROGRESSIVE DISCLOSURE. Changing a password is rare and consequential, so
// it does not sit inline beside everyday settings — it is one of the seven
// collapsed sections, and the section explains the consequence (an email
// arrives; other devices are unaffected) BEFORE offering the button. A
// patient who opens it by accident learns what it does and closes it.
//
// Presentational only: a plain server component, no state, no data access.

export default function PasswordSection() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] leading-[1.55]" style={{ color: '#8496AA' }}>
        We&rsquo;ll email you a secure link to set a new password. The link works once and
        expires. Signing in on your other devices isn&rsquo;t affected until you use it.
      </p>

      <a
        href="/forgot-password"
        data-testid="account-password-reset"
        className="inline-flex w-fit items-center gap-1.5 rounded-xl border px-3.5 py-2 text-[13px] font-semibold transition-colors hover:bg-gray-50"
        style={{ borderColor: 'rgba(19,41,75,.14)', color: '#13294B' }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
          <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        </svg>
        Email me a reset link
      </a>

      <p className="text-[11.5px] leading-[1.5]" style={{ color: '#A3B1C2' }}>
        Prefer not to type a password at all? Add a passkey above and sign in with your
        face, fingerprint or device PIN.
      </p>
    </div>
  );
}
