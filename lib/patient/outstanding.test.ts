import { describe, it, expect } from 'vitest';
import { summariseOutstanding, type OutstandingInstalment } from './outstanding';
import { formatRand } from '@/app/patient/_format';

const TODAY = '2026-08-10';

const inst = (over: Partial<OutstandingInstalment> & { amount: number | string; due_date: string }): OutstandingInstalment => ({
  status: 'scheduled',
  dunning_fees_cents: 0,
  next_attempt_date: null,
  ...over,
});

describe('summariseOutstanding', () => {
  it('the reported case: two overdue instalments aggregate to the true total + count', () => {
    // Jane — 2 overdue across 2 plans, R1,616.00 + R822.66 = R2,438.66.
    const r = summariseOutstanding(
      [
        inst({ amount: 1616.0, due_date: '2026-07-01' }),
        inst({ amount: 822.66, due_date: '2026-07-15' }),
      ],
      TODAY,
    );
    expect(r.overdueCount).toBe(2);
    expect(r.overdueCents).toBe(243866);
    // All outstanding is overdue here → the two totals coincide, and the
    // rand string matches the Plans header ("R2,438.66") to the cent.
    expect(r.outstandingCents).toBe(243866);
    expect(formatRand(r.overdueCents / 100)).toBe('R2,438.66');
  });

  it('a single overdue instalment → overdueCount 1 (hero keeps singular framing)', () => {
    const r = summariseOutstanding([inst({ amount: 1616.0, due_date: '2026-07-01' })], TODAY);
    expect(r.overdueCount).toBe(1);
    expect(r.overdueCents).toBe(161600);
  });

  it('mixed: overdue subset is separate from the full outstanding total', () => {
    const r = summariseOutstanding(
      [
        inst({ amount: 1616.0, due_date: '2026-07-01' }), // overdue
        inst({ amount: 500.0,  due_date: '2026-09-01' }), // upcoming
      ],
      TODAY,
    );
    expect(r.outstandingCents).toBe(211600);
    expect(r.outstandingCount).toBe(2);
    expect(r.overdueCents).toBe(161600);
    expect(r.overdueCount).toBe(1);
  });

  it('includes dunning fees in both totals', () => {
    const r = summariseOutstanding(
      [inst({ amount: 100.0, dunning_fees_cents: 5000, due_date: '2026-07-01' })],
      TODAY,
    );
    expect(r.overdueCents).toBe(15000); // R100 + R50 fee
  });

  it('failed / defaulted count as overdue regardless of due/retry date', () => {
    const r = summariseOutstanding(
      [
        inst({ amount: 200.0, status: 'failed',    due_date: '2099-01-01', next_attempt_date: '2099-02-01' }),
        inst({ amount: 300.0, status: 'defaulted', due_date: '2099-01-01' }),
      ],
      TODAY,
    );
    expect(r.overdueCount).toBe(2);
    expect(r.overdueCents).toBe(50000);
  });

  it('processing is outstanding but not overdue', () => {
    const r = summariseOutstanding(
      [inst({ amount: 400.0, status: 'processing', due_date: '2026-07-01' })],
      TODAY,
    );
    expect(r.outstandingCents).toBe(40000);
    expect(r.overdueCount).toBe(0);
  });

  it('settled rows (collected / written_off) are excluded', () => {
    const r = summariseOutstanding(
      [
        inst({ amount: 999.0, status: 'collected',   due_date: '2026-07-01' }),
        inst({ amount: 999.0, status: 'written_off', due_date: '2026-07-01' }),
      ],
      TODAY,
    );
    expect(r.outstandingCents).toBe(0);
    expect(r.overdueCents).toBe(0);
  });

  it('adversarial: 3+ overdue all aggregate (no truncation to one)', () => {
    const r = summariseOutstanding(
      [
        inst({ amount: 100.0, due_date: '2026-07-01' }),
        inst({ amount: 200.0, due_date: '2026-07-02' }),
        inst({ amount: 300.0, due_date: '2026-07-03' }),
      ],
      TODAY,
    );
    expect(r.overdueCount).toBe(3);
    expect(r.overdueCents).toBe(60000);
  });
});
