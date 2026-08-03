import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phase 4 — default = hard freeze from new plans (source pins) ───────────
//
// A single unresolved default freezes the patient out of taking ANY new
// plan. Enforcement is SERVER-SIDE at every plan-start path; the behaviour
// of the predicate itself lives in lib/patient/freeze.test.ts and the
// balance fix in lib/patient/approvedBalance.test.ts. These pins lock the
// gate into every entry point + the patient-facing surfaces so a future
// refactor can't silently drop one.

const ROOT = resolve(process.cwd());
function readSrc(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

// ─── Enforcement — every plan-start path rejects a frozen patient ───────────

describe('freeze enforced server-side at plan creation', () => {
  it('initiateCheckout (cold checkout) blocks a frozen returning patient', () => {
    const src = readSrc('app/checkout/[token]/actions.ts');
    expect(src).toMatch(/from\s+['"]@\/lib\/patient\/freeze['"]/);
    // Only returning users are queried (new users can't be frozen).
    expect(src).toMatch(/!isNewUser\s*&&\s*\(await isPatientFrozen\(svc,\s*userId\)\)/);
    expect(src).toMatch(/frozen:\s*true/);
  });

  it('acceptPlan (new-card acceptance) blocks a frozen patient before the velocity rule', () => {
    const src = readSrc('app/patient/actions.ts');
    // The freeze check appears before the one-plan-at-a-time gate.
    const freezeIdx = src.indexOf('isPatientFrozen(supabase, user.id)');
    const blockIdx  = src.indexOf('isBlockedFromNewPlan(user.id)');
    expect(freezeIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(-1);
    expect(freezeIdx).toBeLessThan(blockIdx);
  });

  it('payWithSavedCard (one-click) blocks a frozen patient — incl. a resume', () => {
    const src = readSrc('app/patient/actions.ts');
    expect(src).toMatch(/from\s+['"]@\/lib\/patient\/freeze['"]/);
    // Both new-plan actions surface the frozen flag to the caller.
    expect(src).toMatch(/frozen:\s*true/);
  });
});

// ─── Patient-facing surface — unmissable banner on home + orders ────────────

describe('freeze surfaced to the patient', () => {
  it('the home dashboard renders the freeze banner from the authoritative rollup', () => {
    const src = readSrc('app/patient/page.tsx');
    expect(src).toMatch(/from\s+['"]@\/lib\/patient\/freeze['"]/);
    expect(src).toMatch(/isPatientFrozen\(supabase,\s*user\.id\)/);
    expect(src).toMatch(/<DefaultFreezeBanner\s+frozen=\{isFrozen\}/);
  });

  it('the orders page renders the freeze banner', () => {
    const src = readSrc('app/patient/orders/page.tsx');
    expect(src).toMatch(/isPatientFrozen\(supabase,\s*user\.id\)/);
    expect(src).toMatch(/DefaultFreezeBanner/);
  });

  it('the banner copy names the default and the settle path', () => {
    const src = readSrc('app/patient/DefaultFreezeBanner.tsx');
    expect(src).toMatch(/defaulted plan/i);
    expect(src).toMatch(/can't take on any new plans|new plans until/i);
    expect(src).toContain('/patient/orders');
  });
});
