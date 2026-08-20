import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Webhook payment.success (instalment 2+) — defaulted-balance auto-recovery (source pins) ─
//
// Direct product decision (2026-08-20): a 'defaulted' instalment stopped
// being retried by the cron entirely (see settle-actions.ts's status
// whitelist comment) — the debt just sat there frozen forever unless the
// patient self-settled or an admin wrote it off, even while the SAME
// card kept successfully collecting later instalments on the same plan.
// Now: any successful instalment collection is also the trigger to
// attempt any OTHER defaulted instalment on the same plan — each as its
// OWN separate Peach charge (own reference, own amount), never bundled
// into the instalment that just succeeded. This file pins that shape.

const ROOT = resolve(process.cwd());
const SRC = readFileSync(resolve(ROOT, 'app/api/payments/peach/webhook/route.ts'), 'utf8');

describe('payment.success (instalment 2+) — auto-recovers defaulted siblings on the same plan', () => {
  it('imports attemptChargeInstalment', () => {
    expect(SRC).toMatch(/import\s*\{\s*attemptChargeInstalment\s*\}\s*from\s*'@\/lib\/payments\/chargeInstalment'/);
  });

  it('queries for OTHER defaulted instalments on the same plan', () => {
    const fnStart = SRC.indexOf('// ── Recover any other defaulted balance on this plan ──');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = SRC.slice(fnStart, fnStart + 1800);
    expect(fnBody).toMatch(/\.eq\('plan_id',\s*plan\.id\)/);
    expect(fnBody).toMatch(/\.eq\('kind',\s*'instalment'\)/);
    expect(fnBody).toMatch(/\.eq\('status',\s*'defaulted'\)/);
  });

  it('fires ONE separate attemptChargeInstalment call per defaulted row, with selfSettle:true', () => {
    const fnStart = SRC.indexOf('// ── Recover any other defaulted balance on this plan ──');
    const fnBody = SRC.slice(fnStart, fnStart + 2200);
    // Inside a loop over the query result — one call per row, not a
    // single summed/bundled charge.
    expect(fnBody).toMatch(/for\s*\(const sibling of \(defaultedSiblings/);
    expect(fnBody).toMatch(/attemptChargeInstalment\(supabase,\s*sibling\.id,\s*\{\s*selfSettle:\s*true\s*\}\)/);
  });

  it('does not touch the amount/status of the triggering payment when recovering siblings — no bundling', () => {
    // The recovery loop only ever reads sibling.id and calls
    // attemptChargeInstalment with it; it must never reference
    // payment.amount or payment.dunning_fees_cents (which would signal
    // a bundled/summed charge instead of separate ones).
    const fnStart = SRC.indexOf('// ── Recover any other defaulted balance on this plan ──');
    const loopStart = SRC.indexOf('for (const sibling of', fnStart);
    const loopBody = SRC.slice(loopStart, SRC.indexOf('\n  }\n', loopStart));
    expect(loopBody).not.toMatch(/payment\.amount/);
    expect(loopBody).not.toMatch(/collectedCents/);
  });

  it('runs before the plan-completion check, so a recovered plan is not marked completed early by accident', () => {
    const recoveryIdx   = SRC.indexOf('// ── Recover any other defaulted balance on this plan ──');
    const completionIdx = SRC.indexOf("status: 'completed'", recoveryIdx);
    expect(recoveryIdx).toBeGreaterThan(-1);
    expect(completionIdx).toBeGreaterThan(recoveryIdx);
  });
});
