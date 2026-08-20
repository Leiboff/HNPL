import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Webhook payment.failure — 24-hour self-pay grace (source pins) ─────
//
// Direct product decision (2026-08-20): a failed collection attempt no
// longer earns its Default Fee (or a shot at terminal `defaulted`) the
// instant it fails — the patient gets FEE_GRACE_PERIOD_DAYS to settle
// manually first (T&Cs clause 7.5 covers deferring a fee at our
// discretion). This file pins that the webhook's payment.failure handler
// for instalment 2+ does ONLY that much and nothing more; the actual fee/
// terminal decision is pinned separately in dunningFeeGate.test.ts against
// lib/payments/assessDunningFee.ts, the ONLY caller of
// advanceLadderAfterFailure now.

const ROOT = resolve(process.cwd());
const SRC = readFileSync(resolve(ROOT, 'app/api/payments/peach/webhook/route.ts'), 'utf8');
// Comments stripped for the "gone entirely" pins below — this file's own
// prose discusses advanceLadderAfterFailure/dunningFeesEnabled/MAX_ATTEMPTS
// by name (explaining where they moved to), which would otherwise satisfy
// a naive substring check that is supposed to be pinning CODE, not prose.
const CODE = stripComments(SRC);

describe('payment.failure (instalment 2+) — records the failure, starts the grace clock, nothing else', () => {
  it('stamps dunning_grace_until = today + FEE_GRACE_PERIOD_DAYS, via the shared constant', () => {
    expect(SRC).toMatch(/import\s*\{\s*chargeAmountCents,\s*addDaysISO,\s*DUNNING_FEE_CENTS,\s*FEE_GRACE_PERIOD_DAYS\s*\}\s*from\s*'@\/lib\/payments\/dunning'/);
    expect(SRC).toMatch(/const graceUntil = addDaysISO\(todayUtc, FEE_GRACE_PERIOD_DAYS\)/);
    expect(SRC).toMatch(/dunning_grace_until:\s*graceUntil/);
  });

  it('does NOT call advanceLadderAfterFailure, dunningFeesEnabled, or MAX_ATTEMPTS any more', () => {
    // The whole ladder decision moved out — this file used to import and
    // call all three directly. Their absence from the CODE (not just the
    // prose explaining the move) IS the pin: a regression that re-adds a
    // synchronous ladder call here would re-skip the grace period
    // entirely.
    expect(CODE).not.toMatch(/advanceLadderAfterFailure/);
    expect(CODE).not.toMatch(/dunningFeesEnabled/);
    expect(CODE).not.toMatch(/MAX_ATTEMPTS/);
  });

  it('does not touch dunning_fees_cents, consecutive_failed_attempts, or next_attempt_date on failure', () => {
    // Scoped to the failure-handling function specifically, not the whole
    // file — the assessment/success paths elsewhere legitimately read
    // dunning_fees_cents.
    const fnStart = SRC.indexOf('async function handlePaymentFailure');
    const fnBody  = SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart));
    expect(fnBody).not.toMatch(/dunning_fees_cents:\s*\w/);
    expect(fnBody).not.toMatch(/consecutive_failed_attempts:\s*\w/);
    expect(fnBody).not.toMatch(/next_attempt_date:\s*\w/);
  });

  it('the only payments update on failure sets status/failure_reason/dunning_grace_until', () => {
    expect(SRC).toMatch(/status:\s*'failed',\s*\n\s*failure_reason:\s*failureReason,\s*\n\s*dunning_grace_until:\s*graceUntil,/);
  });

  it('notifies with feeGraceUntil, no fee, no next-attempt date (nothing is scheduled yet)', () => {
    expect(SRC).toMatch(/feeAppliedCents:\s*0,/);
    expect(SRC).toMatch(/nextAttemptDate:\s*null,/);
    expect(SRC).toMatch(/feeGraceUntil:\s*graceUntil,/);
  });

  it('the push names the fee amount and the grace deadline, not a verdict', () => {
    expect(SRC).toMatch(/Pay by \$\{formatISODate\(graceUntil\)\} to avoid a \$\{formatRandCents\(DUNNING_FEE_CENTS \/ 100\)\} default fee/);
  });
});

describe('payment.success (instalment 2+) — clears a pending grace decision', () => {
  it('the collected-instalment update clears dunning_grace_until', () => {
    const fnStart = SRC.indexOf('// ── Instalments 2+ — recurring collection ──');
    const fnBody  = SRC.slice(fnStart, fnStart + 1200);
    expect(fnBody).toMatch(/dunning_grace_until:\s*null/);
  });
});
