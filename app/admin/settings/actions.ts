'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { requireAAL2 } from '@/lib/auth/aal';
import { MAX_BILL_AMOUNT, MIN_BILL_AMOUNT } from '@/lib/config/billAmountLimits';

export type BillLimitState = { error: string | null; success: string | null };

export async function updateMaxBillAmount(
  _previous: BillLimitState,
  formData: FormData,
): Promise<BillLimitState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated.', success: null };

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') return { error: 'Unauthorized.', success: null };

  const aal = await requireAAL2('critical');
  if (!aal.ok) return { error: aal.error, success: null };

  const amount = Number(formData.get('maxBillAmount'));
  if (!Number.isFinite(amount) || amount < MIN_BILL_AMOUNT || amount > MAX_BILL_AMOUNT
      || amount !== Math.round(amount * 100) / 100) {
    return {
      error: `Enter an amount between R${MIN_BILL_AMOUNT.toLocaleString('en-ZA')} and R${MAX_BILL_AMOUNT.toLocaleString('en-ZA')}.`,
      success: null,
    };
  }

  const service = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { error } = await service.rpc('set_max_bill_amount', {
    p_amount: amount,
    p_actor_id: user.id,
  });
  if (error) {
    console.error('[update-max-bill-amount] ALERT setting update failed', {
      actorId: user.id,
      error: error.message,
    });
    return { error: 'Could not update the bill limit. Please try again.', success: null };
  }

  revalidatePath('/admin/settings');
  return {
    error: null,
    success: `Maximum bill amount updated to R${amount.toLocaleString('en-ZA')}.`,
  };
}
