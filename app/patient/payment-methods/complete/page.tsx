import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { paystackRequest } from '@/lib/paystack';

// ─── Types ────────────────────────────────────────────────────────────────────

type VerifyResponse = {
  status:  boolean;
  message: string;
  data: {
    status:           string;
    amount:           number;
    reference:        string;
    gateway_response: string;
    metadata?: {
      purpose?: string;
    };
  };
};

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

function BrandBadge({ brand }: { brand: string }) {
  const cls =
    brand === 'Visa'       ? 'bg-blue-700 text-white' :
    brand === 'Mastercard' ? 'bg-red-600 text-white'  :
                             'bg-gray-600 text-white';
  return (
    <span className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold tracking-wide ${cls}`}>
      {brand.toUpperCase()}
    </span>
  );
}

function SuccessCard({ brand, lastFour }: { brand?: string; lastFour?: string }) {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-green-100 mx-auto">
        <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Card added and verified</h1>
        {brand && lastFour ? (
          <div className="mt-2 flex items-center justify-center gap-2">
            <BrandBadge brand={brand} />
            <span className="font-mono text-sm text-gray-700">•••• {lastFour}</span>
          </div>
        ) : (
          <p className="mt-1 text-sm text-gray-500">Your card has been saved successfully.</p>
        )}
      </div>
      <p className="text-sm text-gray-600">
        The R1.00 verification charge will be refunded shortly. Your card is ready for future instalment payments.
      </p>
      <Link
        href="/patient/payment-methods"
        className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
      >
        View my cards →
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
          {abandoned ? 'Verification cancelled' : 'Card not added'}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {abandoned
            ? 'You left the payment page before completing verification.'
            : 'The card could not be verified. No money has been taken.'}
        </p>
      </div>
      <p className="text-sm text-gray-600">
        You can return to your payment methods and try again.
      </p>
      <Link
        href="/patient/payment-methods"
        className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
      >
        Back to payment methods
      </Link>
    </ResultCard>
  );
}

function PendingCard() {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-blue-50 mx-auto">
        <svg className="w-7 h-7 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Confirming your card…</h1>
        <p className="mt-1 text-sm text-gray-500">
          This usually takes a moment. Check your payment methods to see if your card has been added.
        </p>
      </div>
      <Link
        href="/patient/payment-methods"
        className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
      >
        Check payment methods →
      </Link>
    </ResultCard>
  );
}

function NoReferenceCard() {
  return (
    <ResultCard>
      <h1 className="text-xl font-semibold text-gray-900">No verification reference found</h1>
      <p className="text-sm text-gray-500">
        We couldn&apos;t find a card verification to confirm. If you&apos;ve just added a card, check your payment methods — it may already be saved.
      </p>
      <Link
        href="/patient/payment-methods"
        className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
      >
        View payment methods
      </Link>
    </ResultCard>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function CardRegistrationCompletePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params    = await searchParams;
  const reference = (params.reference ?? params.trxref) as string | undefined;

  if (!reference) {
    return <NoReferenceCard />;
  }

  // ── Primary check: did the webhook save a card row for this patient? ────────
  // The webhook is the authoritative writer. If a payment_methods row exists
  // that was created very recently, registration succeeded — regardless of what
  // Paystack's transaction status currently shows (it changes as the refund
  // processes: success → reversal_pending → reversed).
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const windowStart = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const { data: recentCard } = await supabase
      .from('payment_methods')
      .select('card_brand, last_four')
      .eq('patient_id', user.id)
      .gte('created_at', windowStart)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentCard) {
      return <SuccessCard brand={recentCard.card_brand} lastFour={recentCard.last_four} />;
    }
  }

  // ── Fallback: verify with Paystack ──────────────────────────────────────────
  // Used when the user has no session or the webhook hasn't fired yet.
  // For card_registration, treat 'reversed' / 'reversal_pending' as success —
  // the refund we initiate causes these transitions after a successful charge.
  type TxStatus = 'success' | 'failed' | 'abandoned' | 'pending';
  let txStatus: TxStatus = 'pending';

  try {
    const result = await paystackRequest<VerifyResponse>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

    if (result.status && result.data) {
      const s       = result.data.status;
      const purpose = result.data.metadata?.purpose;

      const isCardReg = purpose === 'card_registration';
      const chargeWentThrough =
        s === 'success' ||
        (isCardReg && (s === 'reversed' || s === 'reversal_pending'));

      if      (chargeWentThrough) txStatus = 'success';
      else if (s === 'failed')    txStatus = 'failed';
      else if (s === 'abandoned') txStatus = 'abandoned';
    }
  } catch (err) {
    console.error('[card-registration-complete] Paystack verify error:', err);
  }

  if (txStatus === 'success')   return <SuccessCard />;
  if (txStatus === 'failed')    return <FailedCard />;
  if (txStatus === 'abandoned') return <FailedCard abandoned />;
  return <PendingCard />;
}
