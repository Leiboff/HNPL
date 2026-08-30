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
      // Same auth-surface treatment as /signup and /login — deep navy
      // ground, teal light. The white form card is unchanged.
      style={{
        background: 'linear-gradient(180deg, #0A182E 0%, #0D2039 45%, #13294B 100%)',
        backgroundImage: 'radial-gradient(58% 44% at 86% 2%, rgba(21,168,158,.30), transparent 70%), radial-gradient(52% 44% at 2% 92%, rgba(35,80,150,.42), transparent 72%), linear-gradient(180deg, #0A182E 0%, #0D2039 45%, #13294B 100%)',
      }}
    >
      <div className="w-full max-w-md">

        <section
          className="rounded-[28px] border bg-white"
          style={{
            borderColor: 'rgba(19,41,75,0.07)',
            boxShadow:   '0 24px 48px -28px rgba(15,31,58,.28), 0 2px 6px rgba(15,31,58,.04)',
            padding:     '30px 28px 32px',
          }}
        >
          {/* Header row — wordmark + a prominent already-registered link,
              visible without scrolling. */}
          <div className="mb-7 flex items-center justify-between">
            <Link href="/" className="text-[22px] font-bold tracking-[-0.03em]" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              <span style={{ color: '#13294B' }}>better</span><span style={{ color: '#15A89E' }}>now</span>
            </Link>
            <Link
              href="/login"
              data-testid="patient-signup-login-cross-link"
              className="rounded-full bg-[#F1F5F6] px-4 py-2 text-[13px] font-semibold hover:bg-[#E7EDF1]"
              style={{ color: '#13294B' }}
            >
              Log in
            </Link>
          </div>

          <div className="mb-7">
            <h1 className="text-[30px] font-semibold leading-[1.15] tracking-[-0.025em]" style={{ color: '#13294B', fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
              Create your account
            </h1>
            <p className="mt-2 text-[15px] text-[#6B7C93]">Interest-free medical payment plans.</p>
          </div>

          <PatientSignupForm invitation={invitation} token={token ?? null} />
        </section>
      </div>
    </div>
  );
}
