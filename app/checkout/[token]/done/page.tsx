import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PasswordSetForm from './PasswordSetForm';
import StepMedallion from '../_components/StepMedallion';
import { finalizePassword } from '../actions';

// ─── /checkout/[token]/done ────────────────────────────────────────────────
//
// Final step: the bill has been paid, the plan is active, the
// invitation is claimed. The patient is signed in via a temp
// password that initiateCheckout / complete set on their behalf.
// Here they pick the password they'll actually use to log in later.
//
// Once set, they're redirected to /patient — the regular portal.

type Params = { token: string };

export default async function CheckoutDonePage({ params }: { params: Promise<Params> }) {
  // The token URL param is still in the route for symmetry with the
  // rest of the checkout (and so middleware / bookmarking work), but
  // the password-set step doesn't actually need it — the patient is
  // authenticated by the time they reach here.
  await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // No session means something went wrong in the roundtrip from Paystack —
  // route them to /login. The plan is already active under their account
  // either way (the complete page wrote the rows before redirecting).
  if (!user) {
    redirect(`/login?next=${encodeURIComponent('/patient')}`);
  }

  return (
    <div className="min-h-screen bg-[#FAFBFD]">
      <header className="bg-white border-b border-[#E5E9F0]">
        <div className="mx-auto max-w-md px-5 py-4">
          <span
            className="text-lg font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-5 py-8 sm:py-12 space-y-5">
        {/* Calm success header — the moment of relief. No confetti,
            just a clear green medallion and a warm one-line confirm. */}
        <div className="rounded-[20px] border border-[#E5E9F0] bg-white p-6 sm:p-7 shadow-[0_1px_2px_rgba(15,31,58,0.04)] flex items-center gap-4">
          <StepMedallion icon="check" tone="green" />
          <div>
            <h2 className="text-xl font-semibold text-[#0F1F3A]">You&apos;re all set</h2>
            <p className="mt-0.5 text-sm text-[#3A4B66]">
              Your plan is active. We&apos;ll handle the rest.
            </p>
          </div>
        </div>

        <PasswordSetForm
          email={user.email ?? ''}
          finalizePassword={finalizePassword}
        />
      </main>
    </div>
  );
}
