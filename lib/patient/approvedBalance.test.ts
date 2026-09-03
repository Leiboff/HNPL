import { describe, it, expect } from 'vitest';
import {
  availableBalance,
  committedExposure,
  planExposure,
  balanceSummary,
  type PlanForBalance,
} from './approvedBalance';

// ─── Approved-balance widget math ───────────────────────────────────────
//
// The widget must agree with the thing that actually refuses a plan. Two
// exposure models coexist (migration 0140), so both are pinned here.

/** A plan under the full-value model. */
function fullValue(over: Partial<PlanForBalance> = {}): PlanForBalance {
  return {
    status: 'active',
    full_value_exposure: true,
    financed_amount: 5_000,
    total_amount: 5_000,
    excess_amount: 0,
    payments: [
      { amount: 2_500, status: 'collected',  kind: 'instalment', instalment_number: 1 },
      { amount: 2_500, status: 'scheduled',  kind: 'instalment', instalment_number: 2 },
    ],
    ...over,
  };
}

/** A plan written before 0140, on declining-balance. */
function legacy(over: Partial<PlanForBalance> = {}): PlanForBalance {
  return {
    status: 'active',
    full_value_exposure: false,
    total_amount: 5_000,
    excess_amount: 0,
    payments: [
      { amount: 2_500, status: 'scheduled', kind: 'instalment', instalment_number: 1 },
      { amount: 2_500, status: 'scheduled', kind: 'instalment', instalment_number: 2 },
    ],
    ...over,
  };
}

// ═══ The rule the whole model turns on ═════════════════════════════════

describe('paying an instalment does NOT free headroom', () => {
  it('a plan half paid holds exactly what it held on day one', () => {
    const dayOne = fullValue({
      payments: [
        { amount: 2_500, status: 'processing', kind: 'instalment', instalment_number: 1 },
        { amount: 2_500, status: 'scheduled',  kind: 'instalment', instalment_number: 2 },
      ],
    });
    const halfPaid = fullValue(); // instalment 1 collected

    expect(planExposure(dayOne)).toBe(5_000);
    expect(planExposure(halfPaid)).toBe(5_000);
    expect(availableBalance(10_000, [dayOne])).toBe(availableBalance(10_000, [halfPaid]));
  });

  it('two of three instalments paid still holds the full value', () => {
    const plan = fullValue({
      financed_amount: 6_000, total_amount: 6_000,
      payments: [
        { amount: 2_000, status: 'collected', kind: 'instalment', instalment_number: 1 },
        { amount: 2_000, status: 'collected', kind: 'instalment', instalment_number: 2 },
        { amount: 2_000, status: 'scheduled', kind: 'instalment', instalment_number: 3 },
      ],
    });
    expect(planExposure(plan)).toBe(6_000);
  });

  it('releases the whole amount in one step on completion', () => {
    expect(planExposure(fullValue({ status: 'completed' }))).toBe(0);
    expect(availableBalance(10_000, [fullValue({ status: 'completed' })])).toBe(10_000);
  });
});

describe('what releases headroom and what does not', () => {
  it.each([
    ['completed', 0],
    ['cancelled', 0],
    ['declined',  0],
    ['pending_acceptance', 0],
  ])('a %s plan holds nothing', (status, expected) => {
    expect(planExposure(fullValue({ status }))).toBe(expected);
  });

  it.each(['pending_first_payment', 'active'])('a %s plan holds its full value', (status) => {
    expect(planExposure(fullValue({ status }))).toBe(5_000);
  });

  it('a DEFAULTED plan keeps holding — the debt has not gone anywhere', () => {
    // Releasing on default would perversely free the limit at the exact
    // moment the patient stopped paying.
    expect(planExposure(fullValue({ status: 'defaulted' }))).toBe(5_000);
  });

  it('a written-off instalment does not release the plan either', () => {
    const plan = fullValue({
      payments: [
        { amount: 2_500, status: 'written_off', kind: 'instalment', instalment_number: 1 },
        { amount: 2_500, status: 'written_off', kind: 'instalment', instalment_number: 2 },
      ],
    });
    expect(planExposure(plan)).toBe(5_000);
  });

  it('uses financed_amount, not total_amount, when they differ', () => {
    // The excess was collected up front and is the customer's own money,
    // not credit. Charging the gross would overstate what HNPL carries.
    const plan = fullValue({ financed_amount: 4_000, total_amount: 9_000, excess_amount: 5_000 });
    expect(planExposure(plan)).toBe(4_000);
  });

  it('falls back to total_amount for a row with no financed_amount', () => {
    expect(planExposure(fullValue({ financed_amount: null, total_amount: 7_000 }))).toBe(7_000);
  });
});

// ═══ Legacy plans keep the arithmetic they were accepted under ═════════

describe('plans written before 0140 stay on declining balance', () => {
  it('a half-paid legacy plan owes less, as it always did', () => {
    const plan = legacy({
      payments: [
        { amount: 2_500, status: 'collected', kind: 'instalment', instalment_number: 1 },
        { amount: 2_500, status: 'scheduled', kind: 'instalment', instalment_number: 2 },
      ],
    });
    expect(planExposure(plan)).toBe(2_500);
  });

  it('counts scheduled, processing, failed and defaulted instalments', () => {
    const plan = legacy({
      payments: [
        { amount: 1_000, status: 'scheduled',  kind: 'instalment', instalment_number: 1 },
        { amount:   500, status: 'processing', kind: 'instalment', instalment_number: 2 },
        { amount:   250, status: 'failed',     kind: 'instalment', instalment_number: 3 },
        { amount:   200, status: 'defaulted',  kind: 'instalment', instalment_number: 4 },
      ],
    });
    expect(planExposure(plan)).toBe(1_950);
  });

  it('excludes collected, retried and written_off', () => {
    const plan = legacy({
      payments: [
        { amount: 1_000, status: 'collected',   kind: 'instalment', instalment_number: 1 },
        { amount:   500, status: 'retried',     kind: 'instalment', instalment_number: 2 },
        { amount:   250, status: 'written_off', kind: 'instalment', instalment_number: 3 },
      ],
    });
    expect(planExposure(plan)).toBe(0);
  });

  it('subtracts the excess while instalment 1 is outstanding', () => {
    const plan = legacy({
      excess_amount: 1_000,
      payments: [
        { amount: 3_000, status: 'scheduled', kind: 'instalment', instalment_number: 1 },
        { amount: 2_000, status: 'scheduled', kind: 'instalment', instalment_number: 2 },
      ],
    });
    expect(planExposure(plan)).toBe(4_000);
  });

  it('a defaulted legacy PLAN holds nothing — it never did', () => {
    // The status set for legacy plans is unchanged from 0130. Counting a
    // defaulted legacy plan here would retroactively tighten a limit the
    // patient was already given.
    expect(planExposure(legacy({ status: 'defaulted' }))).toBe(0);
  });

  it('ignores settlement rows, which cover instalments already counted', () => {
    const plan = legacy({
      payments: [
        { amount: 2_500, status: 'scheduled', kind: 'instalment', instalment_number: 1 },
        { amount: 2_500, status: 'scheduled', kind: 'instalment', instalment_number: 2 },
        { amount: 5_000, status: 'scheduled', kind: 'settlement', instalment_number: null },
      ],
    });
    expect(planExposure(plan)).toBe(5_000);
  });
});

// ═══ Aggregation ═══════════════════════════════════════════════════════

describe('committedExposure and availableBalance', () => {
  it('sums across multiple concurrent plans', () => {
    const plans = [
      fullValue({ financed_amount: 3_000 }),
      fullValue({ financed_amount: 2_000 }),
    ];
    expect(committedExposure(plans)).toBe(5_000);
    expect(availableBalance(10_000, plans)).toBe(5_000);
  });

  it('mixes the two models correctly during the transition', () => {
    const plans = [
      fullValue({ financed_amount: 4_000 }),                       // holds 4,000
      legacy({ payments: [
        { amount: 1_500, status: 'scheduled', kind: 'instalment', instalment_number: 2 },
      ] }),                                                        // holds 1,500
    ];
    expect(committedExposure(plans)).toBe(5_500);
  });

  it('floors at zero when a re-assessment lowered the limit below exposure', () => {
    // In-flight plans run to term; the patient just sees no headroom, not a
    // negative number.
    expect(availableBalance(3_000, [fullValue({ financed_amount: 5_000 })])).toBe(0);
  });

  it('shows the full limit when nothing is live', () => {
    expect(availableBalance(10_000, [])).toBe(10_000);
    expect(availableBalance(10_000, [fullValue({ status: 'completed' })])).toBe(10_000);
  });

  it('handles fractional rand amounts without drift', () => {
    const plans = [
      fullValue({ financed_amount: 33.33 }),
      fullValue({ financed_amount: 66.67 }),
    ];
    expect(committedExposure(plans)).toBe(100);
  });
});

describe('balanceSummary always reports the full limit', () => {
  it('reports limit, committed and available together', () => {
    // A first-time patient sees their real limit alongside the
    // one-plan-at-a-time caveat, never a quietly reduced figure.
    const summary = balanceSummary(10_000, [fullValue({ financed_amount: 4_000 })]);
    expect(summary).toEqual({ limit: 10_000, committed: 4_000, available: 6_000 });
  });

  it('keeps reporting the full limit even when fully committed', () => {
    const summary = balanceSummary(10_000, [fullValue({ financed_amount: 10_000 })]);
    expect(summary.limit).toBe(10_000);
    expect(summary.available).toBe(0);
  });
});
