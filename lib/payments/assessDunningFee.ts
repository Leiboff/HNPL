import { advanceLadderAfterFailure, chargeAmountCents, dunningFeesEnabled } from './dunning';
import { MAX_ATTEMPTS } from './chargeInstalment';
import { notifyAttemptFailed, notifyDefaulted } from './dunningNotifications';
import { sendPushToUser } from '@/lib/notifications/sendPush';

// ─── Grace-elapsed dunning fee assessment ───────────────────────────────
//
// The OTHER HALF of a failed instalment's life, split out from the Peach
// webhook by direct product decision: a failed attempt no longer earns
// its Default Fee (or a shot at terminal `defaulted`) the instant it
// fails. The webhook's payment.failure handler (app/api/payments/peach/
// webhook/route.ts) just records the failure and stamps
// payments.dunning_grace_until = today + FEE_GRACE_PERIOD_DAYS, giving
// the patient a day to settle manually (Pay now) — T&Cs clause 7.5
// ("we may... waive or defer any Default Fee") covers this as a
// leniency on top of the disclosed worst case.
//
// THIS module is the only caller of advanceLadderAfterFailure now. It
// runs once daily from the collect-instalments cron (app/api/cron/
// collect-instalments/route.ts), claiming every payments row whose grace
// has elapsed and is STILL 'failed' (a self-pay within the window moves
// the row to 'processing' → 'collected' via the normal success path,
// which drops it out of the claim query for free — no special-casing
// needed here).
//
// Mirrors lib/payments/chargeInstalment.ts's atomic-claim shape: the
// claiming UPDATE's WHERE clause is itself the concurrency guard (a
// second concurrent run finds zero rows and reports claim_lost), and it
// clears dunning_grace_until as part of the SAME write so a claimed row
// can never be claimed twice.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

export type AssessOutcome =
  | { kind: 'assessed';    paymentId: string; feeAppliedCents: number; terminal: boolean }
  | { kind: 'claim_lost';  paymentId: string; reason: 'already_claimed' | 'plan_not_found' };

async function safePush(
  userId: string,
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<void> {
  try {
    await sendPushToUser(userId, { type: 'payment', ...payload });
  } catch (err) {
    console.warn('[assessDunningFee] push send failed (non-fatal)', {
      userId,
      message: (err as Error).message,
    });
  }
}

function formatRandCents(rands: number): string {
  const [integer, decimal] = rands.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

/**
 * Assess (and, if still unpaid, apply) the Default Fee for one payment
 * row whose grace period has elapsed. Safe to call for a row that is no
 * longer eligible — it is simply a no-op `claim_lost`.
 */
export async function assessDunningFee(
  svc:       SvcClient,
  paymentId: string,
  options:   { today?: string } = {},
): Promise<AssessOutcome> {
  const todayStr = options.today ?? new Date().toISOString().slice(0, 10);

  // ── 1. Atomic claim. Only a row that is STILL 'failed' with a grace
  //       deadline that has arrived is eligible. Clearing
  //       dunning_grace_until here (rather than after the ladder math)
  //       is what makes a concurrent duplicate invocation a safe no-op.
  const { data: claimed, error: claimErr } = await svc
    .from('payments')
    .update({ dunning_grace_until: null })
    .eq('id', paymentId)
    .eq('status', 'failed')
    .not('dunning_grace_until', 'is', null)
    .lte('dunning_grace_until', todayStr)
    .select('id, plan_id, instalment_number, amount, dunning_fees_cents, consecutive_failed_attempts, retry_count, patient_id');

  if (claimErr || !claimed || claimed.length === 0) {
    return { kind: 'claim_lost', paymentId, reason: 'already_claimed' };
  }
  const payment = claimed[0] as {
    id: string; plan_id: string; instalment_number: number; amount: number;
    dunning_fees_cents: number | null; consecutive_failed_attempts: number | null;
    retry_count: number | null; patient_id: string | null;
  };

  // ── 2. Plan lookup — needed for the 50%-of-bill cap and patient_id.
  const { data: plan } = await svc
    .from('plans')
    .select('id, patient_id, total_amount')
    .eq('id', payment.plan_id)
    .maybeSingle();
  if (!plan) {
    console.error('[assessDunningFee] plan not found — leaving row failed, no grace pending', {
      paymentId, planId: payment.plan_id,
    });
    return { kind: 'claim_lost', paymentId, reason: 'plan_not_found' };
  }

  // ── 3. The ladder's weekly retry is bounded by the PLAN'S NEXT
  //       instalment's own due date — see lib/payments/dunning.ts. `null`
  //       when this is the plan's last instalment.
  const { data: nextInstalment } = await svc
    .from('payments')
    .select('due_date')
    .eq('plan_id', payment.plan_id)
    .eq('kind', 'instalment')
    .eq('instalment_number', payment.instalment_number + 1)
    .maybeSingle();
  const nextInstalmentDueDate = (nextInstalment?.due_date as string | undefined)?.slice(0, 10) ?? null;

  const feesBefore    = (payment.dunning_fees_cents ?? 0) as number;
  const counterBefore = (payment.consecutive_failed_attempts ?? 0) as number;
  const attemptedAmountCents = chargeAmountCents(Number(payment.amount), feesBefore);

  // ── 4. The pure ladder math — "today" here is the ASSESSMENT date
  //       (grace-elapsed), not the original failure date. See the
  //       cadence note in lib/payments/dunning.ts's module banner: the
  //       weekly retry gap is measured from whenever a failure actually
  //       gets assessed, which already has the grace day folded in.
  const ladder = advanceLadderAfterFailure({
    consecutiveFailedAttemptsBefore: counterBefore,
    dunningFeesCentsBefore:          feesBefore,
    originalBillRands:               Number(plan.total_amount),
    today:                           todayStr,
    nextInstalmentDueDate,
  });

  // ── Fee gate (compliance). While fees are OFF the ladder still advances
  //    and retries schedule exactly as normal — but no fee is persisted
  //    (dunning_fees_cents is NOT grown) and no fee is charged. When fees
  //    are ON, the pure ladder's own terminalStatus (cap reached OR
  //    next-instalment boundary hit) is authoritative.
  const feesEnabled    = dunningFeesEnabled();
  const feeThisAttempt = feesEnabled ? ladder.feeAppliedThisAttempt : 0;
  const feesCentsAfter = feesEnabled ? ladder.dunningFeesCentsAfter  : feesBefore;

  let newStatus: 'failed' | 'defaulted';
  let nextAttemptDate: string | null;
  let isTerminal: boolean;
  if (feesEnabled) {
    newStatus       = ladder.terminalStatus ?? 'failed';
    nextAttemptDate = ladder.nextAttemptDate;
    isTerminal      = ladder.terminalStatus === 'defaulted';
  } else {
    // Three terminal signals while gated — mirrors the webhook's old
    // gated-off branch:
    //   • ladder.capReached — a SINGLE would-be fee already meets the
    //     cap (small bills: 50%-of-plan cap ≤ one fee). Correct even
    //     with the ledger frozen at 0, because one fee alone reaches
    //     the cap — matches the ungated early-default.
    //   • ladder.nextInstalmentBoundaryHit — the next instalment's due
    //     date has arrived, independent of the fee ledger.
    //   • the MAX_ATTEMPTS backstop — for normal bills, where the cap
    //     needs multiple fees to accumulate (which the frozen ledger
    //     can't track), we terminate at the attempt-count backstop.
    const backstopHit = Number(payment.retry_count ?? 0) >= MAX_ATTEMPTS;
    isTerminal      = ladder.capReached || ladder.nextInstalmentBoundaryHit || backstopHit;
    newStatus       = isTerminal ? 'defaulted' : 'failed';
    nextAttemptDate = isTerminal ? null : ladder.nextAttemptDate;
    if (ladder.feeAppliedThisAttempt > 0) {
      console.log(
        `[assessDunningFee] default fee ${formatRandCents(ladder.feeAppliedThisAttempt / 100)} WOULD apply [gated]`,
        { paymentId },
      );
    }
  }

  await svc
    .from('payments')
    .update({
      status:                      newStatus,
      consecutive_failed_attempts: ladder.consecutiveFailedAttemptsAfter,
      dunning_fees_cents:          feesCentsAfter,
      next_attempt_date:           nextAttemptDate,
    })
    .eq('id', paymentId);

  const planEventInserts: Record<string, unknown>[] = [];
  if (feeThisAttempt > 0) {
    planEventInserts.push({
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'dunning_fee_applied',
      payload: {
        payment_id:               paymentId,
        instalment_number:        payment.instalment_number,
        fee_applied_cents:        feeThisAttempt,
        dunning_fees_cents_after: feesCentsAfter,
      },
    });
  }
  if (isTerminal) {
    planEventInserts.push({
      plan_id:    plan.id,
      patient_id: plan.patient_id,
      event_type: 'instalment_defaulted',
      payload: {
        payment_id:               paymentId,
        instalment_number:        payment.instalment_number,
        outstanding_amount_cents: chargeAmountCents(Number(payment.amount), feesCentsAfter),
      },
    });
  }
  if (planEventInserts.length > 0) {
    await svc.from('plan_events').insert(planEventInserts);
  }

  await notifyAttemptFailed(svc, {
    paymentId,
    consecutiveFailedAttemptsBefore: counterBefore,
    feeAppliedCents:                 feeThisAttempt,
    dunningFeesCentsAfter:           feesCentsAfter,
    attemptedAmountCents,
    nextAttemptDate,
  });
  if (isTerminal) {
    await notifyDefaulted(svc, {
      paymentId,
      outstandingAmountCents: chargeAmountCents(Number(payment.amount), feesCentsAfter),
    });
  }

  const patientId = (plan.patient_id ?? payment.patient_id) as string | null;
  if (patientId) {
    await safePush(patientId, {
      title: isTerminal ? 'Account frozen — action needed' : 'Payment didn\'t go through',
      body:  isTerminal
        ? `We couldn't collect ${formatRandCents(attemptedAmountCents / 100)} after several attempts. No more retries — your account is frozen from new plans until you settle. Tap to settle and lift the freeze.`
        : feeThisAttempt > 0
          ? `A ${formatRandCents(feeThisAttempt / 100)} default fee was added — you didn't settle in time. Tap to settle now and stop further fees.`
          : `We'll try again soon. Fund your card now or settle to avoid further fees.`,
      url:   `/patient/orders`,
      tag:   isTerminal
        ? `payment:${paymentId}:defaulted`
        : `payment:${paymentId}:failed:r${payment.retry_count ?? 0}`,
    });
  }

  return { kind: 'assessed', paymentId, feeAppliedCents: feeThisAttempt, terminal: isTerminal };
}
