'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { attemptChargeInstalment } from '@/lib/payments/chargeInstalment';

// ─── Admin "retry now" for a single installment ─────────────────────────────
//
// Wraps the shared lib/payments/chargeInstalment helper with an admin
// authorization guard. The helper is the SAME code path the daily cron
// uses — atomic claim, retry-cap respected, race-safe. Using it from an
// admin button keeps a single code path for "fire one installment charge"
// instead of the parallel implementations the old admin page carried.

async function guardAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.' };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.' };
  return { ok: true as const };
}

export async function retryCollection(
  paymentId: string,
): Promise<{ error: string | null; outcome?: string }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const result = await attemptChargeInstalment(svc, paymentId);

  revalidatePath('/admin/collections');
  revalidatePath(`/admin/collections/${paymentId}`);

  if (result.kind === 'charged') {
    return { error: null, outcome: `Charge fired (attempt ${result.attemptNumber}). Webhook will reconcile the outcome.` };
  }
  if (result.kind === 'transport_error') {
    return {
      error: `Paystack transport error: ${result.error}. Row left in 'processing' for manual reconciliation.`,
    };
  }
  // claim_lost
  return {
    error: `Cannot retry: ${result.reason}. The row may already be processing, collected, past the retry cap, or its plan is no longer active.`,
  };
}
