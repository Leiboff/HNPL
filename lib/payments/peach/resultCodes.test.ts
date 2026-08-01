import { describe, it, expect } from 'vitest';
import {
  SUCCESS_RE, SUCCESS_MANUAL_REVIEW_RE, PENDING_RE, classifyResultCode,
} from './resultCodes';

// ─── OPPWA result-code classifier — regex + boundary pins ───────────

describe('SUCCESS_RE — matches only OPPWA success families', () => {
  it('matches production successes', () => {
    expect(SUCCESS_RE.test('000.000.000')).toBe(true);
    expect(SUCCESS_RE.test('000.100.110')).toBe(true);
    expect(SUCCESS_RE.test('000.100.111')).toBe(true);
    expect(SUCCESS_RE.test('000.100.112')).toBe(true);
    expect(SUCCESS_RE.test('000.300.000')).toBe(true);   // manual review OK
    expect(SUCCESS_RE.test('000.600.000')).toBe(true);   // reviewed + confirmed
  });
  it('does not match pending or rejected codes', () => {
    expect(SUCCESS_RE.test('000.200.000')).toBe(false);
    expect(SUCCESS_RE.test('000.400.101')).toBe(false);
    expect(SUCCESS_RE.test('100.400.500')).toBe(false);
    expect(SUCCESS_RE.test('800.100.100')).toBe(false);
  });
});

describe('SUCCESS_MANUAL_REVIEW_RE — successful, card charged, flagged for review', () => {
  // Peach's SECOND documented "successful" family. Per Peach support,
  // for these codes "the transaction is successful and the customer's
  // card has been charged" — a risk rule just flagged it. This family
  // was the false-decline root cause: it was missing from the classifier.
  it('matches the risk-flagged SUCCESS codes (card was charged)', () => {
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.000')).toBe(true);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.010')).toBe(true);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.020')).toBe(true);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.040')).toBe(true);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.060')).toBe(true);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.090')).toBe(true);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.100')).toBe(true);
  });
  it('EXCLUDES the 000.400.03x subfamily (genuine 3DS failures) and 000.400.10x declines', () => {
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.030')).toBe(false);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.101')).toBe(false);
    expect(SUCCESS_MANUAL_REVIEW_RE.test('000.400.104')).toBe(false);
  });
});

describe('PENDING_RE — matches queued / awaiting acquirer', () => {
  it('matches Peach pending codes (incl. the delayed 800.400.5xx family)', () => {
    expect(PENDING_RE.test('000.200.000')).toBe(true);
    expect(PENDING_RE.test('000.200.100')).toBe(true);
    expect(PENDING_RE.test('100.400.500')).toBe(true);
    expect(PENDING_RE.test('800.400.500')).toBe(true);
    expect(PENDING_RE.test('800.400.501')).toBe(true);
  });
  it('does not match success or rejection', () => {
    expect(PENDING_RE.test('000.100.110')).toBe(false);
    expect(PENDING_RE.test('000.400.101')).toBe(false);
  });
});

describe('classifyResultCode — coarse-grained classifier the callers use', () => {
  it('SUCCESS → "success"', () => {
    expect(classifyResultCode('000.100.110')).toBe('success');
    expect(classifyResultCode('000.000.000')).toBe('success');
    expect(classifyResultCode('000.300.100')).toBe('success');
  });
  it('risk-flagged SUCCESS (card charged) → "success", NOT a decline (false-decline fix)', () => {
    // The exact bug: a cold patient's first card tripped a sandbox risk
    // rule and Peach returned e.g. 000.400.000 — approved + charged — but
    // the classifier treated it as a decline. These MUST be success.
    expect(classifyResultCode('000.400.000')).toBe('success');
    expect(classifyResultCode('000.400.010')).toBe('success');
    expect(classifyResultCode('000.400.020')).toBe('success');
    expect(classifyResultCode('000.400.100')).toBe('success');
  });
  it('PENDING → "pending"', () => {
    expect(classifyResultCode('000.200.100')).toBe('pending');
    expect(classifyResultCode('100.400.500')).toBe('pending');
    expect(classifyResultCode('800.400.500')).toBe('pending');
  });
  it('anything else → "rejected"', () => {
    // 000.400.03x are genuine 3DS failures; 000.400.10x are declines.
    expect(classifyResultCode('000.400.030')).toBe('rejected');
    expect(classifyResultCode('000.400.101')).toBe('rejected');
    expect(classifyResultCode('800.100.152')).toBe('rejected');
    expect(classifyResultCode('900.100.100')).toBe('rejected');
    expect(classifyResultCode('')).toBe('rejected');
    expect(classifyResultCode(null)).toBe('rejected');
    expect(classifyResultCode(undefined)).toBe('rejected');
  });
});
