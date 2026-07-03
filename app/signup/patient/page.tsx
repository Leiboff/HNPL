import { redirect } from 'next/navigation';
import Link from 'next/link';
import PatientSignupForm from './PatientSignupForm';

type Props = {
  searchParams: Promise<{ token?: string }>;
};

// Organic patient signup (someone signing up for BetterNow on their
// own, no bill, no provider). Path is UNCHANGED — same form, same SA
// ID, same password, same OTP email verification.
//
// The old "/signup/patient?token=" path used to handle provider-sent
// invitations too. That's now retired — provider invitations go
// through the dedicated /checkout/[token] flow. Anyone hitting this
// route with a ?token= (e.g. a stale email) is forwarded there so
// there is exactly ONE invite-acceptance path in the system.

export default async function PatientSignupPage({ searchParams }: Props) {
  const { token } = await searchParams;

  if (token) {
    redirect(`/checkout/${encodeURIComponent(token)}`);
  }

  const invitation: { email: string; practiceName: string | null } | null = null;

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{
        background: '#f7fbfb',
        backgroundImage: 'radial-gradient(58% 48% at 84% 0%, rgba(21,168,158,.12), transparent 70%), radial-gradient(48% 42% at 4% 90%, rgba(19,41,75,.07), transparent 70%)',
      }}
    >
      <div className="w-full max-w-md">

        {/* Brand mark + prominent already-registered link. The link is
            visible without scrolling on mobile — placed in the header
            row rather than buried at the bottom. */}
        <div className="mb-8 flex items-center justify-between">
          <Link href="/" className="inline-block text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
            <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
          </Link>
          <Link
            href="/login"
            data-testid="patient-signup-login-cross-link"
            className="text-sm font-semibold rounded-lg border border-[rgba(19,41,75,.12)] bg-white px-3 py-1.5 hover:bg-gray-50"
            style={{ color: '#13294B' }}
          >
            Log in
          </Link>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-8">
          <div className="mb-7">
            <h1 className="text-2xl font-semibold" style={{ color: '#13294B', fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              Create your account
            </h1>
            <p className="mt-1 text-sm text-gray-500">Interest-free medical payment plans.</p>
          </div>

          <PatientSignupForm invitation={invitation} token={token ?? null} />
        </div>

        {/* Footer duplicate — the visible-without-scrolling link lives
            in the header above. This bottom row is still useful for
            long-form completers who reach the end. */}
        <p className="mt-6 text-center text-sm text-gray-500">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold hover:underline" style={{ color: '#13294B' }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
