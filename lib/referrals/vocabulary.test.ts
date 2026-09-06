import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import {
  REFERRAL_KINDS,
  REFERRAL_CHANNELS,
  REFERRAL_STATUSES,
  TERMINAL_REFERRAL_STATUSES,
  REFERRAL_STATUS_LABEL,
  REFERRAL_INVITE_TTL_DAYS,
  isTerminalReferralStatus,
  displayReferralStatus,
} from './vocabulary';

// `sql: true` matters: without it the `--` prose survives, and this file's
// absence assertions ("no status names a reward") would be reading the very
// header that DISCUSSES why reward columns are not here.
const MIG = stripComments(readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0145_referrals_foundation.sql'),
  'utf8',
), { sql: true });

/** The members of a `CHECK (col IN ('a','b'))` in the migration. */
function checkMembers(column: string): string[] {
  const re = new RegExp(`CHECK \\(${column} IN \\(([^)]+)\\)\\)`);
  const match = MIG.match(re);
  if (!match) throw new Error(`no CHECK found for ${column} in 0145`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the vocabulary in TypeScript is the vocabulary in the database', () => {
  // The duplication is deliberate and is accepted for the reason 0134 gives
  // about rate-limit buckets: the database refuses a value the application
  // did not declare, which it cannot do by reading the application. These
  // three assertions are what stop the two drifting apart silently — a status
  // added on one side alone becomes a failing test rather than an insert that
  // works in development and is rejected in production.
  it('kinds match', () => {
    expect(new Set(checkMembers('kind'))).toEqual(new Set(REFERRAL_KINDS));
  });

  it('channels match', () => {
    expect(new Set(checkMembers('channel'))).toEqual(new Set(REFERRAL_CHANNELS));
  });

  it('statuses match', () => {
    expect(new Set(checkMembers('status'))).toEqual(new Set(REFERRAL_STATUSES));
  });

  it('the terminal set matches the guard trigger', () => {
    const match = MIG.match(/IF OLD\.status IN \(([^)]+)\)/);
    expect(match, 'the terminal-status guard is no longer where this test looks').toBeTruthy();
    const inSql = [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(inSql)).toEqual(new Set(TERMINAL_REFERRAL_STATUSES));
  });

  it('every status has a customer-facing label', () => {
    for (const s of REFERRAL_STATUSES) {
      expect(REFERRAL_STATUS_LABEL[s], `no label for '${s}'`).toBeTruthy();
    }
    expect(Object.keys(REFERRAL_STATUS_LABEL).sort()).toEqual([...REFERRAL_STATUSES].sort());
  });
});

describe('the incentive programme is genuinely absent', () => {
  it('no status names a reward', () => {
    // The scope was explicit: infrastructure, no programme. A status like
    // 'earned' or 'paid' appearing here would be an incentive policy decided
    // by whoever added the enum rather than by anyone who thought about it.
    for (const s of REFERRAL_STATUSES) {
      expect(s).not.toMatch(/reward|earn|paid|credit|bonus/);
    }
  });

  it('the schema has exactly one reserved column and nothing writes it', () => {
    expect(MIG).toContain('qualified_at');
    expect(MIG).not.toMatch(/reward_(cents|amount|status)/);
    // The only occurrences are the declaration, the index-free comment, and
    // the COMMENT ON COLUMN. No UPDATE or INSERT sets it.
    expect(MIG).not.toMatch(/SET\s+qualified_at/i);
  });
});

describe('isTerminalReferralStatus', () => {
  it('is true for the three terminal states and false for the two live ones', () => {
    expect(isTerminalReferralStatus('converted')).toBe(true);
    expect(isTerminalReferralStatus('expired')).toBe(true);
    expect(isTerminalReferralStatus('void')).toBe(true);
    expect(isTerminalReferralStatus('pending')).toBe(false);
    expect(isTerminalReferralStatus('signed_up')).toBe(false);
  });
});

describe('displayReferralStatus — the screen is right before the sweep runs', () => {
  const NOW = new Date('2026-09-06T10:00:00Z');

  it('shows a lapsed pending invitation as expired', () => {
    expect(displayReferralStatus(
      { status: 'pending', expires_at: '2026-09-01T00:00:00Z' }, NOW,
    )).toBe('expired');
  });

  it('leaves a live one pending', () => {
    expect(displayReferralStatus(
      { status: 'pending', expires_at: '2026-10-01T00:00:00Z' }, NOW,
    )).toBe('pending');
  });

  it('never re-decides a status that is not pending', () => {
    // A converted referral does not stop being converted because a date
    // passed, and a link referral has no expiry at all.
    expect(displayReferralStatus(
      { status: 'converted', expires_at: '2020-01-01T00:00:00Z' }, NOW,
    )).toBe('converted');
    expect(displayReferralStatus({ status: 'signed_up', expires_at: null }, NOW)).toBe('signed_up');
  });

  it('falls back to the stored status on a missing or unparseable date', () => {
    expect(displayReferralStatus({ status: 'pending', expires_at: null }, NOW)).toBe('pending');
    expect(displayReferralStatus({ status: 'pending', expires_at: 'soon' }, NOW)).toBe('pending');
  });

  it('the invitation window is the one the cookie also uses', () => {
    expect(REFERRAL_INVITE_TTL_DAYS).toBe(30);
  });
});
