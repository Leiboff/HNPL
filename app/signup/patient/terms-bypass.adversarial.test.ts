import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── ADVERSARIAL: the email signup route, attacked ────────────────────
//
// A Server Action is an HTTP endpoint. The "I agree" checkbox in
// PatientSignupForm is a control in a page the attacker fully owns — they
// can delete it from the DOM, or skip the page entirely and POST the
// action payload by hand. So the only thing standing between "did not
// agree" and "has an account" is what signUpPatient itself does with the
// `termsAccepted` field.
//
// signup-terms-gate.test.ts already covers the honest miss: `false`, and
// omitted. That is the shape a BUG produces. These cover the shape an
// ATTACKER produces, which is different in one specific way —
//
//   the field's TypeScript type is `boolean`, and TypeScript is erased at
//   runtime. Nothing between the wire and the gate coerces it. So the
//   attacker is not limited to booleans, and the interesting values are
//   the ones that are neither `true` nor falsy.
//
// Everything here drives the real action against a fake Supabase and
// asserts on what actually happened to the database, not on what the
// source says.

const signUpSpy     = vi.fn(async () => ({ data: { user: { id: 'new-user', identities: [{ provider: 'email' }] } }, error: null }));
const deleteUserSpy = vi.fn(async () => ({ error: null }));
const resendSpy     = vi.fn(async () => ({ error: null }));

type Row = { id: string; terms_accepted_at: string | null } | null;
const db: { row: Row; updateError: unknown; inserts: Record<string, unknown>[] } = {
  row: null, updateError: null, inserts: [],
};

vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn() }) }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: signUpSpy } }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { resend: resendSpy, admin: { deleteUser: deleteUserSpy } },
    from: () => {
      const b: Record<string, unknown> = {};
      let op: string | null = null;
      Object.assign(b, {
        update: () => { op = 'update'; return b; },
        insert: async (values: Record<string, unknown>) => {
          db.inserts.push(values);
          db.row = { id: String(values.id), terms_accepted_at: String(values.terms_accepted_at) };
          return { error: null };
        },
        select: () => {
          if (op === 'update') {
            if (db.updateError) return Promise.resolve({ data: null, error: db.updateError });
            if (db.row && db.row.terms_accepted_at === null) {
              db.row = { ...db.row, terms_accepted_at: '2026-09-01T00:00:00Z' };
              return Promise.resolve({ data: [{ id: db.row.id }], error: null });
            }
            return Promise.resolve({ data: [], error: null });
          }
          return b;
        },
        eq: () => b,
        is: () => b,
        maybeSingle: async () => ({ data: db.row ? { terms_accepted_at: db.row.terms_accepted_at } : null, error: null }),
      });
      return b;
    },
  }),
}));

let existingUser: { id: string; email_confirmed_at: string | null } | null = null;
let lookupCalls = 0;
vi.mock('@/lib/auth/findExistingAuthUser', () => ({
  findExistingAuthUser: async () => { lookupCalls += 1; return lookupCalls === 1 ? existingUser : { id: 'new-user', email_confirmed_at: null }; },
}));

import { signUpPatient, type PatientSignupInput } from './actions';

const VALID = {
  firstName: 'Adver',
  lastName:  'Sarial',
  email:     'adversarial@example.com',
  password:  'Tr0ub4dourX9',
};

/** POST the action with an arbitrary termsAccepted, as a crafted request would. */
function post(termsAccepted: unknown) {
  return signUpPatient({ ...VALID, termsAccepted } as unknown as PatientSignupInput);
}

/** Did an account get created and stamped? */
function accountWasCreated(): boolean {
  return signUpSpy.mock.calls.length > 0;
}

beforeEach(() => {
  signUpSpy.mockClear();
  deleteUserSpy.mockClear();
  resendSpy.mockClear();
  db.row = { id: 'new-user', terms_accepted_at: null };
  db.updateError = null;
  db.inserts = [];
  existingUser = null;
  lookupCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 1 — Just don't send it
// ══════════════════════════════════════════════════════════════════════

describe('ATTACK 1 — the field is missing or plainly false', () => {
  it.each([
    ['false',      false],
    ['undefined',  undefined],
    ['null',       null],
    ['0',          0],
    ['an empty string', ''],
    ['NaN',        NaN],
  ])('%s creates nothing — auth.signUp is never reached', async (_label, value) => {
    const res = await post(value);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/accept the betternow terms/i);
    // The gate short-circuits BEFORE the account exists, so there is no
    // orphan to roll back and no window in which an unaccepted account is
    // real.
    expect(accountWasCreated()).toBe(false);
    expect(db.row?.terms_accepted_at).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 2 — Send something that is neither `true` nor falsy
// ══════════════════════════════════════════════════════════════════════
//
// The attack that a `boolean` type annotation does not stop. A gate
// written as `if (!termsAccepted)` accepts every one of these, because
// each is truthy in JavaScript — including, notoriously, the STRING
// "false".
//
// Whether that is exploitable in the "steal an account" sense is not the
// point. The point is what ends up in the database: profiles.
// terms_accepted_at is a legal audit record, and a value the server never
// examined is not evidence of anything. If any of these creates a
// stamped account, the record says a person agreed when the server has no
// basis for saying so.

describe('ATTACK 2 — truthy values that are not an agreement', () => {
  it.each([
    ['the STRING "false"',  'false'],
    ['the STRING "0"',      '0'],
    ['the STRING "no"',     'no'],
    ['the STRING "off"',    'off'],
    ['the STRING "undefined"', 'undefined'],
    ['an empty object',     {}],
    ['an empty array',      []],
    ['the number 1',        1],
    ['the number -1',       -1],
    ['the string "true"',   'true'],
  ])('%s is not an agreement — nothing is created and nothing is stamped', async (_label, value) => {
    const res = await post(value);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/accept the betternow terms/i);
    expect(accountWasCreated()).toBe(false);
    expect(db.row?.terms_accepted_at).toBeNull();
  });

  it('only a real boolean true gets through', async () => {
    const res = await post(true);

    expect(res.success).toBe(true);
    expect(accountWasCreated()).toBe(true);
    expect(db.row?.terms_accepted_at).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 3 — Agree, then break the recording
// ══════════════════════════════════════════════════════════════════════
//
// The mirror of ATTACK 4 in the OAuth suite. If a failed stamp still
// leaves an account behind, then degrading the database is a way to
// manufacture an account with no acceptance on it — and, worse, one that
// then blocks its own retry on "an account with this email already
// exists".

describe('ATTACK 3 — a refused write must not leave an account behind', () => {
  it('rolls the auth user back when the acceptance cannot be recorded', async () => {
    db.updateError = { message: 'permission denied', code: '42501' };

    const res = await post(true);

    expect(res.success).toBe(false);
    expect(deleteUserSpy).toHaveBeenCalledWith('new-user');
    // And the message carries a reference, so the same failure reported
    // from the field is diagnosable rather than "please try again".
    expect(res.error).toMatch(/reference UPD-42501/i);
  });

  it('a half-finished PRIOR signup does not get waved through on the strength of existing', async () => {
    // An account abandoned at the OTP step, from before any of this — it
    // is unconfirmed, so nobody has proved they own the address. It gets
    // the same gate as a fresh signup.
    existingUser = { id: 'orphan-user', email_confirmed_at: null };

    const res = await post(false);

    expect(res.success).toBe(false);
    expect(resendSpy).not.toHaveBeenCalled();
    expect(accountWasCreated()).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 4 — Reach the gate by another door
// ══════════════════════════════════════════════════════════════════════

describe('ATTACK 4 — the gate is the FIRST thing that matters', () => {
  it('an invitation token does not buy a way past the tick', async () => {
    const res = await signUpPatient({
      ...VALID, termsAccepted: false, token: 'a-real-invitation-token',
    } as PatientSignupInput);

    expect(res.success).toBe(false);
    expect(accountWasCreated()).toBe(false);
  });

  it('the acceptance is checked before the password rules, so no probe reaches signUp', async () => {
    // Ordering matters for a different reason than it looks: a gate that
    // ran last would let a crafted request use the earlier validators as
    // an oracle while never intending to agree at all.
    const res = await post(false);

    expect(res.error).toMatch(/accept the betternow terms/i);
    expect(accountWasCreated()).toBe(false);
  });
});
