import Link from 'next/link';
import VerifyEmailForm from './VerifyEmailForm';
import AuthSurface from '@/app/_components/AuthSurface';
import AuthWordmark from '@/app/_components/AuthWordmark';
import {
  AUTH_TITLE_CLS,
  AUTH_SUBTITLE_CLS,
  AUTH_LINK_CLS,
  AUTH_HELP_CLS,
} from '@/app/_components/authFormStyles';

// ─── /verify-email ───────────────────────────────────────────────────────────
//
// Sole post-signup screen. Patient and practice signup actions redirect here
// after Supabase's signUp() has been called (which triggers Supabase to
// email the 6-digit OTP per the dashboard email template). The user enters
// the code and the client component calls verifyOtp({type:'email'}). On
// success it hard-navigates to `next` (the role-specific landing page).
//
// Search params:
//   email — required, the address Supabase emailed the code to
//   next  — required, where to send the user after a successful verify
//          (e.g. /patient, /practice)
//
// Sits on the shared auth surface, like /login, /signup and every
// /onboarding step: this screen arrives seconds after the signup form and
// used to arrive as a white card, which read as a different product.

type Props = {
  searchParams: Promise<{ email?: string; next?: string }>;
};

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { email, next } = await searchParams;

  if (!email || !next) {
    return (
      <AuthSurface centred>
        <AuthWordmark size="md" />
        <h1 className={`mt-9 text-center ${AUTH_TITLE_CLS}`}>Missing verification context</h1>
        <p className={`mt-3 text-center ${AUTH_SUBTITLE_CLS}`}>
          We can&apos;t verify your email without knowing which address it was sent to.
          Please sign up again.
        </p>
        <p className="mt-7 text-center">
          <Link href="/signup" className={AUTH_LINK_CLS}>Sign up →</Link>
        </p>
      </AuthSurface>
    );
  }

  return (
    <AuthSurface>
      <AuthWordmark size="md" />

      <div className="mt-9">
        <h1 className={AUTH_TITLE_CLS}>Verify your email</h1>
        <p className={`mt-2.5 ${AUTH_SUBTITLE_CLS}`}>
          We&apos;ve emailed a 6-digit code to{' '}
          <span className="font-semibold text-white">{email}</span>.
          {' '}It&apos;s valid for 10 minutes.
        </p>
      </div>

      {/* The form pins its CTA with mt-auto, so it needs a column with a
          floor to pin against — the same contract, and the same floor,
          OnboardingShell gives the step bodies. */}
      <div className="mt-8 flex flex-col" style={{ minHeight: 280 }}>
        <VerifyEmailForm email={email} next={next} />
      </div>

      <p className={`mt-8 text-center ${AUTH_HELP_CLS}`}>
        Wrong email?{' '}
        <Link href="/signup" className={AUTH_LINK_CLS}>Sign up again</Link>
      </p>
    </AuthSurface>
  );
}
