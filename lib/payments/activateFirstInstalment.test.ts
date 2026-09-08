import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { activateFirstInstalment } from './activateFirstInstalment';

type RpcResult = { data: unknown; error: { message: string } | null };

function service(result: RpcResult) {
  const rpc = vi.fn(async () => result);
  const updateResult = { error: null };
  const chain: Record<string, unknown> = {};
  chain.eq = vi.fn(() => chain);
  chain.is = vi.fn(() => updateResult);
  chain.neq = vi.fn(() => updateResult);
  return {
    rpc,
    from: vi.fn(() => ({ update: vi.fn(() => chain) })),
  };
}

const input = {
  paymentId: '11111111-1111-1111-1111-111111111111',
  plan: {
    id: '22222222-2222-2222-2222-222222222222',
    total_amount: 1000,
    practice_id: '33333333-3333-3333-3333-333333333333',
  },
  now: '2026-09-07T12:00:00.000Z',
};

describe('activateFirstInstalment', () => {
  it('delegates every financial effect to the transactional RPC', async () => {
    const svc = service({ data: { ok: true }, error: null });
    await expect(activateFirstInstalment(svc, input)).resolves.toEqual({ ok: true });
    expect(svc.rpc).toHaveBeenCalledWith('activate_first_instalment', {
      p_payment_id: input.paymentId,
      p_plan_id: input.plan.id,
      p_collected_at: input.now,
    });
  });

  it('does not close checkout tokens when the transaction fails', async () => {
    const svc = service({ data: null, error: { message: 'transaction rolled back' } });
    await expect(activateFirstInstalment(svc, input)).resolves.toEqual({
      ok: false, step: 'payment', error: 'transaction rolled back',
    });
    expect(svc.from).not.toHaveBeenCalled();
  });

  it('surfaces a coded refusal from the transaction', async () => {
    const svc = service({ data: { ok: false, error: 'fee_unavailable' }, error: null });
    await expect(activateFirstInstalment(svc, input)).resolves.toEqual({
      ok: false, step: 'payout', error: 'fee_unavailable',
    });
  });
});

describe('activate_first_instalment migration contract', () => {
  const sql = readFileSync('supabase/migrations/0153_payout_fee_snapshot.sql', 'utf8');

  it('locks the plan and payment and writes collection, activation and payout in one function', () => {
    expect(sql).toMatch(/FROM plans WHERE id = p_plan_id FOR UPDATE/);
    expect(sql).toMatch(/instalment_number = 1\s+FOR UPDATE/);
    expect(sql).toMatch(/UPDATE payments\s+SET status = 'collected'/);
    expect(sql).toMatch(/UPDATE plans SET status = 'active'/);
    expect(sql).toMatch(/INSERT INTO payouts/);
  });

  it('is idempotent and service-role only', () => {
    expect(sql).toMatch(/ON CONFLICT \(plan_id\) DO NOTHING/);
    expect(sql).toMatch(/v_plan\.status NOT IN \('pending_first_payment', 'active'\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION activate_first_instalment[\s\S]*FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION activate_first_instalment[\s\S]*TO service_role/);
  });

  it('fails closed on an unavailable or invalid fee and snapshots the exact rate', () => {
    expect(sql).toMatch(/SELECT fee_percent INTO STRICT v_fee/);
    expect(sql).toMatch(/NO_DATA_FOUND OR TOO_MANY_ROWS/);
    expect(sql).toMatch(/v_fee IS NULL[\s\S]*'NaN', 'Infinity', '-Infinity'[\s\S]*v_fee < 0[\s\S]*v_fee > 100/);
    expect(sql).toMatch(/gross_amount, fee_percent_snapshot,[\s\S]*v_plan\.total_amount, v_fee, v_fee_amount/);
  });

  it('lets duplicate success webhooks re-enter the RPC to repair an orphan payout', () => {
    const route = readFileSync('app/api/payments/peach/webhook/route.ts', 'utf8');
    expect(route).toMatch(/plan\.status !== 'pending_first_payment' && plan\.status !== 'active'/);
    expect(route).not.toMatch(/if \(plan\.status === 'active'\) \{[\s\S]{0,180}return;/);
  });
});
