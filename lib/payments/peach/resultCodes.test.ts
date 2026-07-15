import { describe, it, expect } from 'vitest';
import {
  SUCCESS_RE, PENDING_RE, classifyResultCode,
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

describe('PENDING_RE — matches queued / awaiting acquirer', () => {
  it('matches Peach pending codes', () => {
    expect(PENDING_RE.test('000.200.000')).toBe(true);
    expect(PENDING_RE.test('000.200.100')).toBe(true);
    expect(PENDING_RE.test('100.400.500')).toBe(true);
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
  it('PENDING → "pending"', () => {
    expect(classifyResultCode('000.200.100')).toBe('pending');
    expect(classifyResultCode('100.400.500')).toBe('pending');
  });
  it('anything else → "rejected"', () => {
    expect(classifyResultCode('000.400.101')).toBe('rejected');
    expect(classifyResultCode('800.100.152')).toBe('rejected');
    expect(classifyResultCode('900.100.100')).toBe('rejected');
    expect(classifyResultCode('')).toBe('rejected');
    expect(classifyResultCode(null)).toBe('rejected');
    expect(classifyResultCode(undefined)).toBe('rejected');
  });
});
