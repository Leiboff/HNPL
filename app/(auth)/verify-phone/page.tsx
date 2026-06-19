import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import VerifyPhoneClient from './VerifyPhoneClient';
import {
  requestPhoneOtpForUser,
  verifyPhoneOtpForUser,
  skipPhoneVerificationIfNoSms,
} from './actions';

// ─── /verify-phone ───────────────────────────────────────────────────────
//
// Second post-signup screen, immediately after /verify-email confirms
// the email OTP. The patient already has a session at this point —
// the email OTP wrote auth cookies on success — so this route is
// auth-required. Anonymous traffic gets bounced to /login.
//
// What we read on the server:
//   • The session user (must exist + email_confirmed_at must be set).
//   • profiles.phone           — the number the OTP will be sent to.
//   • profiles.phone_verified_at — if already set, redirect to the
//                                  portal immediately (idempotent on
//                                  refresh / back-button).
//   • Whether SMS is configured  — passed to the client as a hint so
//                                  it can render the skip-with-warning
//                                  branch eagerly in dev without
//                                  burning a roundtrip on the
//                                  sms_not_configured code.
//
// `next` search-param mirrors /verify-email: where to land on success
// (default /patient).

type Props = {
  searchParams: Promise<{ next?: string }>;
};

export default async function VerifyPhonePage({ searchParams }: Props) {
  const { next } = await searchParams;
  const target = next || '/patient';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || !user.email_confirmed_at) {
    redirect(`/login?next=${encodeURIComponent('/verify-phone')}`);
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('phone, phone_verified_at, role')
    .eq('id', user.id)
    .maybeSingle();

  // Already verified — skip the gate. Refreshes / back-button after
  // success land here and bounce straight on.
  if (profile?.phone_verified_at) {
    redirect(target);
  }

  // No phone on profile — the signup form is the right place to add
  // one. Send them back to the patient signup with a hint. This is a
  // rare edge: the signup action always writes phone, so reaching
  // this branch implies an unusual data state.
  if (!profile?.phone) {
    redirect('/signup/patient?missing=phone');
  }

  // Hint for the client whether SMS is set up — used to surface the
  // skip-with-warning button without a wasted roundtrip on dev.
  const smsConfigured = Boolean(
    process.env.SMSPORTAL_CLIENT_ID && process.env.SMSPORTAL_CLIENT_SECRET,
  );

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background: '#f7fbfb',
        backgroundImage:
          'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), '
          + 'radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
      }}
    >
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link
            href="/"
            className="inline-block text-2xl font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </Link>
        </div>

        <div className="mb-6 text-center">
          <h1
            className="text-2xl font-semibold"
            style={{ color: '#13294B', fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            Verify your phone
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            One last step — we&apos;ll text a 6-digit code to confirm your number.
          </p>
        </div>

        <VerifyPhoneClient
          phoneDisplay={profile.phone}
          smsConfigured={smsConfigured}
          target={target}
          requestPhoneOtpForUser={requestPhoneOtpForUser}
          verifyPhoneOtpForUser={verifyPhoneOtpForUser}
          skipPhoneVerificationIfNoSms={skipPhoneVerificationIfNoSms}
        />

        <p className="mt-6 text-center text-xs text-gray-400">
          Wrong number?{' '}
          <Link
            href="/patient/profile"
            className="font-semibold hover:underline"
            style={{ color: '#13294B' }}
          >
            Update it in your profile after sign-in
          </Link>
        </p>
      </div>
    </div>
  );
}
