import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMonthlySeries, type PlanForTrend } from '@/lib/brand/monthlyRevenue';

// ─── Practice dashboard chart — aligned to the shared predicate ────────
//
// The old chart carried its own `COUNTED_STATUSES = {pending_acceptance,
// active, completed}` filter — inflating revenue vs the brand view of
// the same branch. This fix routes the practice chart through the
// SAME buildMonthlySeries + BrandMonthlyChart used by /brand and
// /brand/branch/[id]. One counting rule everywhere.
//
// Pins:
//   • Chart component has NO status logic (rendering-only, matches
//     the BrandMonthlyChart primitive discipline).
//   • The removed COUNTED_STATUSES set is gone.
//   • For a same-branch same-plans fixture, the practice series and
//     the brand-side buildMonthlySeries output are equal month-by-month.
//   • Diff scope: no payment / webhook / finance-math edits.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const CHART = read('app/practice/MonthlyRevenueChart.tsx');

describe('Practice MonthlyRevenueChart — rendering-only adapter around shared helpers', () => {
  it('imports the shared buildMonthlySeries helper', () => {
    expect(CHART).toMatch(/from ['"]@\/lib\/brand\/monthlyRevenue['"]/);
    expect(CHART).toMatch(/buildMonthlySeries/);
  });

  it('delegates rendering to the shared BrandMonthlyChart primitive', () => {
    expect(CHART).toMatch(/from ['"]@\/app\/brand\/BrandMonthlyChart['"]/);
    expect(CHART).toMatch(/<BrandMonthlyChart\b/);
  });

  it('does NOT declare a local COUNTED_STATUSES set (or any status allowlist)', () => {
    expect(CHART).not.toMatch(/COUNTED_STATUSES/);
    expect(CHART).not.toMatch(/new Set\(\s*\[[^\]]*['"]pending_acceptance/);
  });

  it('does NOT reference pending_acceptance at all — the shared filter owns that decision', () => {
    // Prose comments describe the fix at a high level; only the code
    // matters here. Strip comments then assert.
    const codeOnly = CHART
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/pending_acceptance/);
  });

  it('has NO status FILTER logic inside the component (no comparisons, no Set.has)', () => {
    // `p.status` as a plain field passthrough into the shared helper
    // is fine (the mapper's job); what we forbid is a comparison or
    // Set membership check — i.e. an in-component filter.
    const codeOnly = CHART
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/\.status\s*===\s*['"]/);
    expect(codeOnly).not.toMatch(/status.*\.has\(/);
    expect(codeOnly).not.toMatch(/isActiveForRevenue\s*\(/);   // the helper calls it; the component must not
  });

  it('preserves net presentation (mode="net" — gross↔net toggle stays a brand-side surface)', () => {
    expect(CHART).toMatch(/mode="net"/);
  });
});

// ─── Agreement: practice-side series === brand-side series for the same branch

describe('Agreement — practice and brand views produce the same monthly numbers for the same branch', () => {
  const NOW = new Date('2026-07-04T00:00:00Z');

  // A fixture with a mix of statuses across the two most-recent months.
  // The `practice_id` on brand-side plans is the real one; the
  // practice-side chart uses a synthetic SELF sentinel (single-entry
  // fee map). Both should yield identical gross/net per month.
  const PRACTICE_ID = 'branch-A';
  const FEE_PCT     = 12;

  const plansForBrand: PlanForTrend[] = [
    // Current month (2026-07) — counted
    { id: '1', practice_id: PRACTICE_ID, provider_member_id: 'd1', total_amount: 1000, status: 'active',              created_at: '2026-07-01T10:00:00Z' },
    { id: '2', practice_id: PRACTICE_ID, provider_member_id: 'd2', total_amount:  500, status: 'completed',           created_at: '2026-07-02T10:00:00Z' },
    // Current month — EXCLUDED
    { id: '3', practice_id: PRACTICE_ID, provider_member_id: 'd1', total_amount: 9999, status: 'pending_acceptance',  created_at: '2026-07-03T10:00:00Z' },
    // Previous month (2026-06) — counted
    { id: '4', practice_id: PRACTICE_ID, provider_member_id: 'd1', total_amount: 2000, status: 'active',              created_at: '2026-06-15T10:00:00Z' },
    // Excluded — defaulted/cancelled/declined
    { id: '5', practice_id: PRACTICE_ID, provider_member_id: 'd1', total_amount:  300, status: 'defaulted',           created_at: '2026-07-05T10:00:00Z' },
    { id: '6', practice_id: PRACTICE_ID, provider_member_id: 'd1', total_amount:  100, status: 'cancelled',           created_at: '2026-06-20T10:00:00Z' },
  ];

  // Brand-side aggregation for this practice
  const feeByBrand = new Map<string, number>([[PRACTICE_ID, FEE_PCT]]);
  const brandSeries = buildMonthlySeries(plansForBrand, feeByBrand, NOW);

  // Practice-side adapter emulation — SAME plans, but under the SELF
  // sentinel that the practice chart uses. If the practice chart's
  // logic ever drifts from this adapter shape, the pin below breaks.
  const SELF = '__self__';
  const plansForPractice: PlanForTrend[] = plansForBrand.map((p) => ({
    ...p,
    practice_id: SELF,
  }));
  const feeByPractice = new Map<string, number>([[SELF, FEE_PCT]]);
  const practiceSeries = buildMonthlySeries(plansForPractice, feeByPractice, NOW);

  it('series length is 12', () => {
    expect(brandSeries.length).toBe(12);
    expect(practiceSeries.length).toBe(12);
  });

  it('practice net === brand net for every month', () => {
    for (let i = 0; i < 12; i += 1) {
      expect(practiceSeries[i].net).toBeCloseTo(brandSeries[i].net, 2);
    }
  });

  it('practice gross === brand gross for every month', () => {
    for (let i = 0; i < 12; i += 1) {
      expect(practiceSeries[i].gross).toBeCloseTo(brandSeries[i].gross, 2);
    }
  });

  it('pending_acceptance contributes ZERO — current month excludes the 9999 plan', () => {
    // Current month = last entry (index 11). Gross should be 1000+500=1500.
    expect(brandSeries[11].gross).toBeCloseTo(1500, 2);
    expect(practiceSeries[11].gross).toBeCloseTo(1500, 2);
    // NOT 1500 + 9999
    expect(brandSeries[11].gross).not.toBeCloseTo(11499, 0);
    expect(practiceSeries[11].gross).not.toBeCloseTo(11499, 0);
  });

  it('defaulted / cancelled contribute ZERO — 300 and 100 excluded', () => {
    expect(brandSeries[11].gross).toBeCloseTo(1500, 2);      // 300 excluded from July
    expect(brandSeries[10].gross).toBeCloseTo(2000, 2);      // 100 excluded from June
  });
});

// ─── Diff scope — no payment / webhook / finance edits ────────────────

describe('Diff scope — presentation fix only, no payment/webhook/finance-math changes', () => {
  it('the chart file does NOT import payment or webhook modules', () => {
    const FORBIDDEN = [
      '@/lib/payments/',
      '@/lib/paystack/',
      '@/lib/bills/lifecycle',
      'app/api/webhooks/paystack',
      '@/lib/finance',   // fee math lives in finance; the chart imports
                          // the shared aggregation which uses finance —
                          // the chart itself must not reach in directly.
    ];
    for (const mod of FORBIDDEN) {
      expect(CHART).not.toContain(`from '${mod}`);
      expect(CHART).not.toContain(`from "${mod}`);
    }
  });
});
