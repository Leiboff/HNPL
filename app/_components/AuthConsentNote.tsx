import Link from 'next/link';

// ─── The one consent line ──────────────────────────────────────────────
//
// Sits beneath a whole stack of sign-in / sign-up options and covers all
// of them, rather than being bolted to any single button.
//
// This started life as a note inside ContinueWithGoogleButton, because
// Google was the only path that created an account without an explicit
// "I agree" tick. That framing was too narrow: a passkey sign-in and an
// email sign-in are equally acts of continuing, and a legal line that
// names only one provider reads as though it applies only to that one.
// Covering the stack is both plainer to the reader and more honest.
//
// Shared rather than pasted into /login and /signup, for the same reason
// the navy gradient is shared: the copy is the disclosure that makes the
// acceptance recorded in /auth/callback legitimate, so the two screens
// must not be able to say different things about the same documents.
//
// Server-safe — pure markup, no hooks.
//
// The button-level note in ContinueWithGoogleButton still exists and is
// still the default, for surfaces that carry that button WITHOUT a line
// like this one (today: /signup/patient, where the button sits above an
// email form with its own tick). A surface that renders this note passes
// showConsentNote={false} so the disclosure is made once, not twice.

type Props = {
  /** Layout only — spacing/alignment differ per screen. */
  className?: string;
  /**
   * The act being consented to, so the line describes what the reader is
   * about to do. /login is signing in; /signup is continuing, because
   * "by signing in" would be plainly wrong above a stack whose primary
   * option creates an account. Everything after the verb is identical,
   * which is the part that must not drift between screens.
   */
  action?: 'signing in' | 'continuing';
};

export default function AuthConsentNote({ className = '', action = 'continuing' }: Props) {
  return (
    <p
      data-testid="auth-consent-note"
      className={`text-center text-[12px] leading-[1.6] text-[var(--auth-dim)] ${className}`}
    >
      By {action} you agree to betternow&apos;s{' '}
      <Link
        href="/legal/terms"
        target="_blank"
        rel="noopener"
        className="font-semibold text-white underline underline-offset-[3px]"
      >
        Terms &amp; Conditions
      </Link>
      {' '}and{' '}
      <Link
        href="/legal/privacy"
        target="_blank"
        rel="noopener"
        className="font-semibold text-white underline underline-offset-[3px]"
      >
        Privacy Policy
      </Link>.
    </p>
  );
}
