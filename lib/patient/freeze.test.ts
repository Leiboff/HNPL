import { describe, it, expect, vi } from 'vitest';
import { isPatientFrozen } from './freeze';

// ─── isPatientFrozen — patient-level default rollup ─────────────────────────
//
// TRUE iff the patient has ANY payment row still in 'defaulted'. Settling
// the defaulted row (→ processing → collected) flips it back to false with
// no extra bookkeeping — the predicate is derived, not stored.

// Minimal chainable Supabase stub: from().select().eq().eq().limit()
// resolves to { data, error }. Records the filters so we can assert the
// query shape (status = 'defaulted', scoped by plans.patient_id).
function makeClient(result: { data: unknown[] | null; error: { message: string } | null }) {
  const filters: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return builder; },
    limit: async () => result,
  };
  return {
    _filters: filters,
    from: vi.fn(() => builder),
  };
}

describe('isPatientFrozen', () => {
  it('returns true when a defaulted payment exists', async () => {
    const client = makeClient({ data: [{ id: 'pay-1' }], error: null });
    expect(await isPatientFrozen(client, 'patient-1')).toBe(true);
  });

  it('returns false when there are no defaulted payments', async () => {
    const client = makeClient({ data: [], error: null });
    expect(await isPatientFrozen(client, 'patient-1')).toBe(false);
  });

  it('scopes the query to status=defaulted and plans.patient_id', async () => {
    const client = makeClient({ data: [], error: null });
    await isPatientFrozen(client, 'patient-42');
    expect(client.from).toHaveBeenCalledWith('payments');
    expect(client._filters).toContainEqual(['status', 'defaulted']);
    expect(client._filters).toContainEqual(['plans.patient_id', 'patient-42']);
  });

  it('goes FALSE once the defaulted row is settled (no rows returned)', async () => {
    // Same patient, after settling — the row is now collected, so the
    // defaulted query returns nothing and the freeze lifts.
    const settled = makeClient({ data: [], error: null });
    expect(await isPatientFrozen(settled, 'patient-1')).toBe(false);
  });

  it('fails OPEN (not frozen) on a query error — never blocks on a DB blip', async () => {
    const client = makeClient({ data: null, error: { message: 'connection reset' } });
    expect(await isPatientFrozen(client, 'patient-1')).toBe(false);
  });

  it('returns false for an empty patientId without querying', async () => {
    const client = makeClient({ data: [{ id: 'x' }], error: null });
    expect(await isPatientFrozen(client, '')).toBe(false);
    expect(client.from).not.toHaveBeenCalled();
  });
});
