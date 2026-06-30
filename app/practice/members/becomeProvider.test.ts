import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── becomeProvider — admin self-elects as provider ──────────────────────────
//
// Covers:
//   • Manager guard rejects callers without can_manage_practice.
//   • Required-field validation (specialty, HPCSA, SA ID).
//   • SA ID validator wired correctly (rejects invalid IDs with the
//     same generic message the signup forms use).
//   • Idempotency: already-provider returns an error, no UPDATE issued.
//   • Successful path UPDATEs the caller's row with role='provider' +
//     the clinical fields, and does NOT touch capability flags (so the
//     admin keeps can_manage_practice / can_create_bills).

const sessionUser: { id: string | null } = { id: 'admin-self' };
const membership: {
  practice_id: string | null;
  can_manage_practice: boolean;
} = { practice_id: 'practice-1', can_manage_practice: true };
const ownRow: {
  id: string;
  role: string;
} | null = { id: 'mem-1', role: 'admin' };
const writes: Array<{ table: string; update: unknown }> = [];

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/idEncryption', () => ({
  encryptId: (raw: string) => `enc(${raw})`,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({
        data: { user: sessionUser.id ? { id: sessionUser.id } : null },
        error: null,
      }),
    },
    from(table: string) {
      function selectChain() {
        return {
          eq: () => selectChain(),
          single: async () => {
            if (table === 'practice_members') {
              // Two queries hit practice_members.select().eq.single():
              //   guardManager: { practice_id, can_manage_practice }
              //   ownRow lookup: { id, role }
              if (sessionUser.id === null) {
                return { data: null, error: null };
              }
              // Disambiguate by what's been requested. The test mock is
              // simple — both calls receive the merged shape.
              return {
                data: {
                  practice_id:         membership.practice_id,
                  can_manage_practice: membership.can_manage_practice,
                  id:                  ownRow?.id ?? null,
                  role:                ownRow?.role ?? null,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      }
      return {
        select: selectChain,
        update: (row: unknown) => ({
          eq: () => ({
            eq: () => {
              writes.push({ table, update: row });
              return Promise.resolve({ data: null, error: null });
            },
          }),
        }),
      };
    },
  })),
}));

// Service-client (used elsewhere in actions.ts) — stub returns nothing here.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
    auth: { admin: { inviteUserByEmail: vi.fn() } },
  })),
}));

import { becomeProvider } from './actions';

const VALID_SA_ID = (() => {
  // Synthesise a Luhn-valid SA ID matching saId.ts rules (1995-06-15
  // female, citizenship 0). Mirrors the helper in saId.test.ts.
  function luhn(first12: string): string {
    let sum = 0;
    let doubleIt = true;
    for (let i = first12.length - 1; i >= 0; i--) {
      let d = first12.charCodeAt(i) - 48;
      if (doubleIt) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      doubleIt = !doubleIt;
    }
    return String((10 - (sum % 10)) % 10);
  }
  const first12 = '95' + '06' + '15' + '0123' + '0' + '8';
  return first12 + luhn(first12);
})();

beforeEach(() => {
  writes.length = 0;
  sessionUser.id = 'admin-self';
  membership.practice_id = 'practice-1';
  membership.can_manage_practice = true;
  ownRow!.id   = 'mem-1';
  ownRow!.role = 'admin';
});

describe('becomeProvider — guard', () => {
  it('rejects an unauthenticated caller', async () => {
    sessionUser.id = null;
    const result = await becomeProvider({
      specialty: 'Dentistry', hpcsaNumber: 'MP1234567', saIdNumber: VALID_SA_ID,
    });
    expect(result.error).toBe('Not authenticated.');
    expect(writes).toHaveLength(0);
  });

  it('rejects a member who cannot manage the practice', async () => {
    membership.can_manage_practice = false;
    const result = await becomeProvider({
      specialty: 'Dentistry', hpcsaNumber: 'MP1234567', saIdNumber: VALID_SA_ID,
    });
    expect(result.error).toMatch(/permission/i);
    expect(writes).toHaveLength(0);
  });
});

describe('becomeProvider — required fields', () => {
  it('requires specialty', async () => {
    const result = await becomeProvider({
      specialty: '', hpcsaNumber: 'MP1234567', saIdNumber: VALID_SA_ID,
    });
    expect(result.error).toBe('Specialty is required.');
    expect(writes).toHaveLength(0);
  });

  it('requires HPCSA number', async () => {
    const result = await becomeProvider({
      specialty: 'Dentistry', hpcsaNumber: '   ', saIdNumber: VALID_SA_ID,
    });
    expect(result.error).toBe('HPCSA number is required.');
    expect(writes).toHaveLength(0);
  });

  it('rejects an invalid SA ID (any internal reason)', async () => {
    const result = await becomeProvider({
      specialty: 'Dentistry', hpcsaNumber: 'MP1234567', saIdNumber: '0000000000000',
    });
    expect(result.error).toMatch(/SA ID number is invalid/i);
    expect(writes).toHaveLength(0);
  });
});

describe('becomeProvider — idempotency', () => {
  it('refuses when the caller is already role=provider', async () => {
    ownRow!.role = 'provider';
    const result = await becomeProvider({
      specialty: 'Dentistry', hpcsaNumber: 'MP1234567', saIdNumber: VALID_SA_ID,
    });
    expect(result.error).toMatch(/already a provider/i);
    expect(writes).toHaveLength(0);
  });
});

describe('becomeProvider — success', () => {
  it('UPDATEs the caller\'s row with role=provider + clinical fields, preserves capabilities', async () => {
    const result = await becomeProvider({
      specialty: 'Dentistry', hpcsaNumber: 'MP1234567', saIdNumber: VALID_SA_ID,
    });
    expect(result.error).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe('practice_members');

    const updated = writes[0].update as Record<string, unknown>;
    // Role flipped.
    expect(updated.role).toBe('provider');
    // Clinical fields populated.
    expect(updated.specialty).toBe('Dentistry');
    expect(updated.hpcsa_number).toBe('MP1234567');
    // SA ID encrypted via the mocked encryptId.
    expect(updated.sa_id_number).toBe(`enc(${VALID_SA_ID})`);
    // Capability flags NOT touched — admin powers preserved.
    expect(updated).not.toHaveProperty('can_manage_practice');
    expect(updated).not.toHaveProperty('can_create_bills');
  });
});
