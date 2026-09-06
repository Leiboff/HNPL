import { describe, it, expect } from 'vitest';
import { claimReferral, withinAttributionWindow, type ReferralClaimStore } from './claim';

// ─── A store built from plain objects ────────────────────────────────────
//
// The alternative was mocking a PostgREST fluent builder, which tests the
// mock. This is why claimReferral takes an interface: the decisions — who is
// refused, what is terminal, which row wins a race — are the whole point, and
// they are all visible here without a database.

const ALICE = 'alice-uuid';
const BOB   = 'bob-uuid';
const CODE  = 'A2C4K9PT';
const NOW   = new Date('2026-09-06T12:00:00Z');

type Recorded = { attached?: string; created?: unknown };

function store(overrides: Partial<ReferralClaimStore> = {}, log: Recorded = {}): ReferralClaimStore {
  return {
    async findLiveCode(code) {
      return code === CODE ? { id: 'code-uuid', owner_id: ALICE } : null;
    },
    async findAccount() {
      return { email: 'bob@example.com', created_at: '2026-09-06T11:00:00Z' };
    },
    async findAttribution() { return null; },
    async findPendingInviteFor() { return null; },
    async attachToInvite(id) { log.attached = id; return true; },
    async createLinkReferral(input) { log.created = input; return { id: 'new-referral' }; },
    ...overrides,
  };
}

describe('the happy path', () => {
  it('records a link referral for a fresh account carrying a valid code', async () => {
    const log: Recorded = {};
    const result = await claimReferral(store({}, log), {
      profileId: BOB, cookieValue: CODE, now: NOW,
    });
    expect(result).toEqual({ outcome: 'attributed', terminal: true, referralId: 'new-referral' });
    expect(log.created).toEqual({
      referrerId: ALICE, codeId: 'code-uuid', profileId: BOB, at: NOW.toISOString(),
    });
  });

  it('accepts a cookie value that needs normalising', async () => {
    const result = await claimReferral(store(), {
      profileId: BOB, cookieValue: ' a2c4-k9pt ', now: NOW,
    });
    expect(result.outcome).toBe('attributed');
  });

  it('prefers the invitation that was created FOR this address', async () => {
    // The friend Alice actually invited must land on Alice's invitation row,
    // not on a second anonymous one — otherwise the invitation stays 'pending'
    // for ever and the same person is counted twice.
    const log: Recorded = {};
    const result = await claimReferral(store({
      async findPendingInviteFor(referrerId, email) {
        expect(referrerId).toBe(ALICE);
        expect(email).toBe('bob@example.com');
        return { id: 'invite-uuid' };
      },
    }, log), { profileId: BOB, cookieValue: CODE, now: NOW });

    expect(result).toEqual({ outcome: 'attributed', terminal: true, referralId: 'invite-uuid' });
    expect(log.attached).toBe('invite-uuid');
    expect(log.created).toBeUndefined();
  });

  it('falls back to a new row when the invitation was taken between read and write', async () => {
    const log: Recorded = {};
    const result = await claimReferral(store({
      async findPendingInviteFor() { return { id: 'invite-uuid' }; },
      async attachToInvite() { return false; },   // matched zero rows: we lost
    }, log), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result.outcome).toBe('attributed');
    expect(result.referralId).toBe('new-referral');
  });

  it('does not look for an invitation when the account has no address', async () => {
    const result = await claimReferral(store({
      async findAccount() { return { email: null, created_at: NOW.toISOString() }; },
      async findPendingInviteFor() { throw new Error('must not be called'); },
    }), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result.outcome).toBe('attributed');
  });
});

describe('the five refusals — all terminal, all spend the cookie', () => {
  it('malformed: the cookie is not code-shaped', async () => {
    const result = await claimReferral(store({
      async findLiveCode() { throw new Error('must not reach the database'); },
    }), { profileId: BOB, cookieValue: 'not-a-code', now: NOW });
    expect(result).toEqual({ outcome: 'malformed', terminal: true });
  });

  it('unknown_code: no live code matches (a typo, or one revoked since)', async () => {
    const result = await claimReferral(store({
      async findLiveCode() { return null; },
    }), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result).toEqual({ outcome: 'unknown_code', terminal: true });
  });

  it('self_referral: the code belongs to the account presenting it', async () => {
    const result = await claimReferral(store(), {
      profileId: ALICE, cookieValue: CODE, now: NOW,
    });
    expect(result).toEqual({ outcome: 'self_referral', terminal: true });
  });

  it('already_attributed: the first code an account arrives with is the one that counts', async () => {
    const log: Recorded = {};
    const result = await claimReferral(store({
      async findAttribution() { return { id: 'earlier-referral' }; },
    }, log), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result).toEqual({ outcome: 'already_attributed', terminal: true });
    expect(log.created).toBeUndefined();
  });

  it('account_too_old: an existing customer clicking a link is not a new customer', async () => {
    const result = await claimReferral(store({
      async findAccount() {
        return { email: 'bob@example.com', created_at: '2026-01-01T00:00:00Z' };
      },
    }), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result).toEqual({ outcome: 'account_too_old', terminal: true });
  });

  it('and the self-referral check runs before anything is written', async () => {
    const log: Recorded = {};
    await claimReferral(store({}, log), { profileId: ALICE, cookieValue: CODE, now: NOW });
    expect(log.created).toBeUndefined();
    expect(log.attached).toBeUndefined();
  });
});

describe('races and outages are NOT terminal', () => {
  it('a database failure leaves the cookie for the next request', async () => {
    // The distinction that matters: "this code does not exist" is terminal,
    // "we could not ask" is not. Conflating them throws away a real referral
    // over a blip, which is unrecoverable — the cookie is the only copy.
    const result = await claimReferral(store({
      async findLiveCode() { throw new Error('connection reset'); },
    }), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result).toEqual({ outcome: 'transient', terminal: false });
  });

  it('a missing profile row is retried, not refused', async () => {
    // The signup trigger has not run yet. A fraction of a second later it has.
    const result = await claimReferral(store({
      async findAccount() { return null; },
    }), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result).toEqual({ outcome: 'transient', terminal: false });
  });

  it('losing the write-once race reports what the read would have', async () => {
    // The unique index refused the insert because a concurrent request got
    // there first. That is the index doing its job, not an error, and the
    // honest report is the same one findAttribution would have given.
    const result = await claimReferral(store({
      async createLinkReferral() { return null; },
    }), { profileId: BOB, cookieValue: CODE, now: NOW });
    expect(result).toEqual({ outcome: 'already_attributed', terminal: true });
  });
});

describe('withinAttributionWindow', () => {
  it('accepts an account created inside the thirty-day window', () => {
    expect(withinAttributionWindow('2026-08-20T00:00:00Z', NOW)).toBe(true);
  });

  it('refuses one created outside it', () => {
    expect(withinAttributionWindow('2026-07-01T00:00:00Z', NOW)).toBe(false);
  });

  it('admits a null or unparseable timestamp rather than silently refusing', () => {
    // An over-count is visible in the row; a referrer losing their credit to a
    // type-level shrug is not. Neither is free — this one can be seen.
    expect(withinAttributionWindow(null, NOW)).toBe(true);
    expect(withinAttributionWindow('not a date', NOW)).toBe(true);
  });
});
