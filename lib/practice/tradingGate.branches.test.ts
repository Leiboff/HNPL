import { describe, it, expect } from 'vitest';
import {
  checkTradingGate,
  NO_BANKING_MESSAGE,
} from './tradingGate';

// ─── Tests — trading gate condition (c) post-0062 brand-first inversion ─
//
// Pre-0062 the banking condition was branch-only (gated on
// practice.group_id NOT NULL). Post-inversion EVERY practice belongs
// to a brand and the gate fires uniformly. The cases below pin the
// new universal behaviour:
//
//   • Practice with own banking → ok (own wins).
//   • Practice with NO own banking + brand with banking → ok (group fallback).
//   • Practice with NO own banking + brand with NO banking → no_banking.
//   • Solo (brand has just this one practice, no own banking, brand
//     has no banking) → no_banking. THIS IS THE BREAKING CHANGE from
//     Phase 1: a solo practice can no longer trade with zero banking
//     on file. The user adds banking from the dashboard and is good.
//
// Banking is provided by a real resolvePayoutBanking call against a
// stub that models the practices + practice_groups queries the
// resolver issues — proves the resolver + gate compose correctly.

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

describe('Trading gate — banking is universal post-0062', () => {
  it('practice with own banking → ok', async () => {
    const stub = makeStub({
      practices:        [{ id: 'b1', status: 'approved', group_id: 'g1', ...FULL_BANK }],
      practice_groups:  [{ id: 'g1', ...NO_BANK }],
      practice_members: [APPROVED_PROVIDER],
    });
    const r = await checkTradingGate(stub, 'b1');
    expect(r).toEqual({ ok: true });
  });

  it('practice with NO own banking + brand with banking → ok (fallback)', async () => {
    const stub = makeStub({
      practices:        [{ id: 'b1', status: 'approved', group_id: 'g1', ...NO_BANK }],
      practice_groups:  [{ id: 'g1', ...FULL_BANK }],
      practice_members: [APPROVED_PROVIDER],
    });
    const r = await checkTradingGate(stub, 'b1');
    expect(r).toEqual({ ok: true });
  });

  it('practice with NO own banking + brand with NO banking → no_banking', async () => {
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

describe('Trading gate — solo (brand-of-1) post-0062 needs banking too', () => {
  it('solo with own banking → ok (the auto-brand row stays empty)', async () => {
    const stub = makeStub({
      practices:        [{ id: 'p1', status: 'approved', group_id: 'g-auto', ...FULL_BANK }],
      practice_groups:  [{ id: 'g-auto', ...NO_BANK }],
      practice_members: [{ ...APPROVED_PROVIDER, practice_id: 'p1' }],
    });
    const r = await checkTradingGate(stub, 'p1');
    expect(r).toEqual({ ok: true });
  });

  it('solo with NO banking (auto-brand also empty) → no_banking', async () => {
    // The brand-first inversion's price-of-admission: a solo practice
    // can no longer trade with zero banking on file. Pre-0062 this
    // passed (standalone skipped the banking check). Now it fails
    // with a friendly nudge to add banking — exactly what we want
    // since a practice with no banking can't actually be settled.
    const stub = makeStub({
      practices:        [{ id: 'p1', status: 'approved', group_id: 'g-auto', ...NO_BANK }],
      practice_groups:  [{ id: 'g-auto', ...NO_BANK }],
      practice_members: [{ ...APPROVED_PROVIDER, practice_id: 'p1' }],
    });
    const r = await checkTradingGate(stub, 'p1');
    expect(r).toEqual({
      ok: false,
      reason: 'no_banking',
      message: NO_BANKING_MESSAGE,
    });
  });
});
