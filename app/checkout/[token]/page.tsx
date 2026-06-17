import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import CheckoutForm from './CheckoutForm';
import { initiateCheckout } from './actions';

// ─── /checkout/[token] ─────────────────────────────────────────────────────
//
// Anonymous quasi-checkout / quasi-signup page for provider-initiated
// bill invitations. The token in the URL is proof that the patient
// controls the inbox we emailed it to — that's our email
// verification, no OTP needed.
//
// Auth is INTENTIONALLY not required for this route. An anonymous
// visitor can use the whole flow up to the "Pay" submit; the account
// is created at that point as a byproduct of paying. After payment,
// the /done page sets their real password.
//
// Invitation lookup goes through the SECURITY DEFINER RPC
// `get_invitation_by_token` (migration 0049). The function is the
// single anon-accessible surface — there is NO direct anon SELECT on
// patient_invitations, so the bulk-dump vector that the table
// previously exposed is closed. The function returns a row only if
// the invitation is non-expired, unaccepted, and its plan is still
// payable; otherwise it returns nothing and we render the generic
// "no longer valid" state.
//
// Mobile-first — this is a point-of-sale screen used at a practice
// counter or on the move. Single column, large tap targets, no
// horizontal overflow.

type Params = { token: string };

type InvitationRpcRow = {
  email:               string;
  practice_name:       string | null;
  plan_id:             string;
  plan_total_amount:   number | string;
  invoice_number:      string | null;
  practice_reference:  string | null;
};

function InvalidLinkCard({ reason }: { reason: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center space-y-4">
        <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900">This link is no longer valid</h1>
        <p className="text-sm text-gray-600">{reason}</p>
        <p className="text-sm text-gray-500">
          If you think this is a mistake, please ask your practice to send you a new bill.
        </p>
      </div>
    </div>
  );
}

export default async function CheckoutPage({ params }: { params: Promise<Params> }) {
  const { token } = await params;

  if (!token || token.length < 16) {
    return <InvalidLinkCard reason="The checkout link is missing or malformed." />;
  }

  // Anon-callable RPC. No direct SELECT on patient_invitations — the
  // function is the ONLY anon surface, and it returns a single row
  // exactly when the invitation is non-expired + unaccepted + plan is
  // payable. A null / empty result collapses the three previously-
  // distinct UX states (invalid / expired / already-accepted) into
  // one generic message; the privacy fix is worth that.
  const supabase = await createClient();

  const { data: rpcRows, error: rpcErr } = await supabase.rpc('get_invitation_by_token', {
    p_token: token,
  });

  if (rpcErr) {
    console.error('[checkout] get_invitation_by_token failed', rpcErr.message);
    return <InvalidLinkCard reason="Couldn't load this invitation. Please try again in a moment." />;
  }

  // If the function returned nothing, the link is invalid / expired /
  // already accepted / or its plan has moved out of an acceptable
  // state. Send any logged-in caller home to their portal as a
  // courtesy (a returning patient whose bill is already settled
  // belongs there).
  const rows = (rpcRows ?? []) as InvitationRpcRow[];
  if (rows.length === 0) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) redirect('/patient');
    return (
      <InvalidLinkCard reason="This link is no longer valid — it may have expired, already been used, or never existed. If you think this is a mistake, please ask your practice to send you a new bill." />
    );
  }

  const row          = rows[0];
  const practiceName = row.practice_name ?? 'your practice';

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="mx-auto max-w-md px-4 py-3 flex items-center justify-between">
          <span
            className="text-lg font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </span>
          <span className="text-xs text-gray-400">Secure checkout</span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-4 py-6">
        <CheckoutForm
          token={token}
          email={row.email}
          practiceName={practiceName}
          totalAmount={Number(row.plan_total_amount)}
          invoiceNumber={row.invoice_number}
          practiceReference={row.practice_reference}
          initiateCheckout={initiateCheckout}
        />
      </main>
    </div>
  );
}
