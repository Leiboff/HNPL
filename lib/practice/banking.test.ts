import { describe, it, expect } from 'vitest';
import { resolvePayoutBanking } from './banking';

// ─── Tests — banking resolution (group-or-branch + standalone-unchanged)
//
// The four cases:
//   1. Standalone with own banking → source: 'branch'.
//   2. Standalone with no banking  → source: 'none' (group lookup
//      MUST short-circuit — standalone is byte-for-byte unchanged).
//   3. Branch with own banking     → source: 'branch'.
//   4. Branch with no own banking  → source: 'group' (when group has
//      banking) or 'none' (when group also empty).
//
// Plus an explicit "branch + no group banking" → 'none' so the
// trading gate fails closed.

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

describe('resolvePayoutBanking — standalone practices unchanged', () => {
  it('standalone with own banking → source:branch', async () => {
    const stub = makeStub({
      practices: [{ id: 'p1', group_id: null, ...FULL_BRANCH_BANK }],
      practice_groups: [],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('branch');
    if (r.source !== 'branch') return;
    expect(r.banking.bank_name).toBe('FNB');
  });

  it('standalone with NO banking → source:none (NO group lookup happens — short-circuit)', async () => {
    const stub = makeStub({
      practices: [{ id: 'p1', group_id: null, ...NO_BANK }],
      practice_groups: [], // even if a hypothetical group existed, group_id NULL means we never read it.
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('none');
  });
});

describe('resolvePayoutBanking — branch with own banking', () => {
  it('uses the BRANCH banking even when the group also has banking (own wins)', async () => {
    const stub = makeStub({
      practices: [{ id: 'p1', group_id: 'g1', ...FULL_BRANCH_BANK }],
      practice_groups: [{ id: 'g1', ...FULL_GROUP_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('branch');
    if (r.source !== 'branch') return;
    expect(r.banking.bank_name).toBe('FNB');                 // branch, not ABSA
    expect(r.banking.bank_account_number).toBe('12345678');  // branch's account
  });
});

describe('resolvePayoutBanking — branch fallback to group', () => {
  it('branch with NO own banking + group with banking → source:group', async () => {
    const stub = makeStub({
      practices: [{ id: 'p1', group_id: 'g1', ...NO_BANK }],
      practice_groups: [{ id: 'g1', ...FULL_GROUP_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('group');
    if (r.source !== 'group') return;
    expect(r.banking.bank_name).toBe('ABSA');
    expect(r.banking.bank_account_number).toBe('99999999');
    expect(r.groupId).toBe('g1');
  });

  it('branch with NO own banking + group with NO banking → source:none (trading gate will fail)', async () => {
    const stub = makeStub({
      practices: [{ id: 'p1', group_id: 'g1', ...NO_BANK }],
      practice_groups: [{ id: 'g1', ...NO_BANK }],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('none');
  });

  it('partially-populated banking (account number missing) does NOT count as banked', async () => {
    const stub = makeStub({
      practices: [{ id: 'p1', group_id: null, bank_name: 'FNB', bank_account_number: '', branch_code: '250655', account_holder: null, account_type: null }],
      practice_groups: [],
    });
    const r = await resolvePayoutBanking(stub, 'p1');
    expect(r.source).toBe('none');
  });
});

describe('resolvePayoutBanking — missing practice', () => {
  it('returns source:none when the practice row does not exist', async () => {
    const stub = makeStub({ practices: [], practice_groups: [] });
    const r = await resolvePayoutBanking(stub, 'nonexistent');
    expect(r.source).toBe('none');
  });
});
