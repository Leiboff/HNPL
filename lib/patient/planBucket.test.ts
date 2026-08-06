import { describe, it, expect } from 'vitest';
import { planBucket, isDeclinedPlan } from './planBucket';

// ─── Tests — plan lifecycle bucketing ───────────────────────────────────
//
// The contract the Plans list + plan-detail lean on: declined is its own
// bucket, never "finished" and never "active". A finished plan (completed/
// cancelled/defaulted) existed and was (or should have been) charged; a
// declined bill never became a plan.

describe('planBucket', () => {
  it('groups the pending states', () => {
    expect(planBucket('pending_acceptance')).toBe('pending');
    expect(planBucket('pending_first_payment')).toBe('pending');
  });

  it('active → active', () => {
    expect(planBucket('active')).toBe('active');
  });

  it('declined is its OWN bucket — not finished', () => {
    expect(planBucket('declined')).toBe('declined');
    expect(planBucket('declined')).not.toBe('finished');
  });

  it('completed / cancelled / defaulted → finished', () => {
    expect(planBucket('completed')).toBe('finished');
    expect(planBucket('cancelled')).toBe('finished');
    expect(planBucket('defaulted')).toBe('finished');
  });
});

describe('isDeclinedPlan', () => {
  it('only declined is declined', () => {
    expect(isDeclinedPlan('declined')).toBe(true);
    expect(isDeclinedPlan('completed')).toBe(false);
    expect(isDeclinedPlan('active')).toBe(false);
    expect(isDeclinedPlan('cancelled')).toBe(false);
  });
});
