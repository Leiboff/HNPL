import { describe, it, expect } from 'vitest';
import {
  isRapidRepeatPayAttempt,
  RECENT_PAY_WINDOW_MS,
  type RecentPayment,
} from './idempotency';

// ─── Checkout idempotency window — pin the rule ────────────────────────────
//
// initiateCheckout uses this to throttle the rapid-retry case (slow
// Paystack roundtrip → user refreshes → re-submits within seconds).
// 5s is short enough to never get in the way of legitimate retries
// (a Paystack decline + 3DS abort takes longer to come back), and
// long enough to catch the panic-refresh pattern.

const NOW = 1_750_000_000_000;
const REF = 'hnpl_co_aaaaaaaaaaaaaaaaaaaa';

function row(opts: { msAgo: number; ref?: string | null }): RecentPayment {
  return {
    created_at:       new Date(NOW - opts.msAgo).toISOString(),
    peach_payment_id: opts.ref === undefined ? REF : opts.ref,
  };
}

describe('isRapidRepeatPayAttempt — null / missing', () => {
  it('returns false when there is no existing row', () => {
    expect(isRapidRepeatPayAttempt(null, NOW)).toBe(false);
  });

  it("returns false when the row exists but peach_payment_id is NULL — the previous attempt errored out before stamping a reference, so the retry is legitimate", () => {
    expect(isRapidRepeatPayAttempt(row({ msAgo: 1_000, ref: null }), NOW)).toBe(false);
  });
});

describe('isRapidRepeatPayAttempt — window', () => {
  it('flags a stamped row created 500ms ago', () => {
    expect(isRapidRepeatPayAttempt(row({ msAgo: 500 }), NOW)).toBe(true);
  });

  it('flags a stamped row created right at the boundary (just under 5s)', () => {
    expect(isRapidRepeatPayAttempt(row({ msAgo: 4_999 }), NOW)).toBe(true);
  });

  it('does NOT flag a row exactly at the window edge (5s old) — retry allowed', () => {
    expect(isRapidRepeatPayAttempt(row({ msAgo: 5_000 }), NOW)).toBe(false);
  });

  it('does NOT flag a row from 30s ago (legitimate retry after a decline)', () => {
    expect(isRapidRepeatPayAttempt(row({ msAgo: 30_000 }), NOW)).toBe(false);
  });
});

describe('isRapidRepeatPayAttempt — defensive', () => {
  it('does NOT flag a row with a future created_at (clock skew defense)', () => {
    expect(isRapidRepeatPayAttempt(row({ msAgo: -5_000 }), NOW)).toBe(false);
  });

  it('returns false for a malformed created_at', () => {
    expect(isRapidRepeatPayAttempt(
      { created_at: 'not-a-date', peach_payment_id: REF },
      NOW,
    )).toBe(false);
  });

  it('honors a caller-supplied window override', () => {
    expect(isRapidRepeatPayAttempt(row({ msAgo: 10_000 }), NOW, 30_000)).toBe(true);
  });
});

describe('window constant', () => {
  it('is 5 seconds — short on purpose, so legitimate retries are never blocked', () => {
    expect(RECENT_PAY_WINDOW_MS).toBe(5_000);
  });
});
