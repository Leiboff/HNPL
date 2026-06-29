import { describe, it, expect } from 'vitest';
import { resolvePayoutBanking } from './banking';

// ─── Tests — banking resolution post-0062 brand-first inversion ─────────
//
// Pre-0062: NULL group_id was the "standalone" tier and the resolver
// short-circuited to source:'none' before issuing the group lookup.
// Post-0062 every practice has a brand (group_id NOT NULL at the DB
// layer) and the resolver always falls through "own banking → brand
// banking → none". The shape of the answer is identical for the solo
// case (own banking still wins; nothing else changes from the
// settlement layer's perspective), but the code path is one fewer.
//
// The cases below pin:
//   • Own banking wins (any group_id, including the auto-created
//     solo brand whose own row is empty).
//   • Fallback to brand banking when own is empty.
//   • 'none' when neither populated.
//   • Defensive fallback if group_id is somehow NULL on a row
//     (snapshot/restore edge case) — still returns 'none' rather
//     than throwing.

type Row = Record<string, unknown> | null;
type State = { practices: Row[]; practice_groups: Row[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStub(state: State): any {
  return {
    from(table: keyof State) {
      const rows = state[table];
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const builder = {
        select() { return builder; },
        eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
        maybeSingle: async () => {
          const found = rows.find((r): r is Record<string, unknown> => r !== null && filters.every((f) => f(r)));
          return { data: found ?? null, error: null };
        },
      };
      return builder;
    },
  };
}

const FULL_BRANCH_BANK = {
  bank_name:           'FNB',
  bank_account_number: '12345678',
  branch_code:         '250655',
  account_holder:      'Sandton Branch',
  account_type:        'current',
};
const FULL_GROUP_BANK = {
  bank_name:           'ABSA',
  bank_account_number: '99999999',
  branch_code:         '632005',
  account_holder:      'Brand Central',
  account_type:        'current',
};
const NO_BANK = {
  bank_name:           null,
  bank_account_number: null,
  branch_code:         null,
  account_holder:      null,
  account_type:        null,
};

describe('resolvePayoutBanking — solo (brand-of-1 with empty brand banking)', () => {
  it('solo with own banking → source:branch', async () => {
    // Solo signups always have an auto-created brand (per migration
    // 0062 + the signup action). The brand row's banking is empty by
    // default; the practice's own banking wins.
    const stub = makeStub({
      practices:       [{ id: 'p1', group_id: 'g-auto', ...FULL_BRANCH_BANK }],
      practice_groups: [{ id: 'g-auto', ...NO_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('branch');
    if (r.source !== 'branch') return;
    expect(r.banking.bank_name).toBe('FNB');
  });

  it('solo with NO banking + auto-brand with NO banking → source:none', async () => {
    const stub = makeStub({
      practices:       [{ id: 'p1', group_id: 'g-auto', ...NO_BANK }],
      practice_groups: [{ id: 'g-auto', ...NO_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('none');
  });
});

describe('resolvePayoutBanking — practice with own banking', () => {
  it('uses the BRANCH banking even when the brand also has banking (own wins)', async () => {
    const stub = makeStub({
      practices:       [{ id: 'p1', group_id: 'g1', ...FULL_BRANCH_BANK }],
      practice_groups: [{ id: 'g1', ...FULL_GROUP_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('branch');
    if (r.source !== 'branch') return;
    expect(r.banking.bank_name).toBe('FNB');                 // branch, not ABSA
    expect(r.banking.bank_account_number).toBe('12345678');  // branch's account
  });
});

describe('resolvePayoutBanking — branch fallback to brand', () => {
  it('branch with NO own banking + brand with banking → source:group', async () => {
    const stub = makeStub({
      practices:       [{ id: 'p1', group_id: 'g1', ...NO_BANK }],
      practice_groups: [{ id: 'g1', ...FULL_GROUP_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('group');
    if (r.source !== 'group') return;
    expect(r.banking.bank_name).toBe('ABSA');
    expect(r.banking.bank_account_number).toBe('99999999');
    expect(r.groupId).toBe('g1');
  });

  it('branch with NO own banking + brand with NO banking → source:none (trading gate will fail)', async () => {
    const stub = makeStub({
      practices:       [{ id: 'p1', group_id: 'g1', ...NO_BANK }],
      practice_groups: [{ id: 'g1', ...NO_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('none');
  });

  it('partially-populated banking (account number missing) does NOT count as banked', async () => {
    const stub = makeStub({
      practices:       [{ id: 'p1', group_id: 'g1', bank_name: 'FNB', bank_account_number: '', branch_code: '250655', account_holder: null, account_type: null }],
      practice_groups: [{ id: 'g1', ...NO_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('none');
  });
});

describe('resolvePayoutBanking — defensive', () => {
  it('returns source:none when the practice row does not exist', async () => {
    const stub = makeStub({ practices: [], practice_groups: [] });
    const r = await resolvePayoutBanking(stub, 'nonexistent');
    expect(r.source).toBe('none');
  });

  it('returns source:none when group_id is null on a row (snapshot/restore edge)', async () => {
    // Post-0062 the DB constraint is NOT NULL, but a snapshot
    // restored mid-migration could surface a row with NULL. The
    // resolver degrades safely to 'none' rather than throwing.
    const stub = makeStub({
      practices:       [{ id: 'p1', group_id: null, ...NO_BANK }],
      practice_groups: [],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('none');
  });
});
