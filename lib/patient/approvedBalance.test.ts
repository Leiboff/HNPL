import { describe, it, expect } from 'vitest';
import {
  availableBalance,
  outstandingPrincipal,
  type PaymentForBalance,
} from './approvedBalance';

// ─── Tests — approved-balance widget math ──────────────────────────────
//
// Widget contract:
//   available = max(0, limit - Σ outstanding_on_active_plans)
//
// Rules pinned:
//   • Outstanding counts `scheduled | processing | failed | defaulted`.
//   • A `defaulted` row IS still owed → it counts (it must NOT free the
//     limit; that was the old bug). Collected/retried/written_off do NOT
//     count (paid or forgiven).
//   • Floored at 0 — a patient who has overshot never sees a
//     negative "available".
//   • No hard-coded numbers, no fake placeholders — the render-nothing
//     case is the CALLER's responsibility (widget only renders when
//     limit is non-null); this file is pure math.

describe('outstandingPrincipal', () => {
  it('sums scheduled + processing + failed amounts', () => {
    const payments: PaymentForBalance[] = [
      { amount: 1000, status: 'scheduled' },
      { amount:  500, status: 'processing' },
      { amount:  250, status: 'failed' },
    ];
    expect(outstandingPrincipal(payments)).toBe(1750);
  });

  it('excludes collected / retried / written_off', () => {
    const payments: PaymentForBalance[] = [
      { amount: 1000, status: 'collected'  },  // paid — not outstanding
      { amount:  500, status: 'retried'    },  // legacy status, drop
      { amount:  250, status: 'written_off'},  // forgiven — no debt
    ];
    expect(outstandingPrincipal(payments)).toBe(0);
  });

  it('COUNTS defaulted (still owed — must not free the limit)', () => {
    const payments: PaymentForBalance[] = [
      { amount: 100, status: 'defaulted' },
    ];
    expect(outstandingPrincipal(payments)).toBe(100);
  });

  it('mixes both classes correctly (only outstanding contributes)', () => {
    const payments: PaymentForBalance[] = [
      { amount: 1000, status: 'scheduled' },   // counts
      { amount:  600, status: 'collected' },   // dropped
      { amount:  400, status: 'failed'    },   // counts
      { amount:  200, status: 'defaulted' },   // counts (still owed)
    ];
    expect(outstandingPrincipal(payments)).toBe(1600);
  });

  it('empty payments → 0', () => {
    expect(outstandingPrincipal([])).toBe(0);
  });

  it('handles fractional rand amounts (rounded to cents)', () => {
    const payments: PaymentForBalance[] = [
      { amount: 33.33, status: 'scheduled' },
      { amount: 66.67, status: 'scheduled' },
    ];
    // 33.33 + 66.67 = 100.00, and Number-coercion drift is fixed by
    // the internal round-to-cents.
    expect(outstandingPrincipal(payments)).toBe(100);
  });
});

describe('availableBalance', () => {
  it('limit minus outstanding when outstanding < limit', () => {
    const payments: PaymentForBalance[] = [
      { amount: 3000, status: 'scheduled' },
    ];
    expect(availableBalance(10_000, payments)).toBe(7000);
  });

  it('floors at 0 when outstanding exceeds the limit', () => {
    const payments: PaymentForBalance[] = [
      { amount: 12_000, status: 'scheduled' },
    ];
    expect(availableBalance(10_000, payments)).toBe(0);
  });

  it('shows the FULL limit when the patient has no active outstanding', () => {
    // All payments collected — outstanding = 0 → available = limit.
    const payments: PaymentForBalance[] = [
      { amount: 500, status: 'collected' },
      { amount: 500, status: 'collected' },
    ];
    expect(availableBalance(10_000, payments)).toBe(10_000);
  });

  it('DOES count defaulted as outstanding (a default must not free the limit)', () => {
    // A defaulted debt is still owed — it keeps consuming the limit (and
    // the patient is frozen out of new plans entirely; see freeze.ts).
    // Excluding it used to perversely FREE the limit on default.
    const payments: PaymentForBalance[] = [
      { amount: 5000, status: 'defaulted' },
    ];
    expect(availableBalance(10_000, payments)).toBe(5000);
  });
});
