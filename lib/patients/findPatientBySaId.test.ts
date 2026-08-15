import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import { findPatientBySaId } from './findPatientBySaId';
import { hashIdForLookup } from '@/lib/idEncryption';

// ─── findPatientBySaId ───────────────────────────────────────────────
//
// SA-ID-keyed counterpart to findExistingAuthUser's email-keyed lookup.
// Restored from commit 61743e5 (reverted by 500fe3b) now that the signup
// gate needs it. Pins:
//   1. A profile whose sa_id_lookup_hash matches is found.
//   2. No match, or a legacy row with hash=NULL → null, not an error.
//   3. role='patient' only — a practice staff member's sa_id_number is
//      also encrypted and hashed, and must never come back as a "patient"
//      match, because the uniqueness rule does not cover staff.
//   4. A read FAILURE throws rather than reading as "nobody owns this ID".
//      That direction matters: the gate's whole job is to refuse, so an
//      error that looks like "not found" would let the duplicate through.

const SA_ID = '9001015800086';

beforeAll(() => {
  process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
});

type Row = Record<string, unknown>;

/** Minimal PostgREST shim: select/eq/order/limit, resolving as a thenable. */
function makeSvc(profiles: Row[], opts: { error?: { message: string } } = {}) {
  let lastFilters: Array<[string, unknown]> = [];
  const svc = {
    from(name: string) {
      if (name !== 'profiles') throw new Error(`unexpected table: ${name}`);
      const filters: Array<[string, unknown]> = [];
      lastFilters = filters;
      let cap = Infinity;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq     = (col: string, val: unknown) => { filters.push([col, val]); return b; };
      b.order  = () => b;
      b.limit  = (n: number) => { cap = n; return b; };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b as any).then = (onFulfilled: (v: unknown) => unknown) => {
        if (opts.error) return Promise.resolve({ data: null, error: opts.error }).then(onFulfilled);
        const matched = profiles
          .filter((r) => filters.every(([c, v]) => r[c] === v))
          .slice(0, cap);
        return Promise.resolve({ data: matched, error: null }).then(onFulfilled);
      };
      return b;
    },
    filters: () => lastFilters,
  };
  return svc;
}

describe('finding a patient by SA ID', () => {
  it('matches on the blind index, not on the encrypted column', async () => {
    const svc = makeSvc([
      { id: 'u1', email: 'a@example.test', role: 'patient', sa_id_lookup_hash: hashIdForLookup(SA_ID) },
    ]);
    await expect(findPatientBySaId(svc, SA_ID)).resolves.toEqual({ id: 'u1', email: 'a@example.test' });
    expect(svc.filters()).toContainEqual(['sa_id_lookup_hash', hashIdForLookup(SA_ID)]);
  });

  it('tolerates surrounding whitespace on the submitted ID', async () => {
    const svc = makeSvc([
      { id: 'u1', email: 'a@example.test', role: 'patient', sa_id_lookup_hash: hashIdForLookup(SA_ID) },
    ]);
    await expect(findPatientBySaId(svc, `  ${SA_ID} `)).resolves.toMatchObject({ id: 'u1' });
  });

  it('returns null when nobody holds that ID', async () => {
    const svc = makeSvc([
      { id: 'u1', email: 'a@example.test', role: 'patient', sa_id_lookup_hash: hashIdForLookup('8202025800085') },
    ]);
    await expect(findPatientBySaId(svc, SA_ID)).resolves.toBeNull();
  });

  it('returns null for a legacy row that has no hash yet', async () => {
    const svc = makeSvc([
      { id: 'u1', email: 'a@example.test', role: 'patient', sa_id_lookup_hash: null },
    ]);
    await expect(findPatientBySaId(svc, SA_ID)).resolves.toBeNull();
  });

  it('returns null for an empty ID rather than hashing the empty string', async () => {
    const svc = makeSvc([
      { id: 'u1', email: 'a@example.test', role: 'patient', sa_id_lookup_hash: hashIdForLookup('') },
    ]);
    await expect(findPatientBySaId(svc, '   ')).resolves.toBeNull();
  });

  it('never returns a PRACTICE STAFF row — staff are outside the uniqueness rule', async () => {
    const svc = makeSvc([
      { id: 'doc', email: 'doc@practice.test', role: 'practice_provider', sa_id_lookup_hash: hashIdForLookup(SA_ID) },
    ]);
    await expect(findPatientBySaId(svc, SA_ID)).resolves.toBeNull();
    expect(svc.filters()).toContainEqual(['role', 'patient']);
  });

  it('picks a patient row over a staff row holding the same ID', async () => {
    const svc = makeSvc([
      { id: 'doc', email: 'doc@practice.test', role: 'practice_provider', sa_id_lookup_hash: hashIdForLookup(SA_ID) },
      { id: 'pat', email: 'pat@example.test',  role: 'patient',           sa_id_lookup_hash: hashIdForLookup(SA_ID) },
    ]);
    await expect(findPatientBySaId(svc, SA_ID)).resolves.toMatchObject({ id: 'pat' });
  });
});

describe('failing closed', () => {
  it('THROWS on a read failure instead of reporting "no owner"', async () => {
    // The gate treats null as "nobody has this ID, let them register". A
    // swallowed error would therefore create the exact duplicate this
    // exists to prevent.
    const svc = makeSvc([], { error: { message: 'connection reset' } });
    await expect(findPatientBySaId(svc, SA_ID)).rejects.toThrow(/connection reset/);
  });

  it('still resolves an owner when the data is inconsistent (more than one match)', async () => {
    // Before cleanup, several patient rows can share an ID. maybeSingle()
    // would turn that into an ERROR — which, swallowed, reads as "not
    // found" and lets a third duplicate in. Taking the first match keeps
    // the answer "yes, somebody owns this".
    const svc = makeSvc([
      { id: 'a', email: 'a@example.test', role: 'patient', sa_id_lookup_hash: hashIdForLookup(SA_ID) },
      { id: 'b', email: 'b@example.test', role: 'patient', sa_id_lookup_hash: hashIdForLookup(SA_ID) },
    ]);
    await expect(findPatientBySaId(svc, SA_ID)).resolves.toMatchObject({ id: 'a' });
  });

  it('handles a null email without crashing the caller', async () => {
    const svc = makeSvc([
      { id: 'u1', email: null, role: 'patient', sa_id_lookup_hash: hashIdForLookup(SA_ID) },
    ]);
    await expect(findPatientBySaId(svc, SA_ID)).resolves.toEqual({ id: 'u1', email: null });
  });
});
