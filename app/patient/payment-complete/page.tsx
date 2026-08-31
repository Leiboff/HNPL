import Link from 'next/link';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getPaymentProvider } from '@/lib/payments/provider';
import { classifyResultCode } from '@/lib/payments/peach/resultCodes';
import { peachRefPurpose } from '@/lib/payments/peach/refs';
import { saveCardForPatient } from '@/lib/payments/peach/saveCardForPatient';
import { logPeachRawResponse } from '@/lib/payments/peach/logRawResponse';
import { activateFirstInstalment } from '@/lib/payments/activateFirstInstalment';

// ─── /patient/payment-complete — Checkout V2 first-payment return ──
//
// The embedded widget navigates the browser here with ?checkoutId=<id>
// after a first-instalment charge (saved-card one-click CIT, or the
// new-card CIT path). We read the V2 status and, on success,
// synchronously:
//   1. save the reusable card (idempotent),
//   2. stamp plans.peach_registration_id,
//   3. stamp plans.peach_initial_transaction_id — the CIT chain root
//      (status.providerPaymentId), so instalments 2-N charge rooted MIT
//      INSTALLMENT rather than the UNSCHEDULED fallback,
//   4. mark instalment 1 collected + activate the plan
//      (activateFirstInstalment).
//
// Every write is precondition-guarded (write-once .is(...null),
// status-guarded activation) so the Peach webhook — which does the same
// stamp+activate for an instalment-1 PAYMENT success — is an idempotent
// backstop, not a double-write.

function formatRand(cents: number): string {
  const rands = cents / 100;
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

// ─── Result cards ─────────────────────────────────────────────────────────────

function ResultCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-6 py-16 flex flex-col items-center text-center">
      <div className="w-full bg-white rounded-2xl border border-gray-200 shadow-sm px-8 py-10 space-y-5">
        {children}
      </div>
    </div>
  );
}

function SuccessCard({ amountCents }: { amountCents: number }) {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-green-100 mx-auto">
        <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Payment successful</h1>
        <p className="mt-1 text-sm text-gray-500">
          {amountCents > 0 ? (
            <>Your first instalment of <span className="font-medium text-gray-700">{formatRand(amountCents)}</span> has been received.</>
          ) : (
            <>Your first instalment has been received.</>
          )}
        </p>
      </div>
      <p className="text-sm text-gray-600">
        Your plan is now active. We&apos;ll debit your remaining instalments automatically on their due dates.
      </p>
      <Link
        href="/patient/orders"
        className="inline-flex items-center justify-center rounded-lg px-6 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg"
        style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
      >
        View my plan →
      </Link>
    </ResultCard>
  );
}

function FailedCard({ abandoned }: { abandoned?: boolean }) {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-red-100 mx-auto">
        <svg className="w-7 h-7 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          {abandoned ? 'Payment cancelled' : 'Payment was not completed'}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {abandoned
            ? 'You left the payment page before completing the transaction.'
            : 'Your card could not be charged. No money has been taken.'}
        </p>
      </div>
      <p className="text-sm text-gray-600">
        Your plan is still pending. You can return to your orders and try again.
      </p>
      <Link
        href="/patient/orders"
        className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Back to orders
      </Link>
    </ResultCard>
  );
}

function PendingCard() {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[var(--portal-ink)]/10 mx-auto">
        <svg className="w-7 h-7 text-[var(--portal-ink)] animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Confirming your payment…</h1>
        <p className="mt-1 text-sm text-gray-500">
          This usually takes a moment. Your plan will activate automatically once confirmed.
        </p>
      </div>
      <Link
        href="/patient/orders"
        className="text-sm font-medium text-[var(--portal-ink)] hover:text-[var(--brand-navy-deep)] transition-colors"
      >
        Check my orders →
      </Link>
    </ResultCard>
  );
}

function NoReferenceCard() {
  return (
    <ResultCard>
      <h1 className="text-xl font-semibold text-gray-900">No payment reference found</h1>
      <p className="text-sm text-gray-500">
        We couldn&apos;t find a payment to confirm. If you&apos;ve just paid, check your orders — it may already be active.
      </p>
      <Link
        href="/patient/orders"
        className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
      >
        View orders
      </Link>
    </ResultCard>
  );
}

// ─── First-instalment activation (idempotent; webhook is the backstop) ──
//
// Best-effort: any failure here is logged and swallowed — the plan still
// shows "successful" (money moved) and the webhook reconciles. We never
// throw out of here, so a transient DB blip can't turn a genuine success
// into a scary error card.
async function activateFirstInstalmentFromStatus(
  checkoutId: string,
  status:     Awaited<ReturnType<ReturnType<typeof getPaymentProvider>['getCheckoutStatus']>>,
): Promise<void> {
  try {
    const reference = status.merchantTransactionId;
    // Only our checkout ('c') refs activate here. A registration ('r')
    // or instalment ('i') ref on this route would be a wiring bug.
    if (!reference || peachRefPurpose(reference) !== 'c') return;

    // Phase-2 chain-root capture: log the FULL raw CIT status body
    // (card-redacted) so we can see which scheme/CIT transaction-id
    // field Peach returns on this saved-card CIT — grep
    // "PEACH CIT CAPTURE (saved-card)". Diagnostic only; stamping is
    // unchanged below (still status.providerPaymentId until the capture
    // confirms the correct field).
    logPeachRawResponse('PEACH CIT CAPTURE (saved-card):', status.raw);

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
    if (!payment || payment.instalment_number !== 1) return;

    // Session ownership check — only activate the signed-in patient's own
    // payment. If the session doesn't match, the webhook still handles it.
    const supabaseUser       = await createServerClient();
    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user || user.id !== payment.patient_id) return;

    const { data: plan } = await svc
      .from('plans')
      .select('id, total_amount, practice_id, provider_member_id, patient_id, status')
      .eq('id', payment.plan_id)
      .maybeSingle();
    if (!plan) return;

    // Save the reusable card (idempotent — the webhook may race us).
    if (status.registrationId && status.card) {
      await saveCardForPatient(
        payment.patient_id as string,
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

    // Stamp the reusable registration id (write-once).
    if (status.registrationId) {
      await svc
        .from('plans')
        .update({ peach_registration_id: status.registrationId })
        .eq('id', plan.id)
        .is('peach_registration_id', null);
    }

    // Stamp the CIT chain root (write-once). status.providerPaymentId is
    // the id of THIS customer-present CIT capture — the initial
    // transaction that established the stored credential. Instalments 2-N
    // thread this as standingInstruction.initialTransactionId.
    if (status.providerPaymentId) {
      await svc
        .from('plans')
        .update({ peach_initial_transaction_id: status.providerPaymentId })
        .eq('id', plan.id)
        .is('peach_initial_transaction_id', null);
    }

    // Mark instalment 1 collected + activate the plan (idempotent).
    const result = await activateFirstInstalment(svc, {
      paymentId: payment.id as string,
      plan: {
        id:           plan.id as string,
        total_amount: plan.total_amount,
        practice_id:  plan.practice_id,
        provider_member_id: (plan as { provider_member_id?: string | null }).provider_member_id ?? null,
        patient_id:   payment.patient_id as string,
      },
    });
    if (!result.ok) {
      console.error('PEACH PAYMENT-COMPLETE ALERT ACTIVATION-FAILED:', {
        checkoutId, planId: plan.id, step: result.step, error: result.error,
        note: 'money moved at Peach; awaiting webhook reconcile',
      });
    }

    // Advance the POS counter session to its terminal stage (idempotent).
    // A no-op (0 rows) for a plan that never had one — which is most plans
    // through this route.
    //
    // This route is the SAVED-CARD return, and it became reachable for a
    // counter session when a returning patient started claiming their own
    // till bill (lib/checkout/claimSessionPlan.ts): they pay from /confirm
    // with a stored card and come back HERE, not to /checkout/[token]/complete
    // where the equivalent write already lived. Without this line that
    // session would sit at 'scanned' forever — the plan goes active, so
    // expire_stale_checkout_session declines to touch it — and the till's
    // activity strip would report "Waiting on patient" for a bill that was
    // paid. Exactly the freeze that has now been fixed twice; not adding a
    // third one.
    //
    // Same predicate as the anonymous completion route, deliberately: matched
    // by plan_id, and `.neq` rather than the closing helper's open-stages-only
    // guard, because a successful payment SHOULD overwrite a 'payment_failed'
    // left by an earlier declined attempt.
    await svc
      .from('checkout_sessions')
      .update({ stage: 'completed' })
      .eq('plan_id', plan.id)
      .neq('stage', 'completed');
  } catch (err) {
    console.error('[payment-complete] activation error (non-fatal; webhook backstop)', err instanceof Error ? err.message : err);
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PaymentCompletePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params     = await searchParams;
  const checkoutId = params.checkoutId as string | undefined;
  const abandoned  = params.status === 'cancelled' || params.status === 'expired';

  if (!checkoutId) {
    return abandoned ? <FailedCard abandoned /> : <NoReferenceCard />;
  }

  let txStatus: 'success' | 'failed' | 'pending' = 'pending';
  let amountCents = 0;

  try {
    const provider = getPaymentProvider();
    const status   = await provider.getCheckoutStatus(checkoutId);
    const c        = classifyResultCode(status.resultCode);
    if (status.amountCents) amountCents = status.amountCents;

    if (c === 'success') {
      txStatus = 'success';
      // Stamp the chain root + activate the plan inline (webhook backstop).
      await activateFirstInstalmentFromStatus(checkoutId, status);
    } else if (c === 'rejected') {
      txStatus = 'failed';
    }
  } catch (err) {
    console.error('[payment-complete] Peach status fetch error:', err);
  }

  if (txStatus === 'success') return <SuccessCard amountCents={amountCents} />;
  if (txStatus === 'failed')  return <FailedCard abandoned={abandoned} />;
  return <PendingCard />;
}
