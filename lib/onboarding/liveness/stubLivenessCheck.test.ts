import { describe, it, expect } from 'vitest';
import { stubLivenessCheck } from './stubLivenessCheck';

// Single source of the liveness verdict. runLiveness gates on this, so
// returning 'fail' here (or swapping in a real provider) changes the flow
// with no other edit.
describe('stubLivenessCheck (STUB)', () => {
  it('always passes', () => {
    expect(stubLivenessCheck()).toBe('pass');
  });

  it('takes no inputs (nothing is verified)', () => {
    expect(stubLivenessCheck).toHaveLength(0);
  });
});
