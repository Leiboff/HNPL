import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PasswordSetForm from './PasswordSetForm';
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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="mx-auto max-w-md px-4 py-3">
          <span
            className="text-lg font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 py-8">
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm text-center space-y-4 mb-4">
          <div className="w-14 h-14 mx-auto rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-gray-900">Payment received</h1>
          <p className="text-sm text-gray-600">
            Your plan is active. One last step — set a password so you can manage it later.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm">
          <PasswordSetForm
            email={user.email ?? ''}
            finalizePassword={finalizePassword}
          />
        </div>
      </main>
    </div>
  );
}
