import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
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
    .select('phone, role')
    .eq('id', user.id)
    .maybeSingle();

  // No phone on profile — signup is the right place to add one. This is
  // a rare edge: the signup action always writes phone, so reaching this
  // branch implies an unusual data state.
  //
  // Was '/signup/patient?missing=phone'. The route is now a redirect to
  // /signup, so this pointed at a bounce; and ?missing=phone was written
  // here and read NOWHERE (verified by grep across app/ and lib/), so it
  // is dropped rather than carried forward as cargo.
  if (!profile?.phone) {
    redirect('/signup');
  }

  // ── Source-of-truth read: phone_verifications, NOT profiles ────────
  //
  // The audit (2026-06-21, H3) flagged that reading verified-state from
  // profiles.phone_verified_at is bypassable if anyone can write the
  // column. Migration 0054 closes the write path; this read change adds
  // defence in depth — we consult the actual verification row written
  // by the SECURITY DEFINER verify_phone_otp_for_user RPC. Even if
  // some future code path lets the column drift, the gate still
  // engages on the row itself.
  //
  // The patient's verified row is keyed by (user_id, phone_e164). We
  // look it up via the service-role client because phone_verifications
  // has NO anon/authenticated RLS policies (locked down per 0052) —
  // only the SECURITY DEFINER RPCs may touch it. Reading from a server
  // component as service-role is fine; we're not exposing the row to
  // the client, just deciding whether to redirect.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data: verification } = await svc
    .from('phone_verifications')
    .select('verified_at')
    .eq('user_id', user.id)
    .eq('phone_e164', profile.phone)
    .not('verified_at', 'is', null)
    .maybeSingle();

  // Already verified — skip the gate.
  if (verification?.verified_at) {
    redirect(target);
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
            href="/patient/account/personal"
            className="font-semibold hover:underline"
            style={{ color: '#13294B' }}
          >
            Update it in your account after sign-in
          </Link>
        </p>
      </div>
    </div>
  );
}
