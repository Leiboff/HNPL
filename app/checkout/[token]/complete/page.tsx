import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getPaymentProvider } from '@/lib/payments/provider';
import { saveCardForPatient } from '@/lib/payments/peach/saveCardForPatient';
import { generateTempPassword } from '@/lib/auth/tempPassword';
import { classifyResultCode } from '@/lib/payments/peach/resultCodes';
import { peachRefPurpose } from '@/lib/payments/peach/refs';
import { activateFirstInstalment } from '@/lib/payments/activateFirstInstalment';
import PendingAutoRefresh from './PendingAutoRefresh';

// ─── /checkout/[token]/complete — Peach Checkout V2 return route ────
//
// The V2 embedded widget navigates the browser here on completion and
// appends ?checkoutId=<id>&status=completed. We call the V2 status API
// with the id to fetch the final result.
//
// What this page does, idempotently:
//   1. Fetch the checkout status via `checkoutId`.
//   2. Classify the result code:
//        SUCCESS  → save card + activate plan + redirect to /done
//        PENDING  → show "we're still waiting"; the webhook will finish
//                   the state flip in the background
//        REJECTED → back to /checkout/[token] with an error card
//
// The webhook does its own idempotent state flips in parallel — both
// paths converge on the same rows.

type Params = { token: string };

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
        {/* Plain anchor (NOT next/link) — this is a return-to-checkout
            after a failure and we want a HARD navigation so any
            client-side router cache holding the pre-attempt RSC of
            /checkout/[token] (which would flash the CheckoutForm
            before revalidating to ResumeCapture) is bypassed
            entirely. See page.tsx for the corresponding force-dynamic. */}
        <a
          href={`/checkout/${encodeURIComponent(token)}`}
          className="inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_145%)] px-6 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-colors"
          data-testid="checkout-complete-retry"
        >
          Try again
        </a>
      </div>
    </div>
  );
}

function PendingCard() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center space-y-4">
        <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 flex items-center justify-center">
          <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900">Just a moment…</h1>
        <p className="text-sm text-gray-600">
          Your card is still being processed. This page will update automatically — you can also check your email for a confirmation.
        </p>
        {/* Poll the V2 status by reloading this page; each reload re-runs
            getCheckoutStatus so a pending result advances on its own. */}
        <PendingAutoRefresh />
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
  const checkoutId = sp.checkoutId as string | undefined;

  if (!checkoutId) {
    return <ErrorCard token={token} reason="We didn't get a payment reference back from the payment provider." />;
  }

  // ── Fetch the final status via Peach ──────────────────────────────
  const provider = getPaymentProvider();
  let status: Awaited<ReturnType<typeof provider.getCheckoutStatus>>;
  try {
    status = await provider.getCheckoutStatus(checkoutId);
  } catch (err) {
    return (
      <ErrorCard
        token={token}
        reason={err instanceof Error ? err.message : 'Payment verification failed.'}
      />
    );
  }

  const classified = classifyResultCode(status.resultCode);

  // Verbatim, greppable log of the FULL raw V2 status response. A future
  // misclassification (a success code we don't yet cover; a field we
  // misread) is then diagnosable from Vercel logs in one look — grep
  // "PEACH CHECKOUT STATUS RESPONSE:". status.raw is the untouched V2
  // response body (see toPaymentStatus in the client). We surface the
  // derived resultCode + our verdict alongside so the code→verdict step
  // is visible without re-deriving it.
  console.log('PEACH CHECKOUT STATUS RESPONSE:', {
    checkoutId,
    resultCode:        status.resultCode,
    resultDescription: status.resultDescription,
    classified,
    merchantTransactionId: status.merchantTransactionId,
    hasRegistrationId: !!status.registrationId,
    raw:               status.raw,
  });

  if (classified === 'pending') {
    return <PendingCard />;
  }
  if (classified === 'rejected') {
    return <ErrorCard token={token} reason={status.resultDescription ?? 'Your card was declined. Please try a different card.'} />;
  }
  // SUCCESS below.

  // Merchant transaction id — echoed back on the checkout. We rely on
  // it to look up the payment row and the patient.
  //
  // Purpose gate: the ref must be a Flow A checkout CIT. Refs are the
  // compact 16-char format `bnc<13>` (mintPeachRef('c', …) via
  // checkoutRef) — purpose char 'c'. (A prior bug gated on the literal
  // legacy prefix, which never matches a compact ref and falsely rejected
  // every successful checkout — observed for checkout 03e9c095…, ref
  // bnc26xa9mdv8z0yi. The purpose recogniser is the correct gate; the
  // legacy-prefix fallback is removed — only compact refs are minted now
  // and any legacy session expired long ago.)
  const reference = status.merchantTransactionId;
  const isCheckoutRef = peachRefPurpose(reference) === 'c';
  if (!reference || !isCheckoutRef) {
    return <ErrorCard token={token} reason="This payment reference isn't from a checkout flow." />;
  }

  if (!status.registrationId) {
    return <ErrorCard token={token} reason="The payment provider didn't return a reusable card token. Please try again." />;
  }

  // ── Service-role work: activate plan + save card + accept invite ──
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: payment } = await svc
    .from('payments')
    .select('id, plan_id, patient_id, instalment_number, status')
    .eq('peach_payment_id', reference)
    .maybeSingle();

  if (!payment) {
    return <ErrorCard token={token} reason="Couldn't tie the payment back to your account. Please contact support." />;
  }

  const planId    = payment.plan_id as string;
  const patientId = payment.patient_id as string;

  // Save the card — idempotent; if the webhook raced us we get
  // { kind: 'already_saved' }.
  if (status.card) {
    await saveCardForPatient(
      patientId,
      {
        registrationId: status.registrationId,
        brand:          status.card.brand       ?? null,
        last4:          status.card.last4       ?? null,
        expiryMonth:    status.card.expiryMonth ?? null,
        expiryYear:     status.card.expiryYear  ?? null,
        holder:         status.card.holder      ?? null,
      },
      svc,
    );
  }

  // Store the reusable registration id on the plan (idempotent — only
  // if not already set; the webhook may have won).
  await svc
    .from('plans')
    .update({ peach_registration_id: status.registrationId })
    .eq('id', planId)
    .is('peach_registration_id', null);

  // Store the initial transaction id — required for every subsequent
  // MIT charge on this plan. status.providerPaymentId is the id of
  // this CIT capture; save it as the plan's initialTransactionId.
  if (status.providerPaymentId) {
    await svc
      .from('plans')
      .update({ peach_initial_transaction_id: status.providerPaymentId })
      .eq('id', planId)
      .is('peach_initial_transaction_id', null);
  }

  // Mark instalment #1 collected + activate the plan + insert the
  // payouts row — via the SAME shared, idempotent helper the portal
  // payment-complete route and the Peach webhook use.
  //
  // Previously this route did its own inline payments/plans updates
  // and never inserted a payouts row. Because this synchronous path
  // typically wins the race to flip plans.status to 'active' (same
  // request, no round-trip to Peach's async webhook infra), the
  // webhook's own dedup guard — `if (plan.status === 'active') return`
  // in handlePaymentSuccess — would see the plan already active and
  // skip calling activateFirstInstalment entirely, permanently losing
  // the payout for that plan. Routing through the shared helper here
  // closes that gap: whichever writer gets there first creates the
  // payout, and the other's call is a no-op via the helper's own
  // preconditions.
  const { data: planForActivation } = await svc
    .from('plans')
    .select('id, total_amount, practice_id, provider_id')
    .eq('id', planId)
    .maybeSingle();

  if (planForActivation) {
    const activateResult = await activateFirstInstalment(svc, {
      paymentId: payment.id as string,
      plan: {
        id:           planForActivation.id as string,
        total_amount: planForActivation.total_amount,
        practice_id:  planForActivation.practice_id,
        provider_id:  (planForActivation as { provider_id?: string | null }).provider_id ?? null,
        patient_id:   patientId,
      },
    });
    if (!activateResult.ok) {
      console.error('PEACH CHECKOUT COMPLETE ALERT ACTIVATION-FAILED:', {
        checkoutId, planId, step: activateResult.step, error: activateResult.error,
        note: 'money moved at Peach; awaiting webhook reconcile',
      });
    }
  }

  // Mark the invitation accepted (idempotent). A no-op (0 rows) when
  // this token was a POS session token instead — no patient_invitations
  // row exists for it.
  await svc
    .from('patient_invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('token', token)
    .is('accepted_at', null);

  // Advance the POS counter session to its terminal stage (idempotent).
  // A no-op (0 rows) when this token was an email invitation instead —
  // no checkout_sessions row exists for it. Matches by plan_id (not
  // token) since the session's own token may differ in shape but always
  // points at this same plan.
  await svc
    .from('checkout_sessions')
    .update({ stage: 'completed' })
    .eq('plan_id', planId)
    .neq('stage', 'completed');

  // ── Make sure the patient is still authenticated for /done ────────
  // If their session dropped during the widget interaction (rare — the
  // widget is same-origin, but keep the fallback for parity with the
  // earlier Paystack flow), reset a temp password and sign them back in.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== patientId) {
    const { data: profile } = await svc
      .from('profiles')
      .select('email')
      .eq('id', patientId)
      .single();
    if (profile?.email) {
      const tempPwd = generateTempPassword();
      const { error: updErr } = await svc.auth.admin.updateUserById(patientId, { password: tempPwd });
      if (!updErr) {
        await supabase.auth.signInWithPassword({ email: profile.email, password: tempPwd });
      }
    }
  }

  redirect(`/checkout/${encodeURIComponent(token)}/done`);
}
