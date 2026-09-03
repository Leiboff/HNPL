'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { attemptChargeInstalment } from '@/lib/payments/chargeInstalment';
import { recordAdminAttempt } from '@/app/admin/_lib/adminAudit';
import { requireAAL2 } from '@/lib/auth/aal';

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
  if (!user) return { ok: false as const, error: 'Not authenticated.', userId: null };
  const { data: p } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (p?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.', userId: null };
  return { ok: true as const, error: null, userId: user.id };
}

export async function retryCollection(
  paymentId: string,
): Promise<{ error: string | null; outcome?: string }> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };

  // AAL2 (standard tier) — admin-initiated collection retry fires a card
  // charge. Before the service-role client is constructed.
  const aal = await requireAAL2('standard');
  if (!aal.ok) return { error: aal.error };

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── Recorded as intent, then outcome (audit A-12) ────────────────────
  //
  // This is the one privileged action no trigger can catch: it charges a
  // customer's card and the columns it moves (payments.status → processing)
  // are the same ones the daily cron moves, so a trigger could not tell an
  // admin's retry from the schedule doing its job.
  //
  // Recorded BEFORE the call because a transport error leaves the row in
  // 'processing' with nothing to show for it — and "an admin fired a charge
  // and we do not know what happened" is exactly what an investigator needs
  // to see, rather than silence. The attempt row lands whatever follows.
  const finish = await recordAdminAttempt({
    actorId:    guard.userId!,
    entityType: 'payment',
    entityId:   paymentId,
    action:     'retry_collection',
  });

  const result = await attemptChargeInstalment(svc, paymentId);
  await finish(
    result.kind === 'charged'
      ? { kind: 'charged', attempt: result.attemptNumber }
      : result.kind === 'transport_error'
        ? { kind: 'transport_error', error: result.error }
        : { kind: 'claim_lost', reason: result.reason },
  );

  revalidatePath('/admin/collections');
  revalidatePath(`/admin/collections/${paymentId}`);

  if (result.kind === 'charged') {
    return { error: null, outcome: `Charge fired (attempt ${result.attemptNumber}). Webhook will reconcile the outcome.` };
  }
  if (result.kind === 'transport_error') {
    return {
      error: `Peach transport error: ${result.error}. Row left in 'processing' for manual reconciliation.`,
    };
  }
  // claim_lost
  return {
    error: `Cannot retry: ${result.reason}. The row may already be processing, collected, past the retry cap, or its plan is no longer active.`,
  };
}
