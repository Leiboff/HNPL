import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PatientScreen from '@/app/patient/PatientScreen';
import SubScreenHeader from '../SubScreenHeader';
import PaymentMethods from '@/app/patient/payment-methods/PaymentMethods';
import { initializeCardRegistration } from '@/app/patient/actions';
import {
  changeDefaultCard,
  removeCard,
  type CardRow,
} from '@/app/patient/payment-methods/actions';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── Payment cards — its own screen ────────────────────────────────────
//
// Was the "pay" AccordionSection body on /patient/account (the one open
// by default, since cards were the most-checked thing on the page). Now
// a real, linkable, back-navigable screen instead — see SubScreenHeader.
//
// This IS the route lib/patient/cardReturn.ts's CARDS_SURFACE now points
// at, so the Peach add-card round trip (and the "Try again" retry flow)
// lands back here directly rather than on the account index, which would
// have made a just-added card invisible until the patient tapped back in.

export default async function PaymentCardsPage() {
  const supabase = await createClient();

  const user = await getRequestUser();
  if (!user) redirect('/login');

  const [{ data: rawCards }, { data: rawPlans }] = await Promise.all([
    // Active cards only — archived (soft-deleted) cards drop off the list.
    // token is read server-side to compute the delete guard; it is NOT
    // passed to the client (CardRow carries no token).
    supabase
      .from('payment_methods')
      .select('id, card_brand, last_four, expiry_month, expiry_year, cardholder_name, is_default, created_at, token')
      .eq('patient_id', user.id)
      .is('archived_at', null)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false }),
    // Which cards are currently collecting an active plan → those cards
    // cannot be removed. Determined here (and re-checked in archive_card).
    supabase.from('plans').select('peach_registration_id').eq('patient_id', user.id).in('status', ['active', 'pending_first_payment']),
  ]);

  // Split the server-only token off before handing cards to the client.
  const rawCardRows = (rawCards ?? []) as (CardRow & { token: string })[];
  const cards: CardRow[] = rawCardRows.map(({ token: _token, ...row }) => row);

  // Cards whose token backs an active/pending plan are locked against
  // removal (RULE 2). Set of ids for the client to disable "Remove".
  const activeTokens = new Set(
    ((rawPlans ?? []) as { peach_registration_id: string | null }[])
      .map((p) => p.peach_registration_id)
      .filter((t): t is string => !!t),
  );
  const lockedCardIds = rawCardRows.filter((c) => activeTokens.has(c.token)).map((c) => c.id);

  return (
    <PatientScreen header={<SubScreenHeader title="Payment cards" />} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[10px]">
        <p className="text-[12.5px] leading-[1.5]" style={{ color: 'var(--portal-muted)' }}>
          Your card details are never stored on betternow — they&rsquo;re held by our PCI-DSS
          certified payment partner. We only keep a secure reference to collect your instalments.
        </p>
        <PaymentMethods
          initialCards={cards}
          lockedCardIds={lockedCardIds}
          initializeCardRegistration={initializeCardRegistration}
          changeDefaultCard={changeDefaultCard}
          removeCard={removeCard}
        />
      </div>
    </PatientScreen>
  );
}
