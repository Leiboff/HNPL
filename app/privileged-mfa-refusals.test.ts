// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Named test 1 — one refusal per privileged operation ───────────────
//
// Each of the seven privileged operations, driven by a real admin session
// that is only aal1 (no fresh second factor), must REFUSE and must not
// reach its write. The guard is exercised for real here — only the network
// boundaries (the Supabase clients, getRequestUser) are mocked. The
// service-role client is a spy that FAILS the test if any privileged write
// is attempted, which is the actual property under test: the guard runs
// before the client choice, so an aal1 caller never gets to the write.
//
// The seven, mapped to the action that performs them:
//   merchant approval      → approvePractice
//   merchant suspension    → suspendPractice
//   fee change             → changePracticeFeePercent
//   payout settlement      → markBatchPaid
//   collection retry       → retryCollection
//   role grant             → grantSalesRole
//   banking change         → updateGroupBanking
// plus customer-PII access → requireAAL2Page (page-level gate)

// Mutable session state the mocks read.
const session = {
  aal:    'aal1' as 'aal1' | 'aal2',
  amr:    [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] as unknown,
  role:   'admin' as string | null,
  userId: 'admin-1' as string | null,
};

// Records any attempt to write through the SERVICE-ROLE client. Must stay
// empty for every case in this file.
const serviceWrites: Array<{ table: string; op: string }> = [];
// Records any attempt to write through the SESSION client (payouts path).
const sessionWrites: Array<{ table: string; op: string }> = [];

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/auth/requestUser', () => ({
  getRequestUser: async () =>
    session.userId
      ? { id: session.userId, email: 'admin@betternow.co.za', email_confirmed_at: '2026-01-01T00:00:00Z', identities: [] }
      : null,
}));

function sessionClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }),
      getClaims: async () => ({
        data: { claims: { sub: session.userId, aal: session.aal, amr: session.amr, iat: Math.floor(Date.now() / 1000) } },
        error: null,
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: session.aal, currentAuthenticationMethods: session.amr, nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: session.role ? { role: session.role } : null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        update: () => { sessionWrites.push({ table, op: 'update' }); return chain; },
        insert: () => { sessionWrites.push({ table, op: 'insert' }); return chain; },
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => sessionClient(),
}));

// Service-role client — every method that could write is a tripwire.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        ilike: () => chain,
        single: async () => { serviceWrites.push({ table, op: 'select' }); return { data: null, error: null }; },
        maybeSingle: async () => { serviceWrites.push({ table, op: 'select' }); return { data: null, error: null }; },
        update: () => { serviceWrites.push({ table, op: 'update' }); return chain; },
        insert: () => { serviceWrites.push({ table, op: 'insert' }); return chain; },
        upsert: () => { serviceWrites.push({ table, op: 'upsert' }); return chain; },
      };
      return chain;
    },
  }),
}));

// The collection retry must never reach the charge helper.
// vi.hoisted so the spy exists when the (hoisted) mock factory runs.
const { chargeSpy } = vi.hoisted(() => ({
  chargeSpy: vi.fn(async () => { throw new Error('charge must not fire at aal1'); }),
}));
vi.mock('@/lib/payments/chargeInstalment', () => ({ attemptChargeInstalment: chargeSpy }));

// Page-gate redirect is thrown by next/navigation; capture the target.
const redirectTarget: { value: string | null } = { value: null };
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { redirectTarget.value = to; throw new Error(`REDIRECT:${to}`); },
}));

import { approvePractice, suspendPractice } from '@/app/admin/practices/actions';
import { changePracticeFeePercent } from '@/app/admin/_lib/auditActions';
import { markBatchPaid } from '@/app/admin/payouts/actions';
import { retryCollection } from '@/app/admin/collections/actions';
import { grantSalesRole } from '@/app/admin/sales-team/actions';
import { updateGroupBanking } from '@/app/admin/groups/actions';
import { requireAAL2Page } from '@/lib/auth/requireAAL2Page';

beforeEach(() => {
  serviceWrites.length = 0;
  sessionWrites.length = 0;
  chargeSpy.mockClear();
  redirectTarget.value = null;
  session.aal = 'aal1';
  session.amr = [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }];
  session.role = 'admin';
  session.userId = 'admin-1';
});

describe('[named 1] every privileged operation refuses an aal1 admin', () => {
  it('merchant approval — approvePractice', async () => {
    const r = await approvePractice('p1');
    expect(r.error).toBeTruthy();
    expect(serviceWrites).toHaveLength(0);
  });

  it('merchant suspension — suspendPractice', async () => {
    const r = await suspendPractice('p1');
    expect(r.error).toBeTruthy();
    expect(serviceWrites).toHaveLength(0);
  });

  it('fee change — changePracticeFeePercent', async () => {
    const r = await changePracticeFeePercent('p1', 7);
    expect(r.ok).toBe(false);
    expect(serviceWrites).toHaveLength(0);
  });

  it('payout settlement — markBatchPaid (user-client path)', async () => {
    const r = await markBatchPaid('b1');
    expect(r.error).toBeTruthy();
    // No settlement write on the session client either.
    expect(sessionWrites.filter((w) => w.op !== 'select')).toHaveLength(0);
  });

  it('collection retry — retryCollection (charge helper never fires)', async () => {
    const r = await retryCollection('pay1');
    expect(r.error).toBeTruthy();
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('role grant — grantSalesRole', async () => {
    session.role = 'admin';
    const r = await grantSalesRole('someone@example.com');
    expect(r.error).toBeTruthy();
    expect(serviceWrites).toHaveLength(0);
  });

  it('banking change — updateGroupBanking', async () => {
    const r = await updateGroupBanking({
      groupId: 'g1', bankName: 'Absa', bankAccountNumber: '1234567890',
      branchCode: '632005', accountHolder: 'X', accountType: 'current',
    });
    expect(r.error).toBeTruthy();
    expect(serviceWrites).toHaveLength(0);
  });

  it('customer-PII access — requireAAL2Page redirects to /security', async () => {
    await expect(requireAAL2Page('standard')).rejects.toThrow(/REDIRECT:/);
    expect(redirectTarget.value).toMatch(/^\/security/);
  });
});

describe('[named 1 control] the SAME operations pass once the session is aal2-fresh', () => {
  beforeEach(() => {
    session.aal = 'aal2';
    session.amr = [
      { method: 'password', timestamp: Math.floor(Date.now() / 1000) - 30 },
      { method: 'mfa/totp', timestamp: Math.floor(Date.now() / 1000) - 30 },
    ];
  });

  it('approvePractice reaches its service-role write when aal2-fresh', async () => {
    const r = await approvePractice('p1');
    expect(r.error).toBeNull();
    expect(serviceWrites.some((w) => w.table === 'practices' && w.op === 'update')).toBe(true);
  });

  it('requireAAL2Page does not redirect when aal2-fresh', async () => {
    await expect(requireAAL2Page('standard')).resolves.toBeUndefined();
    expect(redirectTarget.value).toBeNull();
  });
});
