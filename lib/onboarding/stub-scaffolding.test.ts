import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Pre-launch scaffolding — pinned ABSENT ────────────────────────────
//
// This file used to prove the onboarding stubs were well-isolated,
// clearly marked and swappable. Both are now gone, and the file's job has
// inverted: it proves they cannot come back.
//
//   • stubLivenessCheck() always returned 'pass' without calling any
//     provider. Removed when the Didit face match landed.
//
//   • stubAffordabilityPolicy() approved an unconditional R5,000 with no
//     bureau call and no affordability computation of any kind. Its own
//     banner said to replace the entire module before any real customer
//     was onboarded. Removed when the assessment pipeline landed.
//
// Both are pinned absent for the same reason, and it is the reason the
// liveness section already gave: a dormant always-approves policy in a
// lender's onboarding flow is a liability, not an option. Left in the
// tree it would be one import away from granting R5,000 to anybody, and
// it would look — to a reader and to a future edit — like a supported
// fallback rather than a decommissioned stub.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const ACTIONS = read('lib/onboarding/actions.ts');
const HOME    = read('app/patient/page.tsx');

describe('affordability — the stub is gone, and the real pipeline is wired', () => {
  it('the stub module no longer exists', () => {
    expect(existsSync(resolve(ROOT, 'lib/underwriting/stubAffordabilityPolicy.ts'))).toBe(false);
  });

  it('nothing imports it', () => {
    const hits: string[] = [];
    walkSources((rel, src) => {
      if (/stubAffordabilityPolicy/.test(src)) hits.push(rel);
    });
    expect(hits).toEqual([]);
  });

  it('runCreditCheck calls the real affordability assessment', () => {
    expect(ACTIONS).toMatch(/assessAffordability\(/);
    expect(ACTIONS).toMatch(/from '@\/lib\/onboarding\/creditAssessment'/);
  });

  it('runCreditCheck no longer grants any hardcoded amount', () => {
    // The limit is whatever the pure calculation returned, persisted by
    // the store. No literal rand figure appears on this path.
    expect(ACTIONS).not.toMatch(/approved_credit_limit:\s*\d/);
    expect(ACTIONS).not.toMatch(/limitCents/);
  });

  it('the R5,000 test grant appears nowhere in the tree', () => {
    const hits: string[] = [];
    walkSources((rel, src) => {
      if (/\b500_?000\b/.test(src)) hits.push(rel);
    });
    expect(hits).toEqual([]);
  });
});

describe('liveness — NOT a stub, and NOT a separate step', () => {
  it('the stub module no longer exists', () => {
    expect(existsSync(resolve(ROOT, 'lib/onboarding/liveness/stubLivenessCheck.ts'))).toBe(false);
  });

  it('nothing imports it, and no runLiveness action remains', () => {
    expect(ACTIONS).not.toMatch(/stubLivenessCheck/);
    expect(ACTIONS).not.toMatch(/export async function runLiveness/);
  });

  it('liveness_verified_at is written by the webhook, not by an onboarding action', () => {
    // The single place liveness is established. If an action starts
    // writing this column again, liveness has stopped meaning "a face
    // match passed" and started meaning "some code said so".
    const WEBHOOK = read('app/api/verification/didit/webhook/route.ts');
    expect(WEBHOOK).toMatch(/liveness_verified_at/);
    expect(ACTIONS).not.toMatch(/liveness_verified_at:\s*now/);
  });
});

describe('the test-balance notice now tracks whether a limit was assessed', () => {
  it('renders only when the limit has no backing assessment', () => {
    // Telling a really-assessed patient that no affordability assessment
    // has been performed would be a false statement on a money surface.
    // Deleting it outright would be the opposite problem, because stub-era
    // limits still exist on real accounts.
    expect(HOME).toMatch(/approvedLimit != null && !assessed && <TestBalanceNotice \/>/);
    expect(HOME).toMatch(/const assessed =/);
    expect(HOME).toMatch(/current_credit_assessment_id/);
  });

  it('the notice itself is still non-dismissable where it does apply', () => {
    const NOTICE = read('app/patient/TestBalanceNotice.tsx');
    expect(NOTICE).not.toMatch(/useState|onClick|<button|'use client'/);
    expect(NOTICE).toMatch(/not real credit/i);
    expect(NOTICE).toMatch(/testing only/i);
  });
});

describe('the dashboard shows the full limit alongside what is committed', () => {
  it('never reduces the displayed limit for a first-timer', () => {
    // The concurrency rule is spelled out instead, so the figure on the
    // dashboard agrees with the one quoted at sign-up.
    expect(HOME).toMatch(/const firstTimer =/);
    expect(HOME).toMatch(/home-first-timer-caveat/);
    expect(HOME).toMatch(/\{formatRand\(approvedLimit\)\} limit/);
  });

  it('computes the balance from plans, not a separate scan of payments', () => {
    // Three definitions of exposure was how the number a patient saw came
    // to differ from the number that refused them.
    expect(HOME).toMatch(/availableBalance\(approvedLimit, allPlans\)/);
    expect(HOME).toMatch(/committedExposure\(allPlans\)/);
  });
});

/**
 * Walk every non-test TS/TSX source under lib/ and app/, with COMMENTS
 * STRIPPED.
 *
 * These scans assert that nothing imports the stub and that the R5,000
 * appears nowhere — claims about code, not about prose. Several files
 * legitimately discuss the decommissioned stub in their headers (that is
 * how the decision documents itself), and a raw text scan would count
 * those as violations, pushing the next person to delete the explanation
 * rather than the code.
 */
function walkSources(visit: (rel: string, src: string) => void): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', '.design-sync', '.git'].includes(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(name) || name.includes('.test.')) continue;
      const rel = full.slice(ROOT.length + 1).replace(/\\/g, '/');
      visit(rel, stripComments(readFileSync(full, 'utf8'), { preserveUrls: true, jsxBraces: true }));
    }
  };
  walk(join(ROOT, 'lib'));
  walk(join(ROOT, 'app'));
}
