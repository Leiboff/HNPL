import Link from 'next/link';
import VerifyEmailForm from './VerifyEmailForm';

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

type Props = {
  searchParams: Promise<{ email?: string; next?: string }>;
};

export default async function VerifyEmailPage({ searchParams }: Props) {
  const { email, next } = await searchParams;

  if (!email || !next) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gray-50">
        <div className="w-full max-w-md bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Missing verification context</h1>
          <p className="text-sm text-gray-500 mb-6">
            We can&apos;t verify your email without knowing which address it was sent to.
            Please sign up again.
          </p>
          <Link href="/signup/patient" className="font-semibold text-[#15A89E] hover:underline">
            Sign up →
          </Link>
        </div>
      </div>
    );
  }

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
          <Link href="/" className="inline-block text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-8">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold" style={{ color: '#13294B', fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              Verify your email
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              We&apos;ve emailed a 6-digit code to{' '}
              <span className="font-medium text-gray-800">{email}</span>.
              {' '}It&apos;s valid for 10 minutes.
            </p>
          </div>

          <VerifyEmailForm email={email} next={next} />
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Wrong email?{' '}
          <Link href="/signup/patient" className="font-semibold hover:underline" style={{ color: '#13294B' }}>
            Sign up again
          </Link>
        </p>
      </div>
    </div>
  );
}
