// ─── Shared first-instalment activation ─────────────────────────────
//
// The financial terminal transition is one PostgreSQL transaction through
// activate_first_instalment (migration 0148): instalment 1 is collected, the
// plan is activated, and the unique practice payout is inserted together.
// Re-entry accepts an already-active plan and collected payment so webhook or
// browser-return retries repair legacy partial activations instead of skipping
// an orphan plan. Checkout-token closure follows as non-financial, retryable
// operational cleanup.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

export type ActivateFirstInstalmentInput = {
  paymentId:   string;
  plan: {
    id:            string;
    total_amount:  unknown;
    practice_id:   unknown;
    /** The treating practitioner's MEMBERSHIP row (0094). */
    provider_member_id?: string | null;
    patient_id?:   string | null;
  };
  now?: string;
};

export type ActivateFirstInstalmentResult =
  | { ok: true }
  | { ok: false; step: 'payment' | 'plan' | 'payout'; error: string };

export async function activateFirstInstalment(
  supabase: SvcClient,
  input:    ActivateFirstInstalmentInput,
): Promise<ActivateFirstInstalmentResult> {
  const now = input.now ?? new Date().toISOString();
  const { paymentId, plan } = input;

  // One database transaction owns the three financial effects. Re-entry is
  // deliberately accepted for an already-collected payment / active plan so a
  // legacy partial activation can repair its missing payout.
  const { data, error } = await supabase.rpc('activate_first_instalment', {
    p_payment_id:   paymentId,
    p_plan_id:      plan.id,
    p_collected_at: now,
  });

  if (error) return { ok: false, step: 'payment', error: error.message };
  const outcome = data as { ok?: boolean; error?: string } | null;
  if (!outcome?.ok) {
    const reason = outcome?.error ?? 'activation_failed';
    return { ok: false, step: reason === 'fee_unavailable' ? 'payout' : 'payment', error: reason };
  }

  // Token/session closure is operational state, not part of the money
  // transaction. It remains retryable on every invocation.
  await closeCheckoutTokensForPlan(supabase, plan.id);

  return { ok: true };
}

// ─── 4. Close whatever token opened this plan ───────────────────────────
//
// THE DEFECT THIS CLOSES (audit 2026-09-01, F-06)
//
// Stamping patient_invitations.accepted_at and advancing the POS session
// to 'completed' used to happen ONLY on the browser return pages
// (app/checkout/[token]/complete and app/patient/payment-complete). The
// webhook — the other, equally normal way a plan activates — did neither.
//
// So every time the webhook won the activation race, which is every time
// the patient closed the tab, lost signal or pressed back after the card
// cleared, the plan went live and the token stayed OPEN for the rest of
// its seven-day TTL. Re-opening that link re-entered initiateCheckout,
// which deleted the collected instalment and rewrote the schedule; letting
// the next card decline then cancelled a plan whose 94% payout had already
// been created and could not be reversed.
//
// initiateCheckout now refuses those plan states outright, so this is the
// second of two independent fixes rather than the only one. It is worth
// having both: the guard stops the exploit, and this stops the situation
// the exploit needed. It also fixes a plain reliability bug that was
// sitting in the same place — a webhook-activated till bill left its
// counter session reading "Waiting on patient" forever, which is the third
// time that particular freeze has had to be fixed.
//
// Non-fatal by construction: every failure is caught and logged, so this
// can never throw out into the ledger writes around it. That is what lets
// it sit before the payout fast-path (see the call site) rather than at the
// end of the function where it would only ever run once.
//
// Both writes are precondition-guarded, so the ordinary case — the browser
// page got here first — is a zero-row no-op rather than a double write.
async function closeCheckoutTokensForPlan(supabase: SvcClient, planId: string): Promise<void> {
  try {
    const { error: inviteErr } = await supabase
      .from('patient_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('plan_id', planId)
      .is('accepted_at', null);
    if (inviteErr) {
      console.error('[activateFirstInstalment] ALERT could not close the invitation for an activated plan', {
        planId, error: inviteErr.message,
        note: 'the plan IS active; its checkout link may still resolve until it expires',
      });
    }

    const { error: sessionErr } = await supabase
      .from('checkout_sessions')
      .update({ stage: 'completed' })
      .eq('plan_id', planId)
      .neq('stage', 'completed');
    if (sessionErr) {
      console.error('[activateFirstInstalment] ALERT could not close the counter session for an activated plan', {
        planId, error: sessionErr.message,
        note: 'the plan IS active; the till strip may still show this session as waiting',
      });
    }
  } catch (err) {
    console.error('[activateFirstInstalment] ALERT token close threw (non-fatal)', {
      planId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
