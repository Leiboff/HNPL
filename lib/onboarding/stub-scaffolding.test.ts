import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Stub onboarding scaffolding — isolation + safety invariants ───────
//
// Proves the pre-launch stubs are (1) isolated in one clearly-marked
// module each, (2) the R5,000 has exactly one source, (3) genuinely
// swappable (the actions read the modules, never a literal), (4) do no
// real bureau/liveness/credit work, and (5) never show a balance without
// the shared test-balance notice.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const ACTIONS  = read('lib/onboarding/actions.ts');
const AFFORD   = read('lib/underwriting/stubAffordabilityPolicy.ts');
const LIVENESS = read('lib/onboarding/liveness/livenessCheck.ts');
// Whitespace-collapsed views so phrase checks survive comment line-wraps.
const AFFORD1  = AFFORD.replace(/\s+/g, ' ');
const HOME     = read('app/patient/page.tsx');
const BAL_CARD = read('app/patient/ApprovedBalanceCard.tsx');
const NOTICE   = read('app/patient/TestBalanceNotice.tsx');

describe('affordability — one isolated, clearly-marked stub', () => {
  it('carries a prominent STUB / not-a-real-assessment warning', () => {
    expect(AFFORD).toMatch(/STUB/);
    expect(AFFORD).toMatch(/NOT an NCA affordability assessment/i);
    expect(AFFORD).toMatch(/NO credit check/i);
    expect(AFFORD1).toMatch(/replace this entire module.*before/i);
  });

  it('runCreditCheck grants the limit FROM the policy, never a hardcoded amount', () => {
    expect(ACTIONS).toMatch(/from '@\/lib\/underwriting\/stubAffordabilityPolicy'/);
    expect(ACTIONS).toMatch(/const decision = stubAffordabilityPolicy\(\)/);
    // The persisted rands are derived from the policy's cents — no literal.
    expect(ACTIONS).toMatch(/approved_credit_limit:\s*decision\.limitCents\s*\/\s*100/);
    expect(ACTIONS).toMatch(/credit_check_status:\s*'passed'/);
    // A non-approval path exists (proves the decision is load-bearing).
    expect(ACTIONS).toMatch(/if \(!decision\.approved\)/);
  });
});

describe('liveness — real Datanamix integration, one isolated module', () => {
  it('runLiveness gates on checkLiveness (swappable to fail), never assumes a pass', () => {
    expect(ACTIONS).toMatch(/from '@\/lib\/onboarding\/liveness\/livenessCheck'/);
    expect(ACTIONS).toMatch(/await checkLiveness\(scan\)\s*!==\s*'pass'/);
  });

  it('the pass/fail decision comes from Datanamix\'s live /liveness-3d endpoint, not a hardcoded verdict', () => {
    expect(LIVENESS).toMatch(/from '@\/lib\/facetec\/datanamixClient'/);
    expect(LIVENESS).toMatch(/postLiveness3d/);
    expect(LIVENESS).not.toMatch(/return\s+'pass';\s*$/m);
  });
});

describe('the R5,000 has exactly ONE source (grep proves no second)', () => {
  it('500_000 / 500000 appears only in stubAffordabilityPolicy.ts', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', '.next', '.design-sync', '.git'].includes(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(name) || name.includes('.test.')) continue;
        const rel = full.slice(ROOT.length + 1).replace(/\\/g, '/');
        if (/\b500_?000\b/.test(readFileSync(full, 'utf8'))) hits.push(rel);
      }
    };
    walk(join(ROOT, 'lib'));
    walk(join(ROOT, 'app'));
    expect(hits).toEqual(['lib/underwriting/stubAffordabilityPolicy.ts']);
  });
});

describe('adversarial — affordability is still a no-op stub; liveness is not', () => {
  it('the affordability stub makes no network / provider calls and takes no inputs', () => {
    expect(AFFORD).not.toMatch(/\bfetch\s*\(/);
    expect(AFFORD).not.toMatch(/https?:\/\//);
    expect(AFFORD).not.toMatch(/\b(axios|XMLHttpRequest)\b/);
    // Zero-arg policy — no income/expense inputs are collected to compute from.
    expect(AFFORD).toMatch(/export function stubAffordabilityPolicy\(\):/);
  });

  it('liveness DOES make a real provider call (proves it left stub status)', () => {
    expect(LIVENESS).toMatch(/\bawait\s+postLiveness3d\s*\(/);
  });
});

describe('test-balance notice — shared, non-dismissable, always with the balance', () => {
  it('the notice has no dismiss control and no client state', () => {
    // Look for actual dismiss affordances / interactivity, not the word
    // "dismiss" in the component's own explanatory comment.
    expect(NOTICE).not.toMatch(/useState|onClick|<button|'use client'/);
    expect(NOTICE).toMatch(/not real credit/i);
    expect(NOTICE).toMatch(/testing only/i);
  });

  it('the dashboard renders it whenever a limit is set', () => {
    expect(HOME).toMatch(/import TestBalanceNotice from '\.\/TestBalanceNotice'/);
    expect(HOME).toMatch(/approvedLimit != null && <TestBalanceNotice \/>/);
  });

  it('ApprovedBalanceCard renders it inseparably from the amount', () => {
    expect(BAL_CARD).toMatch(/import TestBalanceNotice from '\.\/TestBalanceNotice'/);
    expect(BAL_CARD).toMatch(/<TestBalanceNotice \/>/);
  });
});
