import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Home hero overdue total — one source of truth with the Plans header ──
//
// The hero must never show a single overdue instalment's amount while
// several are overdue. Both the hero and the Plans header read the SAME
// summariseOutstanding helper, and the hero shows the aggregate total +
// count when >1 is overdue. Source pins (the home page is an async RSC with
// live data fetches, so behaviour is pinned at source; the aggregation logic
// itself is covered behaviourally in lib/patient/outstanding.test.ts).

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const HOME  = read('app/patient/page.tsx');
const PLANS = read('app/patient/orders/page.tsx');

describe('one source of truth', () => {
  it('both the hero and the Plans header import summariseOutstanding', () => {
    expect(HOME).toMatch(/import \{ summariseOutstanding \} from '@\/lib\/patient\/outstanding'/);
    expect(PLANS).toMatch(/import \{ summariseOutstanding \} from '@\/lib\/patient\/outstanding'/);
  });

  it('the Plans header no longer computes its own parallel total', () => {
    // The old inline loop is gone — the helper owns the math now.
    expect(PLANS).not.toContain("new Set(['scheduled', 'processing', 'failed', 'defaulted'])");
    expect(PLANS).toMatch(/summariseOutstanding\(\s*currentPlans\.flatMap/);
  });
});

describe('hero aggregates when more than one is overdue', () => {
  it('computes the overdue aggregate from the shared helper', () => {
    expect(HOME).toMatch(/summariseOutstanding\(payments, today\)/);
  });

  it('only aggregates when overdueCount > 1 (single overdue keeps its exact amount)', () => {
    expect(HOME).toMatch(/overdue\.overdueCount > 1/);
    expect(HOME).toMatch(/overdueAll\s*\?\s*overdueAll\.amount\s*:\s*nextPayment\.amount/);
  });

  it('shows the count and the true overdue total, not one instalment', () => {
    expect(HOME).toMatch(/overdueCents \/ 100/);
    expect(HOME).toMatch(/overdue payments across your plans/);
    expect(HOME).toMatch(/\$\{overdueAll\.count\} overdue/);
  });

  it('"View & pay" routes to the Plans list (clears all) when multiple are overdue', () => {
    expect(HOME).toMatch(/overdueAll \? '\/patient\/orders' :/);
  });
});
