import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { initializeCardRegistration } from '../actions';
import { planCardRemoval, type RemovalCard } from '@/lib/cardRemoval';
import PaymentMethods from './PaymentMethods';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CardRow = {
  id:              string;
  card_brand:      string;
  last_four:       string;
  expiry_month:    number;
  expiry_year:     number;
  cardholder_name: string;
  is_default:      boolean;
  created_at:      string;
};

// `RemoveCardResult` carries enough info to power the confirmation toast /
// banner after a successful remove (e.g. "moved 2 active plans to your
// default card"). On error, `error` is non-null and the rest is undefined.
export type RemoveCardResult =
  | { error: string }
  | {
      error:             null;
      repointedPlans:    number;
      promotedDefaultId: string | null;
    };

// ─── Server Actions ───────────────────────────────────────────────────────────

const ACTIVE_PLAN_STATUSES = ['active', 'pending_first_payment'] as const;

/**
 * Guarded card removal. Determines the plan via `planCardRemoval()` and
 * executes the side effects in order:
 *   1. Repoint active plans' Paystack auth token (if any).
 *   2. Promote a new default (if removing the current default).
 *   3. Delete the card row.
 *
 * The "only card" guard is enforced here regardless of what the UI shows.
 */
export async function removeCard(cardId: string): Promise<RemoveCardResult> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  // Load every card so the planner sees the full picture.
  const { data: cardsRaw } = await supabase
    .from('payment_methods')
    .select('id, token, is_default, created_at')
    .eq('patient_id', user.id);

  const allCards = (cardsRaw ?? []) as RemovalCard[];
  const cardToRemove = allCards.find((c) => c.id === cardId);
  if (!cardToRemove) return { error: 'Card not found.' };

  // Look for any active / pending-first-payment plan that currently
  // collects from this card's token.
  const { data: activePlans } = await supabase
    .from('plans')
    .select('id')
    .eq('patient_id', user.id)
    .eq('paystack_authorization_code', cardToRemove.token)
    .in('status', ACTIVE_PLAN_STATUSES);

  const activePlanIds = (activePlans ?? []).map((p) => p.id as string);
  const plan = planCardRemoval(cardId, allCards, activePlanIds.length > 0);

  if (plan.kind === 'not_found')      return { error: 'Card not found.' };
  if (plan.kind === 'block_only_card') return { error: 'Add another card before removing this one.' };

  // 1. Repoint active plans to the target card's token (if any).
  if (plan.repointToToken && activePlanIds.length > 0) {
    const { error: repointErr } = await supabase
      .from('plans')
      .update({ paystack_authorization_code: plan.repointToToken })
      .in('id', activePlanIds);
    if (repointErr) return { error: repointErr.message };
  }

  // 2. Promote the target to default if removing the current default.
  if (plan.promoteToDefaultId) {
    const { error: promoteErr } = await supabase
      .from('payment_methods')
      .update({ is_default: true })
      .eq('id', plan.promoteToDefaultId)
      .eq('patient_id', user.id);
    if (promoteErr) return { error: promoteErr.message };
  }

  // 3. Delete the card.
  const { error: delErr } = await supabase
    .from('payment_methods')
    .delete()
    .eq('id', cardId)
    .eq('patient_id', user.id);
  if (delErr) return { error: delErr.message };

  revalidatePath('/patient/payment-methods');
  return {
    error:             null,
    repointedPlans:    activePlanIds.length,
    promotedDefaultId: plan.promoteToDefaultId,
  };
}

export async function setDefaultCard(cardId: string): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: card } = await supabase
    .from('payment_methods')
    .select('id')
    .eq('id', cardId)
    .eq('patient_id', user.id)
    .maybeSingle();

  if (!card) return { error: 'Card not found.' };

  await supabase
    .from('payment_methods')
    .update({ is_default: false })
    .eq('patient_id', user.id);

  const { error } = await supabase
    .from('payment_methods')
    .update({ is_default: true })
    .eq('id', cardId)
    .eq('patient_id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/payment-methods');
  return { error: null };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function PaymentMethodsPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Deliberately omit 'token' — no reason to send processor tokens to the
  // browser. The server action loads tokens itself when computing the plan.
  const { data: rawCards } = await supabase
    .from('payment_methods')
    .select('id, card_brand, last_four, expiry_month, expiry_year, cardholder_name, is_default, created_at')
    .eq('patient_id', user.id)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });

  const cards = (rawCards ?? []) as CardRow[];

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-1" style={{ color: '#13294B' }}>Payment Methods</h1>
      <p className="text-sm text-gray-500 mb-6 leading-relaxed">
        Your card details are never stored on BetterNow. They&apos;re held by Paystack,
        our PCI-DSS certified payment partner — we only keep a secure reference to
        charge your instalments.
      </p>
      <PaymentMethods
        initialCards={cards}
        initializeCardRegistration={initializeCardRegistration}
        removeCard={removeCard}
        setDefaultCard={setDefaultCard}
      />
    </div>
  );
}
