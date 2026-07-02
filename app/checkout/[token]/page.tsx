import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import CheckoutForm from './CheckoutForm';
import { initiateCheckout, requestPhoneOtp, verifyPhoneOtp } from './actions';
import { isAllowedSalaryDay } from '@/lib/salaryDates';

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
    <div className="min-h-screen flex items-center justify-center px-5 py-12 bg-[#FAFBFD]">
      <div className="w-full max-w-md rounded-[20px] bg-white border border-[#E5E9F0] p-8 text-center space-y-4 shadow-[0_1px_2px_rgba(15,31,58,0.04)]">
        <div className="w-14 h-14 mx-auto rounded-full bg-[#FBF1DD] ring-1 ring-[#C8841C]/20 flex items-center justify-center text-[#8A5A11]">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v5M12 16.25h.008" />
          </svg>
        </div>
        <h1 className="text-2xl font-semibold text-[#0F1F3A] tracking-[-0.01em]">
          This link is no longer valid
        </h1>
        <p className="text-[15px] leading-relaxed text-[#3A4B66]">{reason}</p>
        <p className="text-sm text-[#7A8AA0]">
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

  // Post-0065: salary_day is a profile-first field. If a profile
  // already exists for the invitation's email AND has a salary_day
  // stored, we skip the checkout picker (it's derivable server-side
  // at initiateCheckout time). Otherwise the form shows the inline
  // picker so the value is captured once and persisted alongside
  // the plan creation.
  //
  // Service-role client scoped to a single lookup by email — safe
  // because the invitation RPC (SECURITY DEFINER) already proved
  // the caller controls this inbox. If the lookup fails for any
  // reason we default to "no salary day known" and the picker
  // renders — never blocks the flow.
  let initialSalaryDay: number | null = null;
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data: existingProfile } = await svc
      .from('profiles')
      .select('salary_day')
      .eq('email', row.email)
      .maybeSingle();
    const stored = existingProfile?.salary_day as number | null | undefined;
    if (isAllowedSalaryDay(stored)) initialSalaryDay = stored;
  } catch (err) {
    console.warn('[checkout] salary_day lookup failed (non-fatal)',
      err instanceof Error ? err.message : err);
  }

  // ── viewed_at stamp ────────────────────────────────────────────────────
  // Drives the practice-side "Viewed" lifecycle signal (the receptionist
  // wants to know the patient at least opened the link). The RPC is
  // idempotent — it only writes on the first call per invitation — so
  // re-loading the page does not overwrite the original timestamp.
  //
  // CRITICAL: this MUST NOT block the patient. A transient RPC failure
  // (DB hiccup, the migration not yet applied) is non-fatal — we render
  // the form regardless. The promise is awaited so the request lifecycle
  // captures it, but any error is swallowed.
  try {
    const { error: stampErr } = await supabase.rpc('stamp_invitation_viewed', { p_token: token });
    if (stampErr) {
      console.warn('[checkout] stamp_invitation_viewed failed (non-fatal)', stampErr.message);
    }
  } catch (err) {
    console.warn(
      '[checkout] stamp_invitation_viewed threw (non-fatal)',
      err instanceof Error ? err.message : err,
    );
  }

  return (
    <div className="min-h-screen bg-[#FAFBFD]">
      <header className="bg-white border-b border-[#E5E9F0] sticky top-0 z-10">
        <div className="mx-auto max-w-md px-5 py-4 flex items-center justify-between">
          <span
            className="text-lg font-bold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: '#13294B' }}>better</span>
            <span style={{ color: '#15A89E' }}>now</span>
          </span>
          <span className="text-[11px] uppercase tracking-[0.08em] font-medium text-[#7A8AA0]">
            Secure checkout
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-md px-5 py-8 sm:py-10">
        <CheckoutForm
          token={token}
          email={row.email}
          practiceName={practiceName}
          totalAmount={Number(row.plan_total_amount)}
          invoiceNumber={row.invoice_number}
          practiceReference={row.practice_reference}
          initialSalaryDay={initialSalaryDay}
          initiateCheckout={initiateCheckout}
          requestPhoneOtp={requestPhoneOtp}
          verifyPhoneOtp={verifyPhoneOtp}
        />
      </main>
    </div>
  );
}
