import { createClient as createServiceClient } from '@supabase/supabase-js';
import { MAX_BILL_AMOUNT } from './billAmountLimits';

/**
 * Read the live product maximum. Fall back to the R30,000 absolute ceiling
 * if the display/action pre-check cannot read the setting; the database
 * trigger remains authoritative and still enforces any lower live value.
 */
export async function configuredMaxBillAmount(): Promise<number> {
  const client = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await client
    .from('platform_settings')
    .select('max_bill_amount')
    .eq('singleton', true)
    .single();

  const amount = Number(data?.max_bill_amount);
  if (error || !Number.isFinite(amount) || amount <= 0 || amount > MAX_BILL_AMOUNT) {
    console.error('[bill-amount-policy] ALERT could not read configured maximum', {
      error: error?.message ?? 'invalid value',
    });
    return MAX_BILL_AMOUNT;
  }
  return amount;
}
