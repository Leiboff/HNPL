import Link from 'next/link';
import { paystackRequest } from '@/lib/paystack';

// ─── Types ────────────────────────────────────────────────────────────────────

type VerifyResponse = {
  status:  boolean;
  message: string;
  data: {
    status:           string; // 'success' | 'failed' | 'abandoned' | 'ongoing' | ...
    amount:           number; // kobo (ZAR cents)
    reference:        string;
    gateway_response: string;
  };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRand(kobo: number): string {
  const rands = kobo / 100;
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

function SuccessCard({ amountKobo }: { amountKobo: number }) {
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
          {amountKobo > 0 ? (
            <>Your first instalment of <span className="font-medium text-gray-700">{formatRand(amountKobo)}</span> has been received.</>
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
        className="inline-flex items-center justify-center rounded-lg bg-[#0F4C75] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#0a3a5c] transition-colors"
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
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[#0F4C75]/10 mx-auto">
        <svg className="w-7 h-7 text-[#0F4C75] animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
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
        className="text-sm font-medium text-[#0F4C75] hover:text-[#0a3a5c] transition-colors"
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PaymentCompletePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params    = await searchParams;
  const reference = (params.reference ?? params.trxref) as string | undefined;

  if (!reference) {
    return <NoReferenceCard />;
  }

  // Verify the transaction with Paystack.
  // This is a read-only check — we don't activate anything here; the webhook
  // already did that. We're just showing the patient what happened.
  type TxStatus = 'success' | 'failed' | 'abandoned' | 'pending';
  let txStatus: TxStatus = 'pending';
  let amountKobo = 0;

  try {
    const result = await paystackRequest<VerifyResponse>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

    if (result.status && result.data) {
      amountKobo = result.data.amount;
      const s    = result.data.status;
      if      (s === 'success')   txStatus = 'success';
      else if (s === 'failed')    txStatus = 'failed';
      else if (s === 'abandoned') txStatus = 'abandoned';
      // 'ongoing', 'processing', or anything else stays 'pending'
    }
  } catch (err) {
    // Verification failed (network error, bad reference, etc.). Show pending
    // rather than an error — the webhook may still process it.
    console.error('[payment-complete] Paystack verify error:', err);
  }

  if (txStatus === 'success')   return <SuccessCard amountKobo={amountKobo} />;
  if (txStatus === 'failed')    return <FailedCard />;
  if (txStatus === 'abandoned') return <FailedCard abandoned />;
  return <PendingCard />;
}
