import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phase 5 — webhook push format + defaulted parity (source pins) ─────────
//
// The failure PUSH was flagged in the audit as "double-divides / understates
// 100×". That is a FALSE ALARM: this file's formatRandCents takes RANDS
// (unlike the same-named helper in dunningNotifications, which takes cents),
// so `formatRandCents(attemptedAmountCents / 100)` is the CORRECT cents→rands
// conversion. These pins lock the correct behaviour so nobody "fixes" it.

const ROOT = resolve(process.cwd());
const SRC = readFileSync(
  resolve(ROOT, 'app/api/payments/peach/webhook/route.ts'),
  'utf8',
);
// RE-POINTED (2026-08-20): the fee/terminal decision — and the push that
// conveys it — moved out of the webhook into the grace-elapsed assessment
// pass. See lib/payments/assessDunningFee.ts and the 24-hour self-pay
// grace this file's OWN failure push now sends instead (checked below).
const ASSESS_SRC = readFileSync(
  resolve(ROOT, 'lib/payments/assessDunningFee.ts'),
  'utf8',
);

describe('webhook push — rand formatting is correct (not a bug)', () => {
  it('formatRandCents in this file takes RANDS', () => {
    expect(SRC).toMatch(/function formatRandCents\(rands: number\)/);
    // Body divides nothing — it formats the rands it is given.
    expect(SRC).toMatch(/rands\.toFixed\(2\)/);
  });

  it('the failure push converts cents→rands with / 100 (correct)', () => {
    expect(SRC).toMatch(/formatRandCents\(attemptedAmountCents \/ 100\)/);
    // A guard comment warns against "fixing" the /100 away.
    expect(SRC).toMatch(/Do NOT[\s\S]{0,40}fix[\s\S]{0,40}\/100|takes RANDS/i);
  });
});

describe('webhook push — the immediate failure notice offers the grace deadline, not a verdict', () => {
  it('names the fee amount and the pay-by date, no fee/terminal decision yet', () => {
    // The webhook's payment.failure handler no longer decides fee or
    // terminal at all — that whole decision (and its push) moved to the
    // grace-elapsed assessment pass, 24h later. This push can only ever
    // say "pay by X to avoid a fee", never "a fee was added" or "frozen".
    expect(SRC).toMatch(/Pay by \$\{formatISODate\(graceUntil\)\} to avoid a \$\{formatRandCents\(DUNNING_FEE_CENTS \/ 100\)\} default fee/);
    expect(SRC).not.toMatch(/Account frozen/);
  });
});

describe('assessDunningFee push — parity on the defaulted (terminal) attempt', () => {
  it('has an isTerminal branch that conveys the freeze', () => {
    // Renamed from `capReached` when the ladder gained a second terminal
    // signal (the next-instalment due-date boundary, alongside the fee
    // cap) — see lib/payments/dunning.ts. The push copy is keyed off
    // "is this attempt terminal", not specifically "was the fee cap hit".
    expect(ASSESS_SRC).toMatch(/isTerminal\s*\?\s*'Account frozen/);
    expect(ASSESS_SRC).toMatch(/frozen from new plans until you settle/i);
  });

  it('tags the terminal push distinctly as defaulted', () => {
    expect(ASSESS_SRC).toMatch(/payment:\$\{paymentId\}:defaulted/);
  });
});
