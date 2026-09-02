import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Tests for the RLS drift cron ──────────────────────────────────────────
//
// Two things have to hold, and the second is the one that actually matters.
//
//   1. CRON_SECRET is unbypassable, on the same terms as the three routes
//      that move money. This one cannot spend a cent, but it reads the full
//      map of where every defence in the schema is — which is exactly the
//      reconnaissance an attacker would want, and it runs on the
//      service-role client.
//
//   2. Drift is REPORTED. A monitoring job that returns 200 with a cheerful
//      body while the thing it monitors is broken is worse than no job,
//      because it retires the question — so the drift case asserts ok:false,
//      an ALERT log line, and a cron_runs row recording it, not merely that
//      the request did not throw.
//
// The comparison logic itself is proved separately and exhaustively in
// lib/security/driftDetection.test.ts. These tests are about the wiring:
// auth, the two failure paths, and what reaches cron_runs.

const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: async () => rpcResult,
    from(table: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return { error: null };
        },
      };
    },
  })),
}));

/** The replayed schema the route compares against — stubbed so these tests
 *  do not depend on the real migration corpus, which changes every time
 *  somebody adds a policy. */
const replayed = {
  policies: new Map([
    ['plans patients_select_own_plans', {
      table: 'plans', name: 'patients_select_own_plans', command: 'SELECT', migration: '0002.sql',
    }],
  ]),
  triggers: new Map([
    ['payouts trg_protect_payouts_write', {
      table: 'payouts', name: 'trg_protect_payouts_write',
      timing: 'BEFORE', events: new Set(['INSERT']), migration: '0135.sql',
    }],
  ]),
};

let replayThrows: Error | null = null;

vi.mock('@/lib/security/schemaInvariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/schemaInvariants')>();
  return {
    ...actual,
    assertFullyParsed: () => { if (replayThrows) throw replayThrows; },
    replaySchema:      () => replayed,
  };
});

const AUTH = { Authorization: 'Bearer test-secret' };

function req(headers: Record<string, string> = AUTH): NextRequest {
  return new NextRequest('https://example.test/api/cron/rls-drift', { headers });
}

/** The snapshot shape rls_catalog_snapshot() returns (migration 0137). */
const matchingSnapshot = {
  policies: [{ table: 'plans', name: 'patients_select_own_plans', cmd: 'SELECT' }],
  triggers: [{ table: 'payouts', name: 'trg_protect_payouts_write', timing: 'BEFORE', events: ['INSERT'] }],
};

beforeEach(() => {
  inserts.length = 0;
  rpcResult = { data: matchingSnapshot, error: null };
  replayThrows = null;
  process.env.CRON_SECRET = 'test-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  vi.restoreAllMocks();
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('cron/rls-drift — authentication', () => {
  it('401s with no Authorization header', async () => {
    const { GET } = await import('./route');
    const res = await GET(req({}));
    expect(res.status).toBe(401);
  });

  it('401s on a wrong secret of the same length', async () => {
    // Same length so the comparison reaches timingSafeEqual rather than
    // short-circuiting on the length pre-check.
    const { GET } = await import('./route');
    const res = await GET(req({ Authorization: 'Bearer tset-secret' }));
    expect(res.status).toBe(401);
  });

  it('401s on a shorter secret without throwing', async () => {
    // timingSafeEqual throws on a length mismatch; the pre-check is what
    // turns that into a clean 401.
    const { GET } = await import('./route');
    const res = await GET(req({ Authorization: 'Bearer short' }));
    expect(res.status).toBe(401);
  });

  it('500s and refuses to run when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Cron secret not configured.' });
    expect(inserts).toHaveLength(0);
  });

  it('POST is accepted too, for a manual operator run', async () => {
    const { POST } = await import('./route');
    const res = await POST(req());
    expect(res.status).toBe(200);
  });
});

describe('cron/rls-drift — agreement', () => {
  it('reports ok and records the run', async () => {
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.migrations).toEqual({ policies: 1, triggers: 1 });
    expect(body.database).toEqual({ policies: 1, triggers: 1 });

    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('cron_runs');
    expect(inserts[0].row.job_name).toBe('rls-drift');
    expect((inserts[0].row.summary as { ok: boolean }).ok).toBe(true);
  });
});

describe('cron/rls-drift — drift is actually reported', () => {
  it('returns ok:false, names the drift, ALERTs and records it', async () => {
    // A policy in the database that no migration creates — R3-08 exactly.
    rpcResult = {
      data: {
        policies: [
          ...matchingSnapshot.policies,
          { table: 'payments', name: 'provider_select_own_payments', cmd: 'SELECT' },
        ],
        triggers: matchingSnapshot.triggers,
      },
      error: null,
    };
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const res = await GET(req());

    // 200, not 5xx: the answer will not change on a retry, and Vercel
    // retries 5xx. ok:false is the signal.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.policies_only_in_database).toEqual(['payments provider_select_own_payments']);

    expect(alert.mock.calls.flat().join(' ')).toContain('ALERT');
    expect((inserts[0].row.summary as { ok: boolean }).ok).toBe(false);
  });

  it('catches a guard trigger missing from the database', async () => {
    rpcResult = { data: { policies: matchingSnapshot.policies, triggers: [] }, error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const body = await (await GET(req())).json();
    expect(body.ok).toBe(false);
    expect(body.triggers_only_in_migrations).toEqual(['payouts trg_protect_payouts_write']);
  });
});

describe('cron/rls-drift — cannot-check is a failure, not a pass', () => {
  it('500s when the snapshot RPC errors', async () => {
    rpcResult = { data: null, error: { message: 'permission denied' } };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('snapshot_failed');
    expect(inserts).toHaveLength(0);
  });

  it('500s when the snapshot has an unexpected shape', async () => {
    rpcResult = { data: { nonsense: true }, error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('snapshot_shape');
  });

  it('500s when the migrations cannot be read — the outputFileTracing failure', async () => {
    // If supabase/migrations/*.sql is missing from the lambda, readdirSync
    // throws. This must be a loud 500, not a silent "no drift".
    replayThrows = new Error('ENOENT: no such file or directory');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('could_not_replay_migrations');
    expect(inserts).toHaveLength(0);
  });
});
