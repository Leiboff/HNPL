import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Releasing a block ────────────────────────────────────────────────────
//
// Migration 0138's test proves the DATABASE cannot be talked into a bad
// release. This proves the action in front of it does not hand the database
// a good-looking one: the admin guard, the mandatory reason, and the audit
// row that has to exist even when the write afterwards fails.
//
// The reason field is the part that looks like paperwork and is not. The
// thresholds in lib/security/identitySignals.ts are judgements about human
// behaviour, not numbers fitted to data — there is no data yet — so some
// will be wrong, and the record of WHY each release happened is the only
// evidence that will ever say which ones. "Cleared the queue" and "called
// her, she is a nurse who pays for four family members" have to be
// distinguishable six months from now.

const audits: Array<Record<string, unknown>> = [];
vi.mock('@/app/admin/_lib/adminAudit', () => ({
  recordAdminAction: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry); }),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const ADMIN    = '0000ad00-0000-0000-0000-00000000ad00';
const DECISION = '0000f000-0000-0000-0000-00000000f000';
const SUBJECT  = '0000aaaa-0000-0000-0000-00000000aaaa';

let role: string | null = 'admin';
let userId: string | null = ADMIN;
let decisionRow: Record<string, unknown> | null = null;
let updateError: { message: string } | null = null;
const updates: Array<Record<string, unknown>> = [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from(table: string) {
      const chain = {
        select: () => chain,
        eq:     () => chain,
        is:     () => (table === 'fraud_decisions' && updates.length
          ? { error: updateError }
          : chain),
        single:      async () => ({ data: { role } }),
        maybeSingle: async () => ({ data: decisionRow }),
        update: (row: Record<string, unknown>) => { updates.push(row); return chain; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      return chain;
    },
  }),
}));

import { releaseFraudDecision } from './actions';

beforeEach(() => {
  audits.length = 0;
  updates.length = 0;
  role = 'admin';
  userId = ADMIN;
  updateError = null;
  decisionRow = {
    id: DECISION, user_id: SUBJECT, decision: 'block',
    rule: 'device_shared_by_6_accounts', released_at: null,
  };
});

describe('releaseFraudDecision — who may call it', () => {
  it('refuses an unauthenticated caller', async () => {
    userId = null;
    expect((await releaseFraudDecision(DECISION, 'a good enough reason')).error)
      .toBe('Not authenticated.');
    expect(updates).toHaveLength(0);
  });

  it('refuses a non-admin', async () => {
    role = 'patient';
    expect((await releaseFraudDecision(DECISION, 'a good enough reason')).error)
      .toBe('Unauthorized.');
    expect(updates).toHaveLength(0);
  });

  it('refuses a practice admin — the nearest thing to a plausible caller', async () => {
    role = 'practice_admin';
    expect((await releaseFraudDecision(DECISION, 'a good enough reason')).error)
      .toBe('Unauthorized.');
  });
});

describe('releaseFraudDecision — the reason is mandatory', () => {
  it.each(['', '   ', 'ok', 'family'])('refuses %o', async (note) => {
    const res = await releaseFraudDecision(DECISION, note);
    expect(res.error).toMatch(/say why/i);
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('accepts a real one and stores it trimmed', async () => {
    const res = await releaseFraudDecision(DECISION, '  called her — pays for 4 family members  ');
    expect(res.error).toBeNull();
    expect(updates[0].release_note).toBe('called her — pays for 4 family members');
  });
});

describe('releaseFraudDecision — what it writes', () => {
  it('stamps the acting admin as released_by, never anyone else', async () => {
    // The trigger enforces this too. Both, deliberately: a release is
    // somebody's decision to let a suspected fraudster through, and the two
    // checks fail in different ways — the trigger cannot be forgotten, this
    // one cannot be bypassed by a connection with no auth.uid().
    await releaseFraudDecision(DECISION, 'a good enough reason');
    expect(updates[0].released_by).toBe(ADMIN);
    expect(updates[0].released_at).toEqual(expect.any(String));
  });

  it('changes nothing but the three release columns', async () => {
    await releaseFraudDecision(DECISION, 'a good enough reason');
    expect(Object.keys(updates[0]).sort())
      .toEqual(['release_note', 'released_at', 'released_by']);
  });

  it('refuses a decision that is already released', async () => {
    decisionRow = { ...decisionRow!, released_at: '2026-01-01T00:00:00Z' };
    expect((await releaseFraudDecision(DECISION, 'a good enough reason')).error)
      .toMatch(/already been released/i);
    expect(updates).toHaveLength(0);
  });

  it('refuses a decision that does not exist', async () => {
    decisionRow = null;
    expect((await releaseFraudDecision(DECISION, 'a good enough reason')).error)
      .toBe('Decision not found.');
  });
});

describe('releaseFraudDecision — the audit row', () => {
  it('is written against the CUSTOMER, so it lands on their timeline', async () => {
    await releaseFraudDecision(DECISION, 'a good enough reason');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: ADMIN, entityType: 'customer', entityId: SUBJECT,
      action: 'release_fraud_decision',
    });
  });

  it('carries the rule that was overridden, not just the id', async () => {
    await releaseFraudDecision(DECISION, 'a good enough reason');
    expect((audits[0].payload as { rule: string }).rule).toBe('device_shared_by_6_accounts');
  });

  it('is written BEFORE the update, so a failed write still leaves the intent', async () => {
    // The 0131 discipline. An intent with no matching outcome is exactly the
    // shape an investigator needs to see; a log written only on success is
    // missing precisely the half-finished cases.
    updateError = { message: 'deadlock detected' };
    const res = await releaseFraudDecision(DECISION, 'a good enough reason');
    expect(res.error).toBe('deadlock detected');
    expect(audits).toHaveLength(1);
  });
});
