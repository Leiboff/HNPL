import { describe, it, expect } from 'vitest';
import {
  isDuplicateBill,
  RECENT_BILL_WINDOW_MS,
  type CandidatePlan,
} from './idempotency';

// ─── Bill-creation idempotency window — pin the rule ──────────────────────
//
// The goal: catch the hang-then-resubmit double-create, NOT block
// a legitimate "bill the same patient the same amount twice" (repeat
// procedure, correction). Window is short on purpose.

const NOW = 1_750_000_000_000; // a fixed UTC ms — any value, deterministic

function plan(created_at: string, total_amount: number | string): CandidatePlan {
  return { created_at, total_amount };
}

function isoMsAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('isDuplicateBill — window', () => {
  it('returns false when the candidate list is empty', () => {
    expect(isDuplicateBill([], 1000, NOW)).toBe(false);
  });

  it('flags a same-amount plan created 1s ago as a duplicate', () => {
    const candidates = [plan(isoMsAgo(1_000), 1000)];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(true);
  });

  it('flags a same-amount plan created right at the boundary (just under 8s)', () => {
    const candidates = [plan(isoMsAgo(7_999), 1000)];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(true);
  });

  it('does NOT flag a plan created exactly at the window edge (8s old)', () => {
    // Strict less-than: 8000ms is the cliff.
    const candidates = [plan(isoMsAgo(8_000), 1000)];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(false);
  });

  it('does NOT flag a plan created 60s ago (legitimate "two bills for the same patient")', () => {
    const candidates = [plan(isoMsAgo(60_000), 1000)];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(false);
  });
});

describe('isDuplicateBill — amount match', () => {
  it('does NOT flag a recent plan at a different amount', () => {
    const candidates = [plan(isoMsAgo(1_000), 500)];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(false);
  });

  it('cast-safely treats NUMERIC string from PostgREST as equal', () => {
    const candidates = [plan(isoMsAgo(1_000), '1000.00')];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(true);
  });

  it('flags only the amount-matching row in a mixed list', () => {
    const candidates = [
      plan(isoMsAgo(1_000), 500),    // recent but wrong amount
      plan(isoMsAgo(60_000), 1000),  // right amount but outside window
      plan(isoMsAgo(2_000), 1000),   // hit
    ];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(true);
  });
});

describe('isDuplicateBill — defensive', () => {
  it('returns false for a malformed created_at (rather than throwing)', () => {
    const candidates = [plan('not-a-date', 1000)];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(false);
  });

  it('does NOT flag a plan with a future created_at (clock skew defense)', () => {
    // age < 0 — defensive ignore so we never block on future-dated rows
    const candidates = [plan(new Date(NOW + 5_000).toISOString(), 1000)];
    expect(isDuplicateBill(candidates, 1000, NOW)).toBe(false);
  });

  it('honors a caller-supplied window override (useful for tests)', () => {
    const candidates = [plan(isoMsAgo(10_000), 1000)];
    expect(isDuplicateBill(candidates, 1000, NOW, 5_000)).toBe(false);
    expect(isDuplicateBill(candidates, 1000, NOW, 20_000)).toBe(true);
  });
});

describe('window constant', () => {
  it('is 8 seconds — matches our outbound-fetch timeout', () => {
    expect(RECENT_BILL_WINDOW_MS).toBe(8_000);
  });
});
