import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import { findPatientBySaId } from './findPatientBySaId';
import { hashIdForLookup } from '@/lib/idEncryption';

// ─── findPatientBySaId ───────────────────────────────────────────────
//
// SA-ID-keyed counterpart to findExistingAuthUser.ts's email-keyed
// lookup. Pins:
//   1. A profile whose sa_id_lookup_hash matches is found.
//   2. No match (or a legacy row with hash=NULL) → null, not an error.
//   3. Only role='patient' rows are matched — a practice staff member's
//      sa_id_number (also encrypted+hashed, via app/practice/members/
//      actions.ts) must never be returned as a "patient" match.

const SA_ID = '9001015800086';

beforeAll(() => {
  process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
});

type Row = Record<string, unknown>;

function makeSvc(profiles: Row[]) {
  return {
    from(name: string) {
      if (name !== 'profiles') throw new Error(`unexpected table: ${name}`);
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = (_cols?: string) => b;
      b.eq = (col: string, val: unknown) => { filters.push([col, val]); return b; };
      b.maybeSingle = () => Promise.resolve({
        data: profiles.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null,
        error: null,
      });
      return b;
    },
  };
}

describe('findPatientBySaId — match', () => {
  it('finds the profile whose sa_id_lookup_hash matches the hashed input', async () => {
    const hash = hashIdForLookup(SA_ID);
    const svc = makeSvc([
      { id: 'pat1', email: 'pat1@example.com', role: 'patient', sa_id_lookup_hash: hash },
    ]);
    const result = await findPatientBySaId(svc, SA_ID);
    expect(result).toEqual({ id: 'pat1', email: 'pat1@example.com' });
  });
});

describe('findPatientBySaId — no match', () => {
  it('returns null when no profile has a matching hash', async () => {
    const svc = makeSvc([
      { id: 'pat1', email: 'pat1@example.com', role: 'patient', sa_id_lookup_hash: hashIdForLookup('8501015800087') },
    ]);
    expect(await findPatientBySaId(svc, SA_ID)).toBeNull();
  });

  it('returns null for a legacy row with sa_id_lookup_hash = NULL (not backfilled)', async () => {
    const svc = makeSvc([
      { id: 'pat1', email: 'pat1@example.com', role: 'patient', sa_id_lookup_hash: null },
    ]);
    expect(await findPatientBySaId(svc, SA_ID)).toBeNull();
  });
});

describe('findPatientBySaId — role scoping', () => {
  it('does not match a non-patient profile (e.g. practice staff) sharing the same hash', async () => {
    const hash = hashIdForLookup(SA_ID);
    const svc = makeSvc([
      { id: 'staff1', email: 'staff1@example.com', role: 'practice_admin', sa_id_lookup_hash: hash },
    ]);
    expect(await findPatientBySaId(svc, SA_ID)).toBeNull();
  });
});
