import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import PollingConfirmation from './PollingConfirmation';

// ─── Shared layout wrapper ────────────────────────────────────────────────────

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

// ─── Fast-path: webhook already saved the card ────────────────────────────────

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
        className="inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_145%)] px-6 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-colors"
      >
        View my cards →
      </Link>
    </ResultCard>
  );
}

// ─── Edge case: no reference in URL ──────────────────────────────────────────

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

  // A window that comfortably covers the Paystack checkout flow (card entry + 3DS)
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // Fast path: if the webhook has already written the card row, show success with no JS needed.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    const { data: recentCard } = await supabase
      .from('payment_methods')
      .select('card_brand, last_four')
      .eq('patient_id', user.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentCard) {
      return <SuccessCard brand={recentCard.card_brand} lastFour={recentCard.last_four} />;
    }
  }

  // Webhook hasn't fired yet — hand off to the client to poll every second for up to 10 s.
  return <PollingConfirmation since={since} />;
}
