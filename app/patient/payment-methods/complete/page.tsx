import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getPaymentProvider } from '@/lib/payments/provider';
import { classifyResultCode } from '@/lib/payments/peach/resultCodes';
import { peachRefPurpose } from '@/lib/payments/peach/refs';
import { saveCardForPatient } from '@/lib/payments/peach/saveCardForPatient';
import PollingConfirmation from './PollingConfirmation';

// ─── Checkout V2 return route for the "add card" flow (Flow B) ──────
//
// Card-add now runs on the SAME Checkout V2 door as Flow A, using the
// zero-amount PA registration recipe (amount 0 + paymentType 'PA' +
// createRegistration). No money moves — the zero-value PA auto-expires.
// On completion the embedded widget navigates the browser to
// `shopperResultUrl?checkoutId={id}`; we read the final status via
// provider.getCheckoutStatus to discover the newly-created
// registrationId + card metadata, then save the payment_methods row
// idempotently.
//
// Purpose guard: this route accepts ONLY registration ('r') refs — the
// merchantTransactionId minted by registrationRef(). A Flow A checkout
// ('c') ref landing here would be a wiring bug, so we reject it rather
// than vault a paying checkout's card on the wrong route. (Flow A's own
// completion at app/checkout/[token]/complete gates on 'c'.)
//
// Idempotency posture: `saveCardForPatient` dedupes on the synthetic
// fingerprint (brand + last4 + expiry) — hitting this URL twice for
// the same card returns `kind: 'already_saved'` cleanly. The fast
// path below (recent-card lookup) short-circuits the second visit
// without even a Peach round-trip when the webhook or a prior render
// has already landed the row.

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

function FailureCard({ checkoutId, reason }: { checkoutId: string; reason: string }) {
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
          href={`/patient/payment-methods/complete?checkoutId=${encodeURIComponent(checkoutId)}`}
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
  const params     = await searchParams;
  const checkoutId = (params.checkoutId ?? params.checkout_id) as string | undefined;

  if (!checkoutId) return <NoReferenceCard />;

  const supabaseUser       = await createServerClient();
  const { data: { user } } = await supabaseUser.auth.getUser();
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // NOTE: idempotency is enforced in step 4, SCOPED to this checkout's
  // registrationId — NOT a "any card saved in the last 5 minutes" guard.
  // The old time-window fast-path short-circuited a legitimate SECOND
  // card added within 5 minutes (it matched the FIRST card and returned
  // before saving), so a genuinely new card never got inserted. Scoping
  // to the actual card being saved fixes that while still no-oping a
  // refresh / back-button / "Try again" re-post of the SAME checkout.

  // ── 2. Primary path: ask Peach for the Checkout V2 status ─────────
  //     The V2 status body is flat dot-notation; the client's
  //     shape-tolerant parser normalises it. For a zero-amount PA
  //     registration the body carries result.code, registrationId, and
  //     card.* — no charge, no payment row.
  const provider = getPaymentProvider();
  let status: Awaited<ReturnType<typeof provider.getCheckoutStatus>>;
  try {
    status = await provider.getCheckoutStatus(checkoutId);
  } catch (err) {
    console.error('[card-registration-complete] Peach status fetch failed', err instanceof Error ? err.message : err);
    return <PollingConfirmation since={since} reference={checkoutId} />;
  }

  // ── Purpose guard — accept ONLY registration ('r') refs here ──────
  //     The status echoes our merchantTransactionId. A Flow A ('c')
  //     checkout ref landing on the card-vault route is a wiring bug;
  //     reject rather than vault a paying checkout's card here.
  const reference = status.merchantTransactionId;
  if (peachRefPurpose(reference) !== 'r') {
    return <FailureCard
      checkoutId={checkoutId}
      reason="This reference isn't from a card-verification flow."
    />;
  }

  const classified = classifyResultCode(status.resultCode);
  // 000.200.* etc. → the acquirer is still working. Show the polling
  // view; we DO NOT redirect back into the widget on this branch. The
  // polling component watches for the payment_methods row (webhook or
  // eventual completion of the pending path) and flips to Success or
  // Timeout on its own.
  if (classified === 'pending') {
    return <PollingConfirmation since={since} reference={checkoutId} />;
  }
  if (classified === 'rejected') {
    return <FailureCard
      checkoutId={checkoutId}
      reason={status.resultDescription ?? 'The card verification did not complete.'}
    />;
  }

  if (!status.registrationId || !status.card) {
    return <FailureCard
      checkoutId={checkoutId}
      reason="Peach didn't return a stored registration on the verified transaction."
    />;
  }

  // ── 3. Resolve the patient ────────────────────────────────────────
  //     customParameters carries SHOPPER_patientId on our own checkouts.
  //     The V2 status body is flat, so the parameter may arrive under
  //     the bracketed flat key OR (older/nested modes) a nested object —
  //     read both tolerantly.
  const rawCustom = (status.raw ?? {}) as Record<string, unknown>;
  const nestedCustom = rawCustom.customParameters as Record<string, string> | undefined;
  const metaPid =
    (rawCustom['customParameters[SHOPPER_patientId]'] as string | undefined) ??
    nestedCustom?.SHOPPER_patientId ??
    nestedCustom?.patientId;

  if (user && metaPid && metaPid !== user.id) {
    return <FailureCard
      checkoutId={checkoutId}
      reason="This card verification belongs to a different account."
    />;
  }

  const patientId = metaPid ?? user?.id;
  if (!patientId) {
    return <FailureCard
      checkoutId={checkoutId}
      reason="Could not match this verification to your account. Sign in and retry."
    />;
  }

  // ── 4. Save the card — race-safe, idempotent ──────────────────────
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Scoped idempotency: if THIS checkout's card (keyed by its
  // registrationId → the row's token) is already on file, a refresh /
  // back-button / "Try again" re-post is a no-op — show success without
  // re-saving. A genuinely new second card has a DIFFERENT registrationId,
  // so it falls through to the save below and inserts.
  const { data: alreadyOnFile } = await svc
    .from('payment_methods')
    .select('card_brand, last_four')
    .eq('patient_id', patientId)
    .eq('token', status.registrationId)
    .maybeSingle();
  if (alreadyOnFile) {
    return <SuccessCard brand={alreadyOnFile.card_brand} lastFour={alreadyOnFile.last_four} alreadySaved />;
  }

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
    return <FailureCard checkoutId={checkoutId} reason={result.message} />;
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
