import { describe, it, expect } from 'vitest';
import {
  checkTradingGate,
  PENDING_APPROVAL_MESSAGE,
  NO_PROVIDERS_MESSAGE,
  type TradingGateSupabase,
} from './tradingGate';

// ─── Stub supabase ───────────────────────────────────────────────────────────
//
// Mirrors the exact chain the helper uses:
//   .from('practices')
//     .select('status').eq('id', practiceId).single()
//   .from('practice_members')
//     .select('user_id').eq('practice_id', X).eq('active', true).eq('role', 'provider').limit(1)
//
// Calls are recorded so we can assert each `.eq` argument and prove the
// query actually filters on role='provider'. Builder shape is loose typed
// to match the structural interface.

type StubOptions = {
  practice?:        { status: string } | null;
  practiceError?:   unknown;
  providers?:       Array<{ user_id: string }>;
  providerError?:   unknown;
};

function makeStub(opts: StubOptions): { client: TradingGateSupabase; recorded: { table: string; eqs: Array<[string, unknown]>; }[] } {
  const recorded: { table: string; eqs: Array<[string, unknown]> }[] = [];

  const client = {
    from(table: string) {
      const call: { table: string; eqs: Array<[string, unknown]> } = { table, eqs: [] };
      recorded.push(call);

      // Recursive return type: eqStep returns either a terminal
      // `single()` branch (the practices row lookup) or another chain
      // step exposing `eq` + `limit`. Explicit annotation avoids the
      // TS7023 implicit-any that fires on self-referential mocks.
      // The recursion lives in the *type* layer (EqStep -> EqStepReturn
      // -> EqStep) so the function below can be annotated cleanly.
      type EqStep = (col: string, val: unknown) => EqStepReturn;
      type EqStepReturn =
        | { single: () => Promise<{ data: unknown; error: unknown }> }
        | { eq: EqStep; limit: (n: number) => Promise<{ data: unknown; error: unknown }> };

      function select(_cols: string) {
        const eqStep: EqStep = (col, val) => {
          call.eqs.push([col, val]);
          if (table === 'practices' && call.eqs.length === 1) {
            return {
              single: () => Promise.resolve({
                data:  opts.practice ?? null,
                error: opts.practiceError ?? null,
              }),
            };
          }
          return {
            eq: eqStep,
            limit: (_n: number) => Promise.resolve({
              data:  opts.providers ?? [],
              error: opts.providerError ?? null,
            }),
          };
        };
        return { eq: eqStep };
      }

      return { select };
    },
  } as unknown as TradingGateSupabase;

  return { client, recorded };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('checkTradingGate', () => {
  it('blocks (pending_approval) when practices.status is "pending"', async () => {
    const { client } = makeStub({
      practice:  { status: 'pending' },
      providers: [{ user_id: 'p1' }],
    });
    const result = await checkTradingGate(client, 'practice-1');
    expect(result).toEqual({
      ok: false,
      reason: 'pending_approval',
      message: PENDING_APPROVAL_MESSAGE,
    });
  });

  it('blocks (pending_approval) when the practice row is missing', async () => {
    const { client } = makeStub({
      practice:  null,
      providers: [{ user_id: 'p1' }],
    });
    const result = await checkTradingGate(client, 'practice-1');
    expect(result).toEqual({
      ok: false,
      reason: 'pending_approval',
      message: PENDING_APPROVAL_MESSAGE,
    });
  });

  it('blocks (pending_approval) when the practice select errors (fail closed)', async () => {
    const { client } = makeStub({
      practiceError: { message: 'rls denied' },
      providers:     [{ user_id: 'p1' }],
    });
    const result = await checkTradingGate(client, 'practice-1');
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('pending_approval');
  });

  it('blocks (no_providers) when practice is approved but no provider rows exist', async () => {
    const { client } = makeStub({
      practice:  { status: 'approved' },
      providers: [],
    });
    const result = await checkTradingGate(client, 'practice-1');
    expect(result).toEqual({
      ok: false,
      reason: 'no_providers',
      message: NO_PROVIDERS_MESSAGE,
    });
  });

  it('blocks (no_providers) when the provider lookup errors', async () => {
    const { client } = makeStub({
      practice:      { status: 'approved' },
      providerError: { message: 'rls denied' },
    });
    const result = await checkTradingGate(client, 'practice-1');
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('no_providers');
  });

  it('passes when status=approved AND >=1 provider', async () => {
    const { client } = makeStub({
      practice:  { status: 'approved' },
      providers: [{ user_id: 'p1' }],
    });
    const result = await checkTradingGate(client, 'practice-1');
    expect(result).toEqual({ ok: true });
  });

  it('passes for a solo practice where the admin self-elected as provider', async () => {
    // The admin's own row now has role='provider' (becomeProvider() flipped
    // it from 'admin'). It's the ONLY row in practice_members for this
    // practice. The gate's eq('role','provider') match is satisfied —
    // solo practitioner can trade once approved.
    const { client } = makeStub({
      practice:  { status: 'approved' },
      providers: [{ user_id: 'admin-self' }],
    });
    const result = await checkTradingGate(client, 'practice-1');
    expect(result).toEqual({ ok: true });
  });

  it('filters the provider query by role="provider" and active=true', async () => {
    const { client, recorded } = makeStub({
      practice:  { status: 'approved' },
      providers: [{ user_id: 'p1' }],
    });
    await checkTradingGate(client, 'practice-1');

    const providerCall = recorded.find(c => c.table === 'practice_members');
    expect(providerCall).toBeDefined();
    expect(providerCall!.eqs).toEqual([
      ['practice_id', 'practice-1'],
      ['active',       true],
      ['role',         'provider'],
    ]);
  });

  it('queries practices.status by id', async () => {
    const { client, recorded } = makeStub({
      practice:  { status: 'approved' },
      providers: [{ user_id: 'p1' }],
    });
    await checkTradingGate(client, 'practice-99');

    const practiceCall = recorded.find(c => c.table === 'practices');
    expect(practiceCall).toBeDefined();
    expect(practiceCall!.eqs).toEqual([['id', 'practice-99']]);
  });
});
