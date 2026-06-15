import { describe, it, expect } from 'vitest';
import {
  computeReliability,
  formatPercent,
  type PlanRow,
  type PaymentRow,
} from './reliability';

// ─── Reliability calc — pin the formulas ───────────────────────────────────
//
// These tests are the canonical spec for what each metric means.
// Anyone reading the test should see the WHY behind each number
// (especially the salary-date carve-out, which is non-obvious).
//
// "Today" is fixed so the overdue / due-by-today branches are
// deterministic.
const TODAY = '2026-06-15';

function plan(total: number, status = 'active'): PlanRow {
  return { total_amount: total, status };
}

function payment(opts: Partial<PaymentRow> & { status: string; instalment_number: number }): PaymentRow {
  return {
    amount:            opts.amount      ?? 100,
    status:            opts.status,
    due_date:          opts.due_date    ?? '2026-06-01',
    retry_count:       opts.retry_count ?? 0,
    instalment_number: opts.instalment_number,
  };
}

describe('computeReliability — total_financed (committed credit only)', () => {
  it('sums active + pending_first_payment + completed + defaulted', () => {
    const r = computeReliability(
      [
        plan(1000, 'active'),
        plan(2000, 'pending_first_payment'),
        plan(3000, 'completed'),
        plan(500,  'defaulted'),
      ],
      [],
      TODAY,
    );
    expect(r.total_financed).toBe(6500);
  });

  it('excludes pending_acceptance, declined, AND cancelled — non-starts never represented committed credit', () => {
    const r = computeReliability(
      [
        plan(1000, 'active'),
        plan(999,  'pending_acceptance'),
        plan(999,  'declined'),
        plan(999,  'cancelled'),
      ],
      [],
      TODAY,
    );
    expect(r.total_financed).toBe(1000);
  });

  it('handles numeric string amounts (Postgres NUMERIC arrives as string)', () => {
    const r = computeReliability(
      [{ total_amount: '1234.50', status: 'active' }],
      [],
      TODAY,
    );
    expect(r.total_financed).toBe(1234.5);
  });
});

describe('computeReliability — total_collected (all-or-nothing assumption)', () => {
  it('sums payments.amount where status=collected, regardless of instalment number', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected', amount: 500, instalment_number: 1 }),  // first-payment
        payment({ status: 'collected', amount: 500, instalment_number: 2 }),
        payment({ status: 'scheduled', amount: 500, instalment_number: 3 }),
      ],
      TODAY,
    );
    // collected sums both #1 and #2 — money is money even if #1
    // doesn't contribute to reliability_rate.
    expect(r.total_collected).toBe(1000);
  });
});

describe('computeReliability — outstanding split (on-track vs at-risk)', () => {
  it('outstanding_on_track sums scheduled + processing', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'scheduled',  amount: 100, instalment_number: 2 }),
        payment({ status: 'processing', amount: 200, instalment_number: 3 }),
      ],
      TODAY,
    );
    expect(r.outstanding_on_track).toBe(300);
    expect(r.outstanding_at_risk).toBe(0);
  });

  it('outstanding_at_risk sums failed + retried', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'failed',  amount: 100, instalment_number: 2 }),
        payment({ status: 'retried', amount: 200, instalment_number: 3 }),
      ],
      TODAY,
    );
    expect(r.outstanding_on_track).toBe(0);
    expect(r.outstanding_at_risk).toBe(300);
  });

  it('total_outstanding = on_track + at_risk', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'scheduled', amount: 100, instalment_number: 2 }),
        payment({ status: 'failed',    amount: 200, instalment_number: 3 }),
      ],
      TODAY,
    );
    expect(r.total_outstanding).toBe(300);
    expect(r.outstanding_on_track).toBe(100);
    expect(r.outstanding_at_risk).toBe(200);
  });

  it('written_off is NOT outstanding — loss eaten', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'scheduled',   amount: 100, instalment_number: 2 }),
        payment({ status: 'written_off', amount: 999, instalment_number: 3 }),
      ],
      TODAY,
    );
    expect(r.total_outstanding).toBe(100);
  });
});

describe('computeReliability — reliability_rate (salary-date, first-attempt)', () => {
  it('EXCLUDES instalment 1 from both numerator and denominator', () => {
    // Instalment 1 is charged at acceptance against a verified card —
    // it is on-time by construction and adds zero signal. A patient
    // with ONLY instalment 1 paid (no #2 due yet) is N/A, not 100%.
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected', instalment_number: 1, retry_count: 0 }),
        payment({ status: 'scheduled', instalment_number: 2, due_date: '2026-07-01' }), // not yet due
      ],
      TODAY,
    );
    expect(r.reliability_rate).toBeNull();
    expect(r.salary_date_due_count).toBe(0);
    expect(r.salary_date_on_time_count).toBe(0);
  });

  it("counts ONLY first-attempt salary-date hits in the numerator", () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected', instalment_number: 2, retry_count: 0, due_date: '2026-06-01' }),
        payment({ status: 'collected', instalment_number: 3, retry_count: 0, due_date: '2026-06-01' }),
        // Collected after retries — not first-attempt:
        payment({ status: 'collected', instalment_number: 4, retry_count: 2, due_date: '2026-06-01' }),
        payment({ status: 'failed',    instalment_number: 5, retry_count: 1, due_date: '2026-06-01' }),
      ],
      TODAY,
    );
    // 2 on-time / 4 attempted = 50%
    expect(r.reliability_rate).toBe(0.5);
    expect(r.salary_date_on_time_count).toBe(2);
    expect(r.salary_date_due_count).toBe(4);
  });

  it('returns null when no salary-date installments have come due yet', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected', instalment_number: 1, retry_count: 0 }),
        payment({ status: 'scheduled', instalment_number: 2, due_date: '2026-12-01' }), // future
        payment({ status: 'scheduled', instalment_number: 3, due_date: '2027-01-01' }), // future
      ],
      TODAY,
    );
    expect(r.reliability_rate).toBeNull();
  });

  it('returns null even after instalment 1 is collected — do NOT show fake 100% to brand-new patients', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'collected', instalment_number: 1 })],
      TODAY,
    );
    expect(r.reliability_rate).toBeNull();
  });

  it('does NOT count future-due salary-date installments in the denominator', () => {
    const r = computeReliability(
      [],
      [
        // due, attempted, first-try success → numerator + denominator
        payment({ status: 'collected', instalment_number: 2, retry_count: 0, due_date: '2026-06-01' }),
        // not yet due → not counted at all
        payment({ status: 'scheduled', instalment_number: 3, due_date: '2026-07-01' }),
      ],
      TODAY,
    );
    expect(r.salary_date_due_count).toBe(1);
    expect(r.salary_date_on_time_count).toBe(1);
    expect(r.reliability_rate).toBe(1);
  });

  it("does NOT count 'processing' rows in the denominator — in-flight, not yet a hit-or-miss", () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected',  instalment_number: 2, retry_count: 0, due_date: '2026-06-01' }),
        payment({ status: 'processing', instalment_number: 3,                  due_date: '2026-06-10' }),
      ],
      TODAY,
    );
    expect(r.salary_date_due_count).toBe(1);
    expect(r.reliability_rate).toBe(1);
  });

  it('counts written_off in the denominator (it was attempted and failed terminally)', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected',   instalment_number: 2, retry_count: 0, due_date: '2026-06-01' }),
        payment({ status: 'written_off', instalment_number: 3, retry_count: 3, due_date: '2026-06-01' }),
      ],
      TODAY,
    );
    expect(r.salary_date_due_count).toBe(2);
    expect(r.salary_date_on_time_count).toBe(1);
    expect(r.reliability_rate).toBe(0.5);
  });
});

describe('computeReliability — salary-date risk counts', () => {
  it('counts failed/retried (instalment > 1) for the visible risk signal', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'failed',  instalment_number: 2 }),
        payment({ status: 'retried', instalment_number: 3 }),
        // instalment 1 failed/retried noise is irrelevant — exclude
        payment({ status: 'failed',  instalment_number: 1 }),
      ],
      TODAY,
    );
    expect(r.salary_date_failed_count).toBe(2);
  });

  it('counts written_off (instalment > 1) separately', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'written_off', instalment_number: 3 }),
        payment({ status: 'written_off', instalment_number: 4 }),
        payment({ status: 'written_off', instalment_number: 1 }), // ignored
      ],
      TODAY,
    );
    expect(r.salary_date_written_off_count).toBe(2);
  });
});

describe('computeReliability — overdue & write-off flags', () => {
  it('has_overdue is true when a scheduled payment is past its due_date', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'scheduled', due_date: '2026-06-01', instalment_number: 2 })],
      TODAY,
    );
    expect(r.has_overdue).toBe(true);
  });

  it('has_overdue is false when scheduled payments are still in the future', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'scheduled', due_date: '2026-07-01', instalment_number: 2 })],
      TODAY,
    );
    expect(r.has_overdue).toBe(false);
  });

  it('has_written_off is true when there is any written_off payment', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'written_off', instalment_number: 2 })],
      TODAY,
    );
    expect(r.has_written_off).toBe(true);
  });
});

describe('computeReliability — standing', () => {
  it("'good-standing' when no overdue, no at-risk, no write-offs", () => {
    const r = computeReliability(
      [plan(1000)],
      [payment({ status: 'collected', instalment_number: 2 })],
      TODAY,
    );
    expect(r.standing).toBe('good-standing');
  });

  it("'has-overdue' when there is a scheduled-past-due payment", () => {
    const r = computeReliability(
      [],
      [payment({ status: 'scheduled', due_date: '2026-06-01', instalment_number: 2 })],
      TODAY,
    );
    expect(r.standing).toBe('has-overdue');
  });

  it("'has-overdue' when there is at-risk (failed/retried) outstanding — even without overdue scheduled", () => {
    // Previously this patient would be tagged 'good-standing' which
    // was misleading. With at_risk > 0 they're in unresolved trouble.
    const r = computeReliability(
      [],
      [payment({ status: 'failed', amount: 100, instalment_number: 2, due_date: '2026-06-10' })],
      TODAY,
    );
    expect(r.outstanding_at_risk).toBe(100);
    expect(r.has_overdue).toBe(false);
    expect(r.standing).toBe('has-overdue');
  });

  it("'has-write-offs' beats has-overdue — write-offs are a confirmed loss", () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'scheduled',   due_date: '2026-06-01', instalment_number: 2 }),
        payment({ status: 'written_off',                          instalment_number: 3 }),
      ],
      TODAY,
    );
    expect(r.standing).toBe('has-write-offs');
  });
});

describe('formatPercent', () => {
  it('formats a rate to a whole-percent string', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });

  it("returns N/A for null — '0% on-time' would be a different (wrong) message", () => {
    expect(formatPercent(null)).toBe('N/A');
  });
});
