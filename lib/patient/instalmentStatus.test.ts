import { describe, it, expect } from 'vitest';
import {
  deriveInstalmentStatus,
  isInstalmentOverdue,
  instalmentStatusLabel,
  instalmentStatusTone,
} from './instalmentStatus';

// ─── Tests — single source of truth for instalment status ───────────────
//
// The contract every patient surface leans on:
//   overdue = still owed AND due date is in the past.
// A stored `scheduled` row is NOT trusted to mean "upcoming" — if its due
// date has passed it is overdue. Failed/defaulted are always overdue.

const TODAY = '2026-08-06';

describe('deriveInstalmentStatus', () => {
  it('past-due unpaid (scheduled) → overdue — the core bug', () => {
    expect(deriveInstalmentStatus({ status: 'scheduled', due_date: '2026-07-17' }, TODAY)).toBe('overdue');
  });

  it('future unpaid (scheduled) → upcoming', () => {
    expect(deriveInstalmentStatus({ status: 'scheduled', due_date: '2026-09-01' }, TODAY)).toBe('upcoming');
  });

  it('due today (scheduled) → due_today', () => {
    expect(deriveInstalmentStatus({ status: 'scheduled', due_date: TODAY }, TODAY)).toBe('due_today');
  });

  it('collected → paid (whatever the dates)', () => {
    expect(deriveInstalmentStatus({ status: 'collected', due_date: '2026-07-17' }, TODAY)).toBe('paid');
  });

  it('failed → overdue even with a future retry date', () => {
    expect(deriveInstalmentStatus({ status: 'failed', due_date: '2026-08-01', next_attempt_date: '2026-08-20' }, TODAY)).toBe('overdue');
  });

  it('defaulted → overdue', () => {
    expect(deriveInstalmentStatus({ status: 'defaulted', due_date: '2026-06-01' }, TODAY)).toBe('overdue');
  });

  it('processing → processing (mid-charge, not judged late)', () => {
    expect(deriveInstalmentStatus({ status: 'processing', due_date: '2026-07-17' }, TODAY)).toBe('processing');
  });

  it('written_off → written_off (no longer owed)', () => {
    expect(deriveInstalmentStatus({ status: 'written_off', due_date: '2026-06-01' }, TODAY)).toBe('written_off');
  });

  it('retried (owed, past due) → overdue', () => {
    expect(deriveInstalmentStatus({ status: 'retried', due_date: '2026-07-01' }, TODAY)).toBe('overdue');
  });

  it('is date-only / timezone-safe (ignores time components)', () => {
    expect(deriveInstalmentStatus({ status: 'scheduled', due_date: '2026-08-06T23:30:00Z' }, TODAY)).toBe('due_today');
  });
});

describe('isInstalmentOverdue', () => {
  it('mirrors the overdue verdict', () => {
    expect(isInstalmentOverdue({ status: 'scheduled', due_date: '2026-07-17' }, TODAY)).toBe(true);
    expect(isInstalmentOverdue({ status: 'scheduled', due_date: '2026-09-01' }, TODAY)).toBe(false);
    expect(isInstalmentOverdue({ status: 'collected', due_date: '2026-07-17' }, TODAY)).toBe(false);
  });
});

describe('presentation is single-sourced', () => {
  it('labels the derived states', () => {
    expect(instalmentStatusLabel('overdue')).toBe('Overdue');
    expect(instalmentStatusLabel('upcoming')).toBe('Upcoming');
    expect(instalmentStatusLabel('paid')).toBe('Paid');
  });

  it('flags overdue as the danger tone', () => {
    expect(instalmentStatusTone('overdue')).toBe('danger');
    expect(instalmentStatusTone('paid')).toBe('positive');
    expect(instalmentStatusTone('upcoming')).toBe('neutral');
  });
});
