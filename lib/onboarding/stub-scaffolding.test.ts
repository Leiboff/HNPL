import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  affordabilityPolicyConfigured,
  assessAffordability,
} from '@/lib/underwriting/affordabilityPolicy';

// ─── Pre-launch scaffolding — what must NOT exist ──────────────────────
//
// This file used to prove that the onboarding stubs were isolated, clearly
// marked and swappable. Two of them are now gone entirely, and the
// assertions changed direction with them: from "the stub is well-labelled"
// to "no stub exists, and nothing has quietly grown back".
//
//   AFFORDABILITY  There was an unconditional R5,000 grant
//                  (stubAffordabilityPolicy). It was the reason the fraud
//                  chain in audit S-07 was worth running — every synthetic
//                  identity that reached the credit step was handed real
//                  spendable credit for free. Removed; the real credit
//                  check will determine the amount.
//   LIVENESS       There was an always-passes stubLivenessCheck behind a
//                  flag. Removed earlier; liveness is now proven by the
//                  Didit face match and written only by its webhook.
//
// The direction matters. A test that asserts a stub is well-labelled passes
// forever while the stub keeps handing out money. A test that asserts no
// limit can be granted fails the moment somebody reintroduces one.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const ACTIONS  = read('lib/onboarding/actions.ts');
const POLICY   = read('lib/underwriting/affordabilityPolicy.ts');
const HOME     = read('app/patient/page.tsx');
const BAL_CARD = read('app/patient/ApprovedBalanceCard.tsx');

describe('the R5,000 stub is gone', () => {
  it('the module no longer exists and nothing imports it', () => {
    expect(existsSync(resolve(ROOT, 'lib/underwriting/stubAffordabilityPolicy.ts'))).toBe(false);
    expect(ACTIONS).not.toMatch(/stubAffordabilityPolicy/);
  });

  it('no source file names the amount any more', () => {
    // The grep that used to prove the R5,000 had exactly ONE source now
    // proves it has none. Kept as a repo-wide walk rather than a check on
    // one file, because the failure being guarded against is somebody
    // hardcoding it back in at a call site.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', '.next', '.design-sync', '.git'].includes(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(name) || name.includes('.test.')) continue;
        const rel = full.slice(ROOT.length + 1).replace(/\\/g, '/');
        // 500_000 cents = R5,000. Also catches the rand form written long.
        if (/\b500_?000\b/.test(readFileSync(full, 'utf8'))) hits.push(rel);
      }
    };
    walk(join(ROOT, 'lib'));
    walk(join(ROOT, 'app'));
    expect(hits).toEqual([]);
  });
});

describe('the affordability seam grants nothing until it is configured', () => {
  it('reports itself as not configured', () => {
    expect(affordabilityPolicyConfigured()).toBe(false);
  });

  it('returns unavailable — not approved, and not declined either', () => {
    // 'unavailable' rather than 'declined' is load-bearing: a policy that is
    // not live yet, or a provider that could not be reached, must never sit
    // on an applicant's file as a refusal.
    const decision = assessAffordability({
      accountId: 'acct-1',
      salaryAmountRands: 45_000,
      salaryDay: 25,
      identityVerified: true,
    });
    expect(decision.outcome).toBe('unavailable');
    expect(decision).not.toHaveProperty('limitCents');
  });

  it('returns the same answer however generous the inputs', () => {
    // The adversarial version of the previous test. A seam that started
    // approving high earners would be an invented NCA affordability
    // assessment with no sign-off behind it — worse than the stub, because
    // the stub at least announced itself.
    for (const salary of [0, 1_000, 250_000, 10_000_000]) {
      const decision = assessAffordability({
        accountId: 'acct-1',
        salaryAmountRands: salary,
        salaryDay: 25,
        identityVerified: true,
      });
      expect(decision.outcome, `salary ${salary}`).toBe('unavailable');
    }
  });

  it('computes nothing from the declared salary', () => {
    // Pinned in source, because the tests above would also pass on a
    // formula that happened to return unavailable today.
    expect(POLICY).not.toMatch(/salaryAmountRands\s*[*/+-]/);
    expect(POLICY).not.toMatch(/limitCents\s*[:=]\s*[^;]*salary/i);
  });

  it('makes no network or provider calls', () => {
    expect(POLICY).not.toMatch(/\bfetch\s*\(/);
    expect(POLICY).not.toMatch(/https?:\/\//);
    expect(POLICY).not.toMatch(/\b(axios|XMLHttpRequest)\b/);
  });
});

describe('runCreditCheck persists the policy answer and nothing of its own', () => {
  it('reads the seam, never a literal', () => {
    expect(ACTIONS).toMatch(/from '@\/lib\/underwriting\/affordabilityPolicy'/);
    expect(ACTIONS).toMatch(/const decision = assessAffordability\(/);
    expect(ACTIONS).toMatch(/approved_credit_limit:\s*decision\.limitCents\s*\/\s*100/);
  });

  it('keeps the three outcomes distinct', () => {
    // declined → 'failed' (a decision on the file)
    // unavailable → 'pending' (no decision)
    // approved → 'passed' + a limit
    expect(ACTIONS).toMatch(/decision\.outcome === 'declined'/);
    expect(ACTIONS).toMatch(/decision\.outcome === 'unavailable'/);
    expect(ACTIONS).toMatch(/credit_check_status:\s*'failed'/);
    expect(ACTIONS).toMatch(/credit_check_status:\s*'pending'/);
    expect(ACTIONS).toMatch(/credit_check_status:\s*'passed'/);
  });

  it('never writes a limit on the unavailable path', () => {
    // The whole point. Extract the unavailable branch and assert the
    // column does not appear inside it.
    const start = ACTIONS.indexOf("if (decision.outcome === 'unavailable')");
    expect(start).toBeGreaterThan(-1);
    const branch = ACTIONS.slice(start, ACTIONS.indexOf('const { error } = await svc()', start));
    expect(branch).not.toMatch(/approved_credit_limit/);
  });
});

describe('the test-balance notice is gone with the stub', () => {
  // It said "Test balance — not real credit. This amount is for testing
  // only." That was true of the stub grant and will be false of the first
  // real limit the credit check sets. A permanent banner telling real
  // customers their real credit is fake is worse than no banner.
  it('the component no longer exists', () => {
    expect(existsSync(resolve(ROOT, 'app/patient/TestBalanceNotice.tsx'))).toBe(false);
  });

  it('nothing renders it', () => {
    expect(HOME).not.toMatch(/TestBalanceNotice/);
    expect(BAL_CARD).not.toMatch(/TestBalanceNotice/);
  });

  it('the balance card still renders nothing without a limit', () => {
    // What replaces the notice during the interim: no limit exists, so the
    // card is absent rather than showing a zero or a placeholder.
    expect(BAL_CARD).toMatch(/if \(limit == null\) return null;/);
  });
});

describe('liveness — NOT a stub, and NOT a separate step', () => {
  // There used to be a stubLivenessCheck() module that always returned
  // 'pass' without calling any provider, gated behind ENABLE_LIVENESS. Both
  // are gone.
  //
  // Liveness is now proven for real, inside the identity step: the Didit
  // session created there runs passive liveness and face-matches the selfie
  // against the identity-registry portrait, and its webhook writes
  // liveness_verified_at only on approval.
  //
  // Pinned as absent because a dormant always-passes liveness check in a
  // lender's onboarding flow is a liability. If it were ever switched on it
  // would stamp verified on anyone.

  it('the stub module no longer exists', () => {
    expect(existsSync(resolve(ROOT, 'lib/onboarding/liveness/stubLivenessCheck.ts'))).toBe(false);
  });

  it('nothing imports it, and no runLiveness action remains', () => {
    expect(ACTIONS).not.toMatch(/stubLivenessCheck/);
    expect(ACTIONS).not.toMatch(/export async function runLiveness/);
  });

  it('liveness_verified_at is written by the webhook, not by an onboarding action', () => {
    // The single place liveness is established. If an action starts writing
    // this column again, liveness has stopped meaning "a face match passed"
    // and started meaning "some code said so".
    const WEBHOOK = read('app/api/verification/didit/webhook/route.ts');
    expect(WEBHOOK).toMatch(/liveness_verified_at/);
    expect(ACTIONS).not.toMatch(/liveness_verified_at:\s*now/);
  });
});
