import { describe, it, expect } from 'vitest';
import {
  checkTradingGate,
  NO_BANKING_MESSAGE,
} from './tradingGate';

// ─── Tests — trading gate condition (c): branch banking resolution ─────
//
// The condition only fires for branches (practices.group_id != NULL).
// Standalone practices keep the existing two-condition gate verbatim
// (regression-tested in tradingGate.test.ts).
//
// What this file pins:
//   • Branch with no own banking AND no group banking → 'no_banking'.
//   • Branch with no own banking but a banked group → ok (group fallback).
//   • Branch with its own banking → ok (own wins).
//   • Standalone with no banking → ok if approved+provider — the
//     banking condition does NOT apply to standalone, that's the
//     prime directive.

type Row = Record<string, unknown> | null;
type State = {
  practices:       Row[];
  practice_groups: Row[];
  practice_members: Row[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStub(state: State): any {
  return {
    from(table: keyof State) {
      const rows = state[table];
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const builder = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
        single: async () => {
          const found = rows.find((r): r is Record<string, unknown> => r !== null && filters.every((f) => f(r)));
          return { data: found ?? null, error: null };
        },
        maybeSingle: async () => {
          const found = rows.find((r): r is Record<string, unknown> => r !== null && filters.every((f) => f(r)));
          return { data: found ?? null, error: null };
        },
        limit: async (_n: number) => {
          const matching = rows.filter((r): r is Record<string, unknown> => r !== null && filters.every((f) => f(r)));
          return { data: matching, error: null };
        },
      };
      return builder;
    },
  };
}

const FULL_BANK = {
  bank_name:           'FNB',
  bank_account_number: '12345678',
  branch_code:         '250655',
  account_holder:      'X',
  account_type:        'current',
};
const NO_BANK = {
  bank_name:           null,
  bank_account_number: null,
  branch_code:         null,
  account_holder:      null,
  account_type:        null,
};
const APPROVED_PROVIDER = { user_id: 'u1', practice_id: 'b1', active: true, role: 'provider' };

describe('Trading gate — branch banking condition (group_id NOT NULL)', () => {
  it('branch with own banking → ok', async () => {
    const stub = makeStub({
      practices:        [{ id: 'b1', status: 'approved', group_id: 'g1', ...FULL_BANK }],
      practice_groups:  [{ id: 'g1', ...NO_BANK }],
      practice_members: [APPROVED_PROVIDER],
    });
    const r = await checkTradingGate(stub, 'b1');
    expect(r).toEqual({ ok: true });
  });

  it('branch with NO own banking + group with banking → ok (fallback)', async () => {
    const stub = makeStub({
      practices:        [{ id: 'b1', status: 'approved', group_id: 'g1', ...NO_BANK }],
      practice_groups:  [{ id: 'g1', ...FULL_BANK }],
      practice_members: [APPROVED_PROVIDER],
    });
    const r = await checkTradingGate(stub, 'b1');
    expect(r).toEqual({ ok: true });
  });

  it('branch with NO own banking + group with NO banking → no_banking', async () => {
    const stub = makeStub({
      practices:        [{ id: 'b1', status: 'approved', group_id: 'g1', ...NO_BANK }],
      practice_groups:  [{ id: 'g1', ...NO_BANK }],
      practice_members: [APPROVED_PROVIDER],
    });
    const r = await checkTradingGate(stub, 'b1');
    expect(r).toEqual({
      ok: false,
      reason: 'no_banking',
      message: NO_BANKING_MESSAGE,
    });
  });
});

describe('Trading gate — standalone (group_id NULL) ignores banking — prime directive', () => {
  it('standalone with NO banking is OK if approved + provider — banking check skipped', async () => {
    const stub = makeStub({
      practices:        [{ id: 'p1', status: 'approved', group_id: null, ...NO_BANK }],
      practice_groups:  [],
      practice_members: [{ ...APPROVED_PROVIDER, practice_id: 'p1' }],
    });
    const r = await checkTradingGate(stub, 'p1');
    // The existing two-condition gate (approved + ≥1 provider) — passes.
    // No new no_banking failure: this is the standalone-unchanged guarantee.
    expect(r).toEqual({ ok: true });
  });

  it('standalone with own banking is also OK (unchanged path)', async () => {
    const stub = makeStub({
      practices:        [{ id: 'p1', status: 'approved', group_id: null, ...FULL_BANK }],
      practice_groups:  [],
      practice_members: [{ ...APPROVED_PROVIDER, practice_id: 'p1' }],
    });
    const r = await checkTradingGate(stub, 'p1');
    expect(r).toEqual({ ok: true });
  });
});
