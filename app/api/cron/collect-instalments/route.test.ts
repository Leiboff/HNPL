import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Tests for the cron route ──────────────────────────────────────────────
//
// Focus areas:
//   • CRON_SECRET enforcement (the route can fire real charges; this
//     must be unbypassable).
//   • Two-source pull: scheduled by due_date + failed by next_attempt_date.
//   • Per-row attempt invokes attemptChargeInstalment.
//   • Summary record is inserted into cron_runs.
//   • Outcome counts are accurate.

const attemptChargeInstalmentSpy = vi.fn();

vi.mock('@/lib/payments/chargeInstalment', () => ({
  attemptChargeInstalment: (...args: unknown[]) => attemptChargeInstalmentSpy(...args),
  MAX_ATTEMPTS:            6,
}));

// Stub the service-role Supabase client. Each test sets up scheduledRows
// and failedRows separately so we can assert the cron's two-source pull
// behaves correctly (it issues one SELECT per source via Promise.all).
const inserts: Array<{ table: string; row: unknown }> = [];
const queryState: {
  scheduled: Array<{ id: string }>;
  failed:    Array<{ id: string }>;
} = { scheduled: [], failed: [] };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      return {
        select() {
          let selectedStatus: string | null = null;
          const builder: Record<string, unknown> = {};
          for (const k of ['in', 'lte', 'or', 'not']) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (builder as any)[k] = function () { return builder; };
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (builder as any).eq = function (col: string, val: unknown) {
            if (col === 'status' && typeof val === 'string') selectedStatus = val;
            return builder;
          };
          (builder as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => {
            const data =
              selectedStatus === 'scheduled' ? queryState.scheduled :
              selectedStatus === 'failed'    ? queryState.failed    :
              [];
            resolve({ data, error: null });
          };
          return builder;
        },
        insert(row: unknown) {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  })),
}));

beforeEach(() => {
  attemptChargeInstalmentSpy.mockReset();
  inserts.length = 0;
  queryState.scheduled = [];
  queryState.failed = [];
  process.env.CRON_SECRET = 'test-secret-abc';
  process.env.NEXT_PUBLIC_SUPABASE_URL    = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY    = 'service-role-test';
});

import { POST, GET } from './route';

function makeReq(authHeader?: string): NextRequest {
  const headers = new Headers();
  if (authHeader) headers.set('authorization', authHeader);
  return new NextRequest('http://test/api/cron/collect-instalments', { headers });
}

// ─── Auth ──────────────────────────────────────────────────────────────────

describe('cron route — auth', () => {
  it('rejects request with no Authorization header', async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(attemptChargeInstalmentSpy).not.toHaveBeenCalled();
  });

  it('rejects request with wrong bearer token', async () => {
    const res = await POST(makeReq('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(attemptChargeInstalmentSpy).not.toHaveBeenCalled();
  });

  it('rejects request with no "Bearer" prefix', async () => {
    const res = await POST(makeReq('test-secret-abc'));
    expect(res.status).toBe(401);
    expect(attemptChargeInstalmentSpy).not.toHaveBeenCalled();
  });

  it('500s if CRON_SECRET env var itself is missing', async () => {
    delete process.env.CRON_SECRET;
    const res = await POST(makeReq('Bearer anything'));
    expect(res.status).toBe(500);
    expect(attemptChargeInstalmentSpy).not.toHaveBeenCalled();
  });

  it('accepts a correctly-signed POST', async () => {
    const res = await POST(makeReq('Bearer test-secret-abc'));
    expect(res.status).toBe(200);
  });

  it('accepts a correctly-signed GET (Vercel cron uses GET)', async () => {
    const res = await GET(makeReq('Bearer test-secret-abc'));
    expect(res.status).toBe(200);
  });
});

// ─── Behaviour ─────────────────────────────────────────────────────────────

describe('cron route — behaviour', () => {
  it('attempts both scheduled (due_date) and failed (next_attempt_date) rows', async () => {
    queryState.scheduled = [{ id: 'sched-1' }];
    queryState.failed    = [{ id: 'failed-1' }, { id: 'failed-2' }];
    attemptChargeInstalmentSpy.mockResolvedValue({ kind: 'charged', paymentId: 'p', reference: 'r', attemptNumber: 1, amountChargedCents: 1000 });

    await POST(makeReq('Bearer test-secret-abc'));
    expect(attemptChargeInstalmentSpy).toHaveBeenCalledTimes(3);
    const ids = (attemptChargeInstalmentSpy.mock.calls as unknown[][]).map(c => c[1]);
    expect(ids.sort()).toEqual(['failed-1', 'failed-2', 'sched-1']);
  });

  it('counts outcomes correctly in the response and the cron_runs record', async () => {
    attemptChargeInstalmentSpy
      .mockResolvedValueOnce({ kind: 'charged',         paymentId: 'p1', reference: 'r1', attemptNumber: 1, amountChargedCents: 1000 })
      .mockResolvedValueOnce({ kind: 'claim_lost',      paymentId: 'p2', reason: 'already_claimed' })
      .mockResolvedValueOnce({ kind: 'transport_error', paymentId: 'p3', reference: 'r3', error: '5xx' })
      .mockResolvedValueOnce({ kind: 'charged',         paymentId: 'p4', reference: 'r4', attemptNumber: 2, amountChargedCents: 1000 });

    queryState.scheduled = [{ id: 'p1' }, { id: 'p2' }];
    queryState.failed    = [{ id: 'p3' }, { id: 'p4' }];

    const res = await POST(makeReq('Bearer test-secret-abc'));
    const body = await res.json();

    expect(body.charged_count).toBe(2);
    expect(body.claim_lost_count).toBe(1);
    expect(body.transport_errors).toBe(1);
    expect(body.eligible_count).toBe(4);
    // The write-off sweep is gone — summary should NOT include written_off_count.
    expect(body.written_off_count).toBeUndefined();

    const recorded = inserts.find(i => i.table === 'cron_runs');
    expect(recorded).toBeDefined();
    const row = recorded!.row as { job_name: string; summary: Record<string, unknown> };
    expect(row.job_name).toBe('collect-instalments');
    expect(row.summary.charged_count).toBe(2);
    expect(row.summary.transport_errors).toBe(1);
    expect(Array.isArray(row.summary.transport_error_ids)).toBe(true);
    expect(row.summary.transport_error_ids).toContain('p3');
  });

  it('records a run even when there are zero due payments (proof-of-life for the cron)', async () => {
    await POST(makeReq('Bearer test-secret-abc'));

    const recorded = inserts.find(i => i.table === 'cron_runs');
    expect(recorded).toBeDefined();
    const row = recorded!.row as { summary: { eligible_count: number; charged_count: number } };
    expect(row.summary.eligible_count).toBe(0);
    expect(row.summary.charged_count).toBe(0);
  });
});
