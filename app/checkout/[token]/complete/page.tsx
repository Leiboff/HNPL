import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { paystackRequest } from '@/lib/paystack';
import { saveCardForPatient, type PaystackAuthorization } from '@/lib/paystack/saveCardForPatient';
import { generateTempPassword } from '@/lib/auth/tempPassword';

// ─── /checkout/[token]/complete ────────────────────────────────────────────
//
// Paystack callback for the anonymous checkout flow. By the time the
// patient arrives here:
//   - The auth user + profile already exist (initiateCheckout did it).
//   - The plan is at pending_first_payment with a payments schedule.
//   - Paystack has either succeeded, declined, or abandoned the charge.
//
// What this page does, idempotently:
//   1. Verify the Paystack transaction.
//   2. If success → save the card to payment_methods (idempotent via
//      saveCardForPatient), mark the invitation accepted, and redirect
//      to the password step.
//   3. If decline → send the patient back to /checkout/[token] with
//      an error param so they can try a different card. The same
//      account + plan are reused on retry — no duplicate accounts.
//
// The existing webhook still does its own work in parallel — it
// flips payment[1] from processing → collected, creates the payout
// row, and (when every instalment is collected) marks the plan
// completed. Both paths are idempotent.

type Params = { token: string };

type PaystackVerifyResponse = {
  status:   boolean;
  message?: string;
  data?: {
    status?:        string;
    reference?:     string;
    authorization?: PaystackAuthorization & { reusable?: boolean };
    metadata?: {
      purpose?:   string;
      patientId?: string;
      planId?:    string;
      token?:     string;
      paymentId?: string;
      [k: string]: unknown;
    };
  };
};

function ErrorCard({ reason, token }: { reason: string; token: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center space-y-4">
        <div className="w-12 h-12 mx-auto rounded-full bg-red-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900">Payment didn&apos;t go through</h1>
        <p className="text-sm text-gray-600">{reason}</p>
        <p className="text-sm text-gray-500">
          Your account is set up but the bill is still unpaid. Try again with the same or a
          different card — no new account will be created.
        </p>
        <Link
          href={`/checkout/${encodeURIComponent(token)}`}
          className="inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_145%)] px-6 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-colors"
        >
          Try again
        </Link>
      </div>
    </div>
  );
}

export default async function CheckoutCompletePage({
  params,
  searchParams,
}: {
  params:       Promise<Params>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const sp        = await searchParams;
  const reference = (sp.reference ?? sp.trxref) as string | undefined;

  if (!reference) {
    return <ErrorCard token={token} reason="We didn't get a payment reference from Paystack." />;
  }

  // ── Verify with Paystack ──────────────────────────────────────────────
  let verify: PaystackVerifyResponse | null = null;
  try {
    verify = await paystackRequest<PaystackVerifyResponse>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
  } catch (err) {
    return (
      <ErrorCard
        token={token}
        reason={err instanceof Error ? err.message : 'Paystack verify failed.'}
      />
    );
  }

  if (!verify?.status) {
    return <ErrorCard token={token} reason={verify?.message ?? 'Paystack rejected the verification.'} />;
  }

  const data    = verify.data;
  const purpose = data?.metadata?.purpose;
  const metaPid = data?.metadata?.patientId;
  const metaPlanId = data?.metadata?.planId;
  const auth    = data?.authorization;

  if (purpose !== 'checkout_first_payment') {
    return <ErrorCard token={token} reason="This payment reference isn't from a checkout flow." />;
  }

  if (data?.status !== 'success') {
    return <ErrorCard token={token} reason={`Card was ${data?.status ?? 'declined'}. Please try a different card.`} />;
  }

  if (!metaPid || !metaPlanId) {
    return <ErrorCard token={token} reason="Couldn't tie the payment back to your account. Please contact support." />;
  }

  if (!auth?.authorization_code) {
    return <ErrorCard token={token} reason="Paystack didn't return a reusable card authorization." />;
  }

  if (auth.reusable === false) {
    return (
      <ErrorCard token={token} reason="Your card came back marked as not reusable. We can't collect the remaining instalments from it." />
    );
  }

  // ── Service-role work: save card, mark accepted, mark payment collected ─
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Save the card. saveCardForPatient is idempotent — if the webhook
  // raced us to it, we get { kind: 'already_saved' } back.
  const saveResult = await saveCardForPatient(metaPid, auth, svc);
  if (saveResult.kind === 'error') {
    return <ErrorCard token={token} reason={`Couldn't save your card: ${saveResult.message}`} />;
  }

  // Mark instalment #1 as collected if the webhook hasn't already.
  // The webhook flips status=processing → collected on charge.success;
  // we do the same here so the page-driven path stays correct even
  // when the webhook is delayed (e.g. localhost without a tunnel).
  await svc
    .from('payments')
    .update({ status: 'collected', collected_at: new Date().toISOString() })
    .eq('plan_id', metaPlanId)
    .eq('instalment_number', 1)
    .eq('status', 'processing');

  // Activate the plan (idempotent — only if still pending_first_payment).
  await svc
    .from('plans')
    .update({ status: 'active' })
    .eq('id', metaPlanId)
    .eq('status', 'pending_first_payment');

  // Mark the invitation accepted (idempotent — only first hit sets the
  // timestamp).
  await svc
    .from('patient_invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('token', token)
    .is('accepted_at', null);

  // ── Make sure the patient is still authenticated for /done ────────────
  // If their session was lost during the Paystack roundtrip (rare but
  // possible in some browsers' third-party-cookie scenarios), reset a
  // temp password and sign them back in so they don't dead-end at
  // "set your password" without a session.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== metaPid) {
    // Get the email of the patient to re-sign-in
    const { data: profile } = await svc
      .from('profiles')
      .select('email')
      .eq('id', metaPid)
      .single();
    if (profile?.email) {
      // Policy-safe temp password — Supabase's admin password-policy
      // check runs against this string too, even though it's plumbing
      // the patient never sees. See lib/auth/tempPassword.ts.
      const tempPwd = generateTempPassword();
      const { error: updErr } = await svc.auth.admin.updateUserById(metaPid, { password: tempPwd });
      if (!updErr) {
        await supabase.auth.signInWithPassword({ email: profile.email, password: tempPwd });
      }
    }
  }

  redirect(`/checkout/${encodeURIComponent(token)}/done`);
}
