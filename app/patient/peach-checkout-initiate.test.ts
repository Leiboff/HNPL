import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /patient initializeFirstPayment — Peach V2 SI shape ────────────
//
// Same regression fix as the checkout/[token] one — the signed-in
// patient's "Confirm and Pay First Instalment" surface also went
// through provider.createCheckout() and inherited the same broken
// standingInstruction shape (frequency string, planType=2 omit). If
// either surface reverts, the initiate throws "Peach checkout error:
// Invalid request body" and the widget never mounts.
//
// This test pins the shape at the action source, not at the provider
// layer (which is pinned separately in lib/payments/peach/client.test.ts).

const ROOT    = resolve(process.cwd());
const actions = readFileSync(resolve(ROOT, 'app/patient/actions.ts'), 'utf8');

describe('initializeFirstPayment — Peach V2 standingInstruction shape', () => {
  it('sends numberOfInstallments = planType (a valid 1-999 integer)', () => {
    // Find the initializeFirstPayment function scope.
    const startIdx = actions.indexOf('export async function initializeFirstPayment');
    expect(startIdx).toBeGreaterThan(0);
    const endIdx = actions.indexOf('export async function', startIdx + 1);
    const scope  = actions.slice(startIdx, endIdx > 0 ? endIdx : undefined);
    expect(scope).toMatch(/numberOfInstallments:\s*planType/);
    // The old omit-when-2 conditional must be gone.
    expect(scope).not.toMatch(/planType\s*===\s*3\s*\?\s*3\s*:\s*undefined/);
  });

  it('sends frequency as INTEGER 30 (days), NOT the string "0001"', () => {
    const startIdx = actions.indexOf('export async function initializeFirstPayment');
    const endIdx   = actions.indexOf('export async function', startIdx + 1);
    const scope    = actions.slice(startIdx, endIdx > 0 ? endIdx : undefined);
    expect(scope).toMatch(/frequency:\s*30\b/);
    expect(scope).not.toMatch(/frequency:\s*['"]0001['"]/);
  });
});
