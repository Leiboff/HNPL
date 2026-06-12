import { describe, it, expect } from 'vitest';
import { computePlanProgress } from './planProgress';

describe('computePlanProgress', () => {
  it('active plan with 1 of 3 paid → 33% bar, 2 remaining payments summed', () => {
    const r = computePlanProgress({
      status: 'active',
      payments: [
        { amount: 1000, status: 'collected' },
        { amount: 1000, status: 'scheduled' },
        { amount: 1232, status: 'scheduled' },
      ],
    });
    expect(r.totalPayments).toBe(3);
    expect(r.paidCount).toBe(1);
    expect(r.remainingAmount).toBe(2232);
    expect(r.percent).toBe(33);
    expect(r.isPaidInFull).toBe(false);
  });

  it('active plan with 0 of 2 paid → 0% bar, full amount remaining', () => {
    const r = computePlanProgress({
      status: 'active',
      payments: [
        { amount: 500, status: 'scheduled' },
        { amount: 500, status: 'scheduled' },
      ],
    });
    expect(r.paidCount).toBe(0);
    expect(r.percent).toBe(0);
    expect(r.remainingAmount).toBe(1000);
  });

  it('completed plan → 100% bar and isPaidInFull=true regardless of payment statuses', () => {
    const r = computePlanProgress({
      status: 'completed',
      payments: [
        { amount: 1000, status: 'collected' },
        { amount: 1000, status: 'collected' },
        { amount: 1000, status: 'collected' },
      ],
    });
    expect(r.isPaidInFull).toBe(true);
    expect(r.percent).toBe(100);
    expect(r.paidCount).toBe(3);
    expect(r.remainingAmount).toBe(0);
  });

  it('completed plan forces percent=100 even if a row is still marked scheduled (defensive)', () => {
    const r = computePlanProgress({
      status: 'completed',
      payments: [
        { amount: 1000, status: 'collected' },
        { amount: 1000, status: 'scheduled' },
      ],
    });
    expect(r.isPaidInFull).toBe(true);
    expect(r.percent).toBe(100);
  });

  it('handles zero payments (e.g. plan in pending_acceptance, no schedule yet)', () => {
    const r = computePlanProgress({ status: 'pending_acceptance', payments: [] });
    expect(r.totalPayments).toBe(0);
    expect(r.percent).toBe(0);
    expect(r.remainingAmount).toBe(0);
    expect(r.isPaidInFull).toBe(false);
  });

  it('accepts Supabase numeric strings for amount and coerces correctly', () => {
    const r = computePlanProgress({
      status: 'active',
      payments: [
        { amount: '1500.00', status: 'collected' },
        { amount: '1500.00', status: 'scheduled' },
      ],
    });
    expect(r.remainingAmount).toBe(1500);
    expect(r.paidCount).toBe(1);
  });

  it('excludes only "collected" from remainingAmount — failed/scheduled/processing all count as remaining', () => {
    const r = computePlanProgress({
      status: 'active',
      payments: [
        { amount: 100, status: 'collected' },
        { amount: 100, status: 'scheduled' },
        { amount: 100, status: 'processing' },
        { amount: 100, status: 'failed' },
      ],
    });
    expect(r.paidCount).toBe(1);
    expect(r.remainingAmount).toBe(300);
  });

  it('rounds percent to nearest integer', () => {
    const r = computePlanProgress({
      status: 'active',
      payments: [
        { amount: 100, status: 'collected' },
        { amount: 100, status: 'scheduled' },
        { amount: 100, status: 'scheduled' },
        { amount: 100, status: 'scheduled' },
        { amount: 100, status: 'scheduled' },
        { amount: 100, status: 'scheduled' },
      ],
    });
    // 1/6 = 16.666… → 17
    expect(r.percent).toBe(17);
  });
});
