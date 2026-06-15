import { describe, it, expect } from 'vitest';
import { classifyCollection } from './CollectionStatusBadge';

// ─── Status → chip mapping ──────────────────────────────────────────────────
//
// The collections page uses these labels everywhere. The mapping has to
// stay aligned with the real payments.status enum from the schema:
//   'scheduled' | 'processing' | 'collected' | 'failed' | 'retried' | 'written_off'

describe('classifyCollection — status → bucket mapping', () => {
  const TODAY = '2026-06-15';

  it('scheduled + due_date in the past → overdue', () => {
    expect(classifyCollection({ status: 'scheduled', due_date: '2026-06-10' }, TODAY)).toBe('overdue');
  });

  it('scheduled + due_date today → upcoming', () => {
    expect(classifyCollection({ status: 'scheduled', due_date: TODAY }, TODAY)).toBe('upcoming');
  });

  it('scheduled + due_date in the future → upcoming', () => {
    expect(classifyCollection({ status: 'scheduled', due_date: '2026-06-25' }, TODAY)).toBe('upcoming');
  });

  it('processing → processing (awaiting webhook reconciliation)', () => {
    expect(classifyCollection({ status: 'processing', due_date: '2026-06-25' }, TODAY)).toBe('processing');
  });

  it('failed → failed', () => {
    expect(classifyCollection({ status: 'failed', due_date: '2026-06-15' }, TODAY)).toBe('failed');
  });

  it("'retried' (in schema enum but unused today) buckets with failed for safety", () => {
    expect(classifyCollection({ status: 'retried', due_date: '2026-06-15' }, TODAY)).toBe('failed');
  });

  it('collected → collected', () => {
    expect(classifyCollection({ status: 'collected', due_date: '2026-06-10' }, TODAY)).toBe('collected');
  });

  it('written_off → written_off', () => {
    expect(classifyCollection({ status: 'written_off', due_date: '2026-06-10' }, TODAY)).toBe('written_off');
  });

  it('unknown status falls through to "failed" so it surfaces for investigation', () => {
    expect(classifyCollection({ status: 'whatever-new-status', due_date: '2026-06-15' }, TODAY)).toBe('failed');
  });
});
