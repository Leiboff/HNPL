import { describe, it, expect } from 'vitest';
import { checkLiveness } from './livenessCheck';

// ─── checkLiveness — gates purely on the reported session status ───────
//
// Mirrors the invariant the old stub's tests enforced (runLiveness gates
// on this module and nothing else): a completed session is 'pass',
// anything else — cancelled, camera error, locked out — is 'fail'.
// Never silently pass on an unclear input.

describe('checkLiveness', () => {
  it('a completed session is "pass"', () => {
    expect(checkLiveness({ sessionCompleted: true })).toBe('pass');
  });

  it('an incomplete/cancelled/errored session is "fail"', () => {
    expect(checkLiveness({ sessionCompleted: false })).toBe('fail');
  });
});
