import { describe, it, expect } from 'vitest';
import { computeReliability, formatPercent, type PlanRow, type PaymentRow } from './reliability';

// ─── Reliability calc — pin the formulas ───────────────────────────────────
//
// These tests lock the definitions in cronHealth-style — anyone reading
// the test sees, in one place, exactly what each metric means and why.
//
// "Today" is fixed so the overdue boolean is deterministic.
const TODAY = '2026-06-15';

function plan(total: number, status = 'active'): PlanRow {
  return { total_amount: total, status };
}

function payment(opts: Partial<PaymentRow> & { status: string }): PaymentRow {
  return {
    amount:      opts.amount      ?? 100,
    status:      opts.status,
    due_date:    opts.due_date    ?? '2026-06-01',
    retry_count: opts.retry_count ?? 0,
  };
}

describe('computeReliability — financed total', () => {
  it('sums plan.total_amount across active/completed/defaulted/cancelled', () => {
    const r = computeReliability(
      [plan(1000, 'active'), plan(2000, 'completed'), plan(500, 'defaulted'), plan(300, 'cancelled')],
      [],
      TODAY,
    );
    expect(r.total_financed).toBe(3800);
  });

  it('excludes pending_acceptance and declined plans — they never represented committed credit', () => {
    const r = computeReliability(
      [plan(1000, 'active'), plan(500, 'pending_acceptance'), plan(750, 'declined')],
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

describe('computeReliability — collected / outstanding', () => {
  it('total_collected = sum of collected payments only', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected', amount: 200 }),
        payment({ status: 'collected', amount: 300 }),
        payment({ status: 'scheduled', amount: 100 }),
      ],
      TODAY,
    );
    expect(r.total_collected).toBe(500);
  });

  it('total_outstanding includes scheduled + processing + failed + retried', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'scheduled',  amount: 100 }),
        payment({ status: 'processing', amount: 100 }),
        payment({ status: 'failed',     amount: 100 }),
        payment({ status: 'retried',    amount: 100 }),
      ],
      TODAY,
    );
    expect(r.total_outstanding).toBe(400);
  });

  it('total_outstanding excludes written_off (we ate the loss)', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'scheduled',   amount: 100 }),
        payment({ status: 'written_off', amount: 999 }),
      ],
      TODAY,
    );
    expect(r.total_outstanding).toBe(100);
  });
});

describe('computeReliability — on-time rate', () => {
  it('returns null when there are no attempted payments', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'scheduled' }), payment({ status: 'processing' })],
      TODAY,
    );
    expect(r.on_time_rate).toBeNull();
  });

  it('counts only first-attempt collections in the numerator', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected', retry_count: 0 }),
        payment({ status: 'collected', retry_count: 0 }),
        payment({ status: 'collected', retry_count: 2 }), // collected after retries → not on-time
        payment({ status: 'failed',    retry_count: 1 }),
      ],
      TODAY,
    );
    // 2 on-time / 4 attempted = 50%
    expect(r.on_time_rate).toBe(0.5);
    expect(r.on_time_collected).toBe(2);
    expect(r.attempted_count).toBe(4);
  });

  it('includes written_off in the attempted denominator', () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'collected',   retry_count: 0 }),
        payment({ status: 'written_off', retry_count: 3 }),
      ],
      TODAY,
    );
    // 1 on-time / 2 attempted = 50%
    expect(r.on_time_rate).toBe(0.5);
  });
});

describe('computeReliability — overdue & write-off flags', () => {
  it('has_overdue is true when a scheduled payment is past its due_date', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'scheduled', due_date: '2026-06-01' })],
      TODAY,
    );
    expect(r.has_overdue).toBe(true);
  });

  it('has_overdue is false when scheduled payments are still in the future', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'scheduled', due_date: '2026-07-01' })],
      TODAY,
    );
    expect(r.has_overdue).toBe(false);
  });

  it('has_written_off is true when there is any written_off payment', () => {
    const r = computeReliability(
      [],
      [payment({ status: 'written_off' })],
      TODAY,
    );
    expect(r.has_written_off).toBe(true);
    expect(r.written_off_count).toBe(1);
  });
});

describe('computeReliability — standing ranking', () => {
  it("is 'good-standing' with no overdue and no write-offs", () => {
    const r = computeReliability(
      [plan(1000)],
      [payment({ status: 'collected' })],
      TODAY,
    );
    expect(r.standing).toBe('good-standing');
  });

  it("is 'has-overdue' when overdue but no write-offs", () => {
    const r = computeReliability(
      [],
      [payment({ status: 'scheduled', due_date: '2026-06-01' })],
      TODAY,
    );
    expect(r.standing).toBe('has-overdue');
  });

  it("'has-write-offs' beats 'has-overdue' — write-offs are a confirmed loss", () => {
    const r = computeReliability(
      [],
      [
        payment({ status: 'scheduled',   due_date: '2026-06-01' }),
        payment({ status: 'written_off' }),
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

  it('returns em-dash for null', () => {
    expect(formatPercent(null)).toBe('—');
  });
});
