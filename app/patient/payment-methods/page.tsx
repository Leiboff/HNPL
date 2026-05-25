import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import PaymentMethods from './PaymentMethods';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CardRow = {
  id: string;
  card_brand: string;
  last_four: string;
  expiry_month: number;
  expiry_year: number;
  cardholder_name: string;
  is_default: boolean;
  created_at: string;
};

// ─── Server Actions ───────────────────────────────────────────────────────────
// SECURITY: These actions never accept or log full card numbers or CVV.
// The client derives brand + last_four from the number client-side, then
// discards the number before calling these actions.

export async function addCard(data: {
  card_brand: string;
  last_four: string;
  expiry_month: number;
  expiry_year: number;
  cardholder_name: string;
  token: string;
}): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  if (!/^\d{4}$/.test(data.last_four)) return { error: 'Invalid card data.' };
  if (data.expiry_month < 1 || data.expiry_month > 12) return { error: 'Invalid expiry month.' };
  if (data.expiry_year < new Date().getFullYear()) return { error: 'Card has expired.' };
  if (!data.cardholder_name.trim()) return { error: 'Cardholder name is required.' };
  if (!data.token) return { error: 'Invalid card token.' };

  const { count } = await supabase
    .from('payment_methods')
    .select('id', { count: 'exact', head: true })
    .eq('patient_id', user.id);

  const isFirst = (count ?? 0) === 0;

  const { error } = await supabase.from('payment_methods').insert({
    patient_id:      user.id,
    card_brand:      data.card_brand,
    last_four:       data.last_four,
    expiry_month:    data.expiry_month,
    expiry_year:     data.expiry_year,
    cardholder_name: data.cardholder_name.trim(),
    token:           data.token,
    is_default:      isFirst,
  });

  if (error) return { error: error.message };

  revalidatePath('/patient/payment-methods');
  return { error: null };
}

export async function updateCard(
  cardId: string,
  data: { expiry_month: number; expiry_year: number; cardholder_name: string },
): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  if (data.expiry_month < 1 || data.expiry_month > 12) return { error: 'Invalid expiry month.' };
  if (data.expiry_year < new Date().getFullYear()) return { error: 'Card has expired.' };
  if (!data.cardholder_name.trim()) return { error: 'Cardholder name is required.' };

  const { error } = await supabase
    .from('payment_methods')
    .update({
      expiry_month:    data.expiry_month,
      expiry_year:     data.expiry_year,
      cardholder_name: data.cardholder_name.trim(),
    })
    .eq('id', cardId)
    .eq('patient_id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/patient/payment-methods');
  return { error: null };
}

export async function removeCard(cardId: string): Promise<{ error: string | null }> {
  'use server';

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.' };

  const { data: card } = await supabase
    .from('payment_methods')
    .select('id, is_default')
    .eq('id', cardId)
    .eq('patient_id', user.id)
    .maybeSingle();

  if (!card) return { error: 'Card not found.' };

  const { error: delError } = await supabase
    .from('payment_methods')
    .delete()
    .eq('id', cardId)
    .eq('patient_id', user.id);

  if (delError) return { error: delError.message };

  if (card.is_default) {
    const { data: remaining } = await supabase
      .from('payment_methods')
      .select('id')
      .eq('patient_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1);

    if (remaining && remaining.length > 0) {
      await supabase
        .from('payment_methods')
        .update({ is_default: true })
        .eq('id', remaining[0].id);
    }
  }

  revalidatePath('/patient/payment-methods');
  return { error: null };
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

  // Deliberately omit 'token' — no reason to send processor tokens to the browser
  const { data: rawCards } = await supabase
    .from('payment_methods')
    .select('id, card_brand, last_four, expiry_month, expiry_year, cardholder_name, is_default, created_at')
    .eq('patient_id', user.id)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });

  const cards = (rawCards ?? []) as CardRow[];

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-gray-900">Payment Methods</h1>
      <p className="mt-1 text-sm text-gray-500">
        Your cards are stored securely. We never store your full card number.
      </p>
      <div className="mt-8">
        <PaymentMethods
          initialCards={cards}
          addCard={addCard}
          updateCard={updateCard}
          removeCard={removeCard}
          setDefaultCard={setDefaultCard}
        />
      </div>
    </div>
  );
}
