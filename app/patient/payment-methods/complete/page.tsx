import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getPaymentProvider } from '@/lib/payments/provider';
import { classifyResultCode } from '@/lib/payments/peach/resultCodes';
import { saveCardForPatient } from '@/lib/payments/peach/saveCardForPatient';
import PollingConfirmation from './PollingConfirmation';

// ─── Peach COPYandPAY return route for the "add card" flow ──────────
//
// Registration-only checkout (Flow B — dual-door architecture; see
// lib/payments/peach/copyandpay/registration.ts). No debit, no PA
// hold, no refund. On return the COPYandPAY widget navigates the
// browser to `shopperResultUrl?resourcePath=/v1/checkouts/{id}/registration`
// (note: the `/registration` suffix is what Peach's own docs specify
// for a REGISTRATION-ONLY checkout — a paying checkout would use
// `/payment` instead; we accept either shape since the same GET
// endpoint answers both). We fetch the status via
// provider.getCardRegistrationStatus to discover the newly-created
// registrationId + card metadata, then save the payment_methods row
// idempotently.
//
// Idempotency posture: `saveCardForPatient` dedupes on the synthetic
// fingerprint (brand + last4 + expiry) — hitting this URL twice for
// the same card returns `kind: 'already_saved'` cleanly. The fast
// path below (recent-card lookup) short-circuits the second visit
// without even a Peach round-trip when the webhook or a prior render
// has already landed the row.
//
// This route is Flow B ONLY. Flow A's return route lives at
// app/checkout/[token]/complete/page.tsx (uses Checkout V2 status
// via getCheckoutStatus) — DO NOT re-route this into V2.

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
    /VISA/i.test(brand)       ? 'bg-blue-700 text-white' :
    /MASTER/i.test(brand)     ? 'bg-red-600 text-white'  :
                                'bg-gray-600 text-white';
  return (
    <span className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold tracking-wide ${cls}`}>
      {brand.toUpperCase()}
    </span>
  );
}

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
          {alreadySaved ? 'This card is already saved' : 'Card added'}
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
          : 'Your card is ready for future instalment payments.'}
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

function FailureCard({ resourcePath, reason }: { resourcePath: string; reason: string }) {
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
        <Link
          href={`/patient/payment-methods/complete?resourcePath=${encodeURIComponent(resourcePath)}`}
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

export default async function CardRegistrationCompletePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params       = await searchParams;
  const resourcePath = (params.resourcePath ?? params.resource_path) as string | undefined;

  if (!resourcePath) return <NoReferenceCard />;

  const supabaseUser       = await createServerClient();
  const { data: { user } } = await supabaseUser.auth.getUser();
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // ── 1. Fast path (idempotency) — recent card already on file ──────
  //     If the user hit refresh, back-button, or "Try again" after a
  //     successful save, we short-circuit here with the SuccessCard
  //     BEFORE re-calling Peach. The window is 5 minutes; the
  //     fingerprint dedup in saveCardForPatient covers any collisions
  //     outside that window.
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

  // ── 2. Primary path: ask Peach for the registration status ────────
  //     resourcePath for a Flow B registration-only completion is
  //     `/v1/checkouts/{id}/registration` (per Peach docs). We also
  //     accept `/v1/checkouts/{id}/payment` from the widget without
  //     rewriting — the GET endpoint answers both suffixes.
  const provider = getPaymentProvider();
  let status: Awaited<ReturnType<typeof provider.getCardRegistrationStatus>>;
  try {
    status = await provider.getCardRegistrationStatus(resourcePath);
  } catch (err) {
    console.error('[card-registration-complete] Peach status fetch failed', err instanceof Error ? err.message : err);
    return <PollingConfirmation since={since} reference={resourcePath} />;
  }

  const classified = classifyResultCode(status.resultCode);
  // 000.200.* etc. → the acquirer is still working. Show the polling
  // view; we DO NOT redirect back into the widget on this branch. The
  // polling component watches for the payment_methods row (webhook or
  // eventual completion of the pending path) and flips to Success or
  // Timeout on its own.
  if (classified === 'pending') {
    return <PollingConfirmation since={since} reference={resourcePath} />;
  }
  if (classified === 'rejected') {
    return <FailureCard
      resourcePath={resourcePath}
      reason={status.resultDescription ?? 'The card verification did not complete.'}
    />;
  }

  if (!status.registrationId || !status.card) {
    return <FailureCard
      resourcePath={resourcePath}
      reason="Peach didn't return a stored registration on the verified transaction."
    />;
  }

  // ── 3. Resolve the patient ────────────────────────────────────────
  // customParameters carries SHOPPER_patientId on our own checkouts.
  const rawCustom = (status.raw as { customParameters?: Record<string, string> } | null)?.customParameters ?? {};
  const metaPid   = rawCustom.SHOPPER_patientId ?? rawCustom.patientId;

  if (user && metaPid && metaPid !== user.id) {
    return <FailureCard
      resourcePath={resourcePath}
      reason="This card verification belongs to a different account."
    />;
  }

  const patientId = metaPid ?? user?.id;
  if (!patientId) {
    return <FailureCard
      resourcePath={resourcePath}
      reason="Could not match this verification to your account. Sign in and retry."
    />;
  }

  // ── 4. Save the card — race-safe, idempotent ──────────────────────
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const result = await saveCardForPatient(
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

  if (result.kind === 'error') {
    return <FailureCard resourcePath={resourcePath} reason={result.message} />;
  }

  // ── 5. Redirect to the cards list ─────────────────────────────────
  //     Server-side 3xx redirect. The browser navigates to
  //     /patient/payment-methods with a query flag so the client can
  //     surface a "Card added" toast without re-entering the widget.
  //     redirect() throws NEXT_REDIRECT and unwinds the render — no
  //     further JSX from this file runs after this line, so the widget
  //     panel doesn't get another opportunity to reopen.
  const flag = result.kind === 'already_saved' ? 'already' : 'added';
  redirect(`/patient/payment-methods?added=${flag}`);
}
