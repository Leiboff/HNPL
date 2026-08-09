import { describe, it, expect } from 'vitest';
import { stubAffordabilityPolicy } from './stubAffordabilityPolicy';

// The stub is the single source of the test limit. These lock its
// contract; swapping the module for real underwriting is what changes it.
describe('stubAffordabilityPolicy (STUB)', () => {
  it('approves a fixed R5,000 test limit', () => {
    expect(stubAffordabilityPolicy()).toEqual({ approved: true, limitCents: 500_000 });
  });

  it('limitCents is expressed in cents → R5,000.00', () => {
    expect(stubAffordabilityPolicy().limitCents / 100).toBe(5000);
  });

  it('takes no inputs (nothing is assessed)', () => {
    expect(stubAffordabilityPolicy).toHaveLength(0);
  });
});
