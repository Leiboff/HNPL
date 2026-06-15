import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Tests for the cron route ──────────────────────────────────────────────
//
// Focus areas:
//   • CRON_SECRET enforcement (the route can fire real charges; this
//     must be unbypassable).
//   • Write-off sweep runs BEFORE the due-payments query.
//   • Per-row attempt invokes attemptChargeInstalment.
//   • Summary record is inserted into cron_runs.
//   • Outcome counts are accurate.

const attemptChargeInstalmentSpy = vi.fn();
const writeOffExceededAttemptsSpy = vi.fn();

vi.mock('@/lib/payments/chargeInstalment', () => ({
  attemptChargeInstalment:    (...args: unknown[]) => attemptChargeInstalmentSpy(...args),
  writeOffExceededAttempts:   (...args: unknown[]) => writeOffExceededAttemptsSpy(...args),
  MAX_ATTEMPTS:               4,
}));

// Stub the service-role Supabase client. The route only uses .from()
// with select / update / insert chains. We capture the inserts so we
// can assert the cron_runs writeback.
const inserts: Array<{ table: string; row: unknown }> = [];
const dueRowsByCall: { current: Array<{ id: string }> } = { current: [] };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      return {
        select() {
          const builder: Record<string, unknown> = {};
          // chain methods we use in the route
          for (const k of ['in', 'lte', 'eq', 'not']) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (builder as any)[k] = function () { return builder; };
          }
          (builder as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) =>
            resolve({ data: dueRowsByCall.current, error: null });
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
  writeOffExceededAttemptsSpy.mockReset();
  writeOffExceededAttemptsSpy.mockResolvedValue([]);
  inserts.length = 0;
  dueRowsByCall.current = [];
  process.env.CRON_SECRET = 'test-secret-abc';
  process.env.NEXT_PUBLIC_SUPABASE_URL    = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY    = 'service-role-test';
});

// Import after the mocks are registered.
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
    dueRowsByCall.current = [];
    const res = await POST(makeReq('Bearer test-secret-abc'));
    expect(res.status).toBe(200);
  });

  it('accepts a correctly-signed GET (Vercel cron uses GET)', async () => {
    dueRowsByCall.current = [];
    const res = await GET(makeReq('Bearer test-secret-abc'));
    expect(res.status).toBe(200);
  });
});

// ─── Behaviour ─────────────────────────────────────────────────────────────

describe('cron route — behaviour', () => {
  it('runs the write-off sweep BEFORE iterating the due queue', async () => {
    const order: string[] = [];
    writeOffExceededAttemptsSpy.mockImplementation(async () => { order.push('writeOff'); return ['wo-1']; });
    attemptChargeInstalmentSpy.mockImplementation(async () => { order.push('attempt'); return { kind: 'charged', paymentId: 'p', reference: 'r', attemptNumber: 1 }; });

    dueRowsByCall.current = [{ id: 'p1' }, { id: 'p2' }];
    await POST(makeReq('Bearer test-secret-abc'));

    expect(order[0]).toBe('writeOff');
    expect(order.slice(1)).toEqual(['attempt', 'attempt']);
  });

  it('calls attemptChargeInstalment once per due row', async () => {
    attemptChargeInstalmentSpy.mockResolvedValue({ kind: 'charged', paymentId: 'p', reference: 'r', attemptNumber: 1 });
    dueRowsByCall.current = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

    await POST(makeReq('Bearer test-secret-abc'));
    expect(attemptChargeInstalmentSpy).toHaveBeenCalledTimes(3);
    expect(attemptChargeInstalmentSpy.mock.calls.map(c => (c as unknown[])[1])).toEqual(['p1', 'p2', 'p3']);
  });

  it('counts outcomes correctly in the response and the cron_runs record', async () => {
    attemptChargeInstalmentSpy
      .mockResolvedValueOnce({ kind: 'charged',         paymentId: 'p1', reference: 'r1', attemptNumber: 1 })
      .mockResolvedValueOnce({ kind: 'claim_lost',      paymentId: 'p2', reason: 'already_claimed' })
      .mockResolvedValueOnce({ kind: 'transport_error', paymentId: 'p3', reference: 'r3', error: '5xx' })
      .mockResolvedValueOnce({ kind: 'charged',         paymentId: 'p4', reference: 'r4', attemptNumber: 2 });

    writeOffExceededAttemptsSpy.mockResolvedValue(['wo-1', 'wo-2']);

    dueRowsByCall.current = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];

    const res = await POST(makeReq('Bearer test-secret-abc'));
    const body = await res.json();

    expect(body.charged_count).toBe(2);
    expect(body.claim_lost_count).toBe(1);
    expect(body.transport_errors).toBe(1);
    expect(body.written_off_count).toBe(2);
    expect(body.eligible_count).toBe(4);

    // cron_runs writeback uses the same summary.
    const recorded = inserts.find(i => i.table === 'cron_runs');
    expect(recorded).toBeDefined();
    const row = recorded!.row as { job_name: string; summary: Record<string, unknown> };
    expect(row.job_name).toBe('collect-instalments');
    expect(row.summary.charged_count).toBe(2);
    expect(row.summary.transport_errors).toBe(1);
    expect(row.summary.written_off_count).toBe(2);
    expect(Array.isArray(row.summary.transport_error_ids)).toBe(true);
    expect(row.summary.transport_error_ids).toContain('p3');
  });

  it('records a run even when there are zero due payments (proof-of-life for the cron)', async () => {
    dueRowsByCall.current = [];
    writeOffExceededAttemptsSpy.mockResolvedValue([]);
    await POST(makeReq('Bearer test-secret-abc'));

    const recorded = inserts.find(i => i.table === 'cron_runs');
    expect(recorded).toBeDefined();
    const row = recorded!.row as { summary: { eligible_count: number; charged_count: number } };
    expect(row.summary.eligible_count).toBe(0);
    expect(row.summary.charged_count).toBe(0);
  });
});
