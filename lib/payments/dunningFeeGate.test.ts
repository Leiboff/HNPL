import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dunningFeesEnabled } from './dunning';

// ─── Phase 1 — dunning fee gate (compliance) ────────────────────────────
//
// Charging a default fee requires disclosed + accepted T&Cs — now live
// (lib/legal/terms.ts / lib/legal/privacy.ts). The gate itself stays: it
// is the single kill switch every charge point consults, defaulting OFF
// until DUNNING_FEES_ENABLED=true is set deliberately (an env var, not a
// code change — see lib/payments/dunning.ts). These tests pin:
//   • the flag's parsing (only the literal 'true' enables it)
//   • the three CHARGE-point gates in source (webhook accrual, the
//     per-instalment debit, the settle-entire-bill RPC total)
// The behavioural "gated → instalment only, ungated → fee applies" guard
// lives in chargeInstalment.test.ts against the real charge path.

const ROOT = resolve(process.cwd());
function readSrc(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

// ─── The flag ───────────────────────────────────────────────────────────

describe('dunningFeesEnabled — default OFF, only "true" enables', () => {
  afterEach(() => {
    delete process.env.DUNNING_FEES_ENABLED;
  });

  it('is OFF when the env var is unset', () => {
    delete process.env.DUNNING_FEES_ENABLED;
    expect(dunningFeesEnabled()).toBe(false);
  });

  it('is ON only for the exact literal "true"', () => {
    process.env.DUNNING_FEES_ENABLED = 'true';
    expect(dunningFeesEnabled()).toBe(true);
  });

  it.each(['false', '1', 'yes', 'TRUE', '', 'on'])(
    'is OFF for the non-"true" value %o (no accidental enable)',
    (val) => {
      process.env.DUNNING_FEES_ENABLED = val;
      expect(dunningFeesEnabled()).toBe(false);
    },
  );
});

// ─── Charge-point gates in source ───────────────────────────────────────

describe('fee gate — webhook accrual + terminal (source pins)', () => {
  const src = readSrc('app/api/payments/peach/webhook/route.ts');

  it('reads the gate and only accrues fees when enabled', () => {
    expect(src).toMatch(/const\s+feesEnabled\s*=\s*dunningFeesEnabled\(\)/);
    // dunning_fees_cents persists feesCentsAfter (= feesBefore when gated).
    expect(src).toMatch(/dunning_fees_cents:\s*feesCentsAfter/);
    expect(src).toMatch(/feesCentsAfter\s*=\s*feesEnabled\s*\?\s*ladder\.dunningFeesCentsAfter\s*:\s*feesBefore/);
  });

  it('drives the terminal off the MAX_ATTEMPTS backstop while gated', () => {
    expect(src).toMatch(/import\s*\{\s*MAX_ATTEMPTS\s*\}\s*from\s*'@\/lib\/payments\/chargeInstalment'/);
    expect(src).toMatch(/retry_count\s*\?\?\s*0\)\s*>=\s*MAX_ATTEMPTS/);
  });

  it('logs the would-be fee when gated', () => {
    expect(src).toContain('WOULD apply [gated]');
  });
});

describe('fee gate — per-instalment debit (source pin)', () => {
  const src = readSrc('lib/payments/chargeInstalment.ts');
  it('charges 0 fee when the gate is OFF', () => {
    expect(src).toMatch(/const\s+feesToCharge\s*=\s*feesEnabled\s*\?\s*previousFees\s*:\s*0/);
    expect(src).toMatch(/chargeAmountCents\(Number\(current\.amount\),\s*feesToCharge\)/);
  });
});

describe('fee gate — settle-entire-bill (source + migration pins)', () => {
  it('the action passes the gate through to the RPC', () => {
    const src = readSrc('app/patient/orders/settle-actions.ts');
    expect(src).toMatch(/p_include_fees:\s*dunningFeesEnabled\(\)/);
  });

  it('migration 0080 gates the summed total on p_include_fees', () => {
    const mig = readSrc('supabase/migrations/0080_gate_settlement_fees.sql');
    expect(mig).toMatch(/p_include_fees\s+BOOLEAN\s+DEFAULT\s+TRUE/i);
    expect(mig).toMatch(/CASE\s+WHEN\s+p_include_fees\s+THEN\s+COALESCE\(dunning_fees_cents,\s*0\)/i);
    // The snapshot still records the real fee (revert accuracy unchanged).
    expect(mig).toMatch(/'dunning_fees_cents',\s*COALESCE\(dunning_fees_cents,\s*0\)/);
  });
});
