import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ─── Anon checkout complete route — payouts-gap regression ──────────
//
// 1A finding: this route used to flip payments→collected and
// plans→active with its own inline .update() calls, never inserting a
// payouts row. Because this synchronous route usually wins the race to
// set plans.status='active' (same request, no round-trip to Peach's
// async webhook), the webhook's own dedup guard
// (`if (plan.status === 'active') return` in handlePaymentSuccess)
// would then see the plan already active and skip calling
// activateFirstInstalment entirely — permanently losing the payout for
// that plan, with no backstop that could ever fix it.
//
// Fix: route through the same shared activateFirstInstalment helper
// the portal payment-complete route and the Peach webhook already use,
// so all three writers converge on one idempotent choke point that
// always inserts the payout.
//
// These are source-inspection pins (mirrors the existing pattern in
// lib/payments/activateFirstInstalment.test.ts) rather than DB-backed
// tests, matching how the sibling wiring tests in this codebase pin
// caller wiring without a live Supabase instance.

describe('checkout complete route — payouts gap fix', () => {
  const src = readFileSync('app/checkout/[token]/complete/page.tsx', 'utf8');

  it('imports the shared activateFirstInstalment helper', () => {
    expect(src).toMatch(
      /import\s*\{\s*activateFirstInstalment\s*\}\s*from\s*'@\/lib\/payments\/activateFirstInstalment'/,
    );
  });

  it('calls activateFirstInstalment on the success path', () => {
    expect(src).toMatch(/await activateFirstInstalment\(/);
  });

  it('no longer does its own inline payments/plans terminal-state writes', () => {
    // The old inline writes updated payments to 'collected' and plans
    // to 'active' directly. Those literal update shapes must be gone —
    // activateFirstInstalment is now the only writer of those columns
    // on this success path.
    expect(src).not.toMatch(/status:\s*'collected',\s*collected_at:\s*new Date\(\)\.toISOString\(\)\s*\}\)\s*\.eq\('id',\s*payment\.id\)\s*\.eq\('status',\s*'processing'\)/);
    expect(src).not.toMatch(/status:\s*'active'\s*\}\)\s*\.eq\('id',\s*planId\)\s*\.eq\('status',\s*'pending_first_payment'\)/);
  });

  it('still marks the invitation accepted after activation', () => {
    const activateIdx = src.indexOf('await activateFirstInstalment(');
    const acceptedIdx = src.indexOf("accepted_at: new Date().toISOString()");
    expect(activateIdx).toBeGreaterThan(0);
    expect(acceptedIdx).toBeGreaterThan(activateIdx);
  });
});
