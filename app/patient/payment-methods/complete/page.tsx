import Link from 'next/link';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { paystackRequest } from '@/lib/paystack';
import { saveCardForPatient, type PaystackAuthorization } from '@/lib/paystack/saveCardForPatient';
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

// ─── States ──────────────────────────────────────────────────────────────────

function SuccessCard({ brand, lastFour, alreadySaved }: { brand?: string; lastFour?: string; alreadySaved?: boolean }) {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-green-100 mx-auto">
        <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">
          {alreadySaved ? 'This card is already saved' : 'Card added and verified'}
        </h1>
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
        {alreadySaved
          ? 'No new card was added — you can use this card to collect future instalments.'
          : 'The R1.00 verification charge will be refunded shortly. Your card is ready for future instalment payments.'}
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

function FailureCard({ reference, reason }: { reference: string; reason: string }) {
  return (
    <ResultCard>
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-red-100 mx-auto">
        <svg className="w-7 h-7 text-red-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-semibold text-gray-900">We couldn&apos;t confirm your card</h1>
        <p className="mt-1 text-sm text-gray-500">{reason}</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-center justify-center">
        {/* Retry = same URL with the same reference. The server runs verify
            again on each load. */}
        <Link
          href={`/patient/payment-methods/complete?reference=${encodeURIComponent(reference)}`}
          className="inline-flex items-center justify-center rounded-lg bg-[#13294B] [background:linear-gradient(135deg,#13294B_0%,#15A89E_145%)] px-6 py-2.5 text-sm font-semibold text-white hover:shadow-lg transition-colors"
        >
          Try again
        </Link>
        <Link
          href="/patient/payment-methods"
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
        >
          View payment methods
        </Link>
      </div>
    </ResultCard>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type PaystackVerifyResponse = {
  status:   boolean;
  message?: string;
  data?: {
    status?:        string;                  // 'success' | 'failed' | 'abandoned' | …
    reference?:     string;
    authorization?: PaystackAuthorization & { reusable?: boolean };
    metadata?:      {
      purpose?:   string;
      patientId?: string;
      [k: string]: unknown;
    };
  };
};

export default async function CardRegistrationCompletePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params    = await searchParams;
  const reference = (params.reference ?? params.trxref) as string | undefined;

  if (!reference) return <NoReferenceCard />;

  const supabaseUser       = await createServerClient();
  const { data: { user } } = await supabaseUser.auth.getUser();
  // Window covering checkout (card entry + 3DS) — used for the fast path
  // and for the polling-fallback safety net.
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // ── 1. Fast path: webhook may have already written the row ─────────────────
  if (user) {
    const { data: recentCard } = await supabaseUser
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

  // ── 2. Primary path: verify with Paystack ourselves and write the row ─────
  //
  // This is what makes the flow work on localhost without a webhook tunnel.
  // Even with a tunnel it stays correct — saveCardForPatient is idempotent
  // and the unique-violation race is recovered as "already_saved".
  let verify: PaystackVerifyResponse | null = null;
  try {
    verify = await paystackRequest<PaystackVerifyResponse>(`/transaction/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    console.error('[card-registration-complete] Paystack verify failed', err instanceof Error ? err.message : err);
    return <PollingConfirmation since={since} reference={reference} />;
  }

  if (!verify?.status) {
    return <FailureCard
      reference={reference}
      reason={verify?.message ?? 'Paystack rejected the verification request.'}
    />;
  }

  const data    = verify.data;
  const purpose = data?.metadata?.purpose;
  const metaPid = data?.metadata?.patientId;
  const auth    = data?.authorization;

  if (data?.status !== 'success') {
    return <FailureCard
      reference={reference}
      reason={`The card verification did not complete (${data?.status ?? 'unknown status'}).`}
    />;
  }

  if (purpose !== 'card_registration') {
    return <FailureCard
      reference={reference}
      reason="This payment reference isn't a card registration."
    />;
  }

  if (user && metaPid && metaPid !== user.id) {
    return <FailureCard
      reference={reference}
      reason="This card verification belongs to a different account."
    />;
  }

  const patientId = metaPid ?? user?.id;
  if (!patientId) {
    return <FailureCard
      reference={reference}
      reason="Could not match this verification to your account. Sign in and retry."
    />;
  }

  if (!auth?.authorization_code) {
    return <FailureCard
      reference={reference}
      reason="Paystack didn't return an authorization on the verified transaction."
    />;
  }

  if (auth.reusable === false) {
    return <FailureCard
      reference={reference}
      reason="Your card came back marked as not reusable, so we can't save it for future instalments."
    />;
  }

  // ── 3. Save (or update, or recognise as already saved) — race-safe ──────
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const result = await saveCardForPatient(patientId, auth, svc);

  if (result.kind === 'error') {
    return <FailureCard reference={reference} reason={result.message} />;
  }

  const { data: row } = await svc
    .from('payment_methods')
    .select('card_brand, last_four')
    .eq('id', result.cardId)
    .single();

  return (
    <SuccessCard
      brand={row?.card_brand}
      lastFour={row?.last_four}
      alreadySaved={result.kind === 'already_saved'}
    />
  );
}
