import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── "We couldn't record your agreement" must not be a dead end ────────
//
// FIELD BUG: a normal email signup with the terms ticked came back with
// "We couldn't record your agreement to the terms, so your account wasn't
// created. Please try again." — and every retry did the same. Worse, the
// rollback that message describes can fail, so a retry then collides with
// the account it was meant to remove and the visitor is stuck for good.
//
// recordAcceptance returned a bare false for two situations that are not
// alike:
//
//   • the database REFUSED the write — fatal, and worth undoing the
//     account for;
//   • there was no profile row to write TO — not fatal at all.
//
// /auth/callback has provisioned defensively in the second case for as
// long as it has existed. The email path had no equivalent, so identical
// database state that the OAuth path recovers from silently ended the
// email path with this message.
//
// These tests drive the REAL action with a fake Supabase, so they assert
// what a signup actually does rather than what the source says.

const signUpSpy    = vi.fn();
const deleteUserSpy = vi.fn(async () => ({ error: null }));
const resendSpy    = vi.fn(async () => ({ error: null }));
const insertSpy    = vi.fn(async () => ({ error: null }));

// The fake `profiles` table, driven per-test.
type Row = { id: string; terms_accepted_at: string | null } | null;
let row: Row = null;
let updateError: unknown = null;
let selectError: unknown = null;
let insertError: unknown = null;

vi.mock('next/headers', () => ({ cookies: async () => ({ set: vi.fn() }) }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: signUpSpy } }),
}));

// A minimal PostgREST-shaped builder: .update().eq().is().select() and
// .select().eq().maybeSingle(). Every call records what it was asked.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      resend: resendSpy,
      admin:  { deleteUser: deleteUserSpy, getUserById: async () => ({ data: null }) },
    },
    from: () => {
      const builder: Record<string, unknown> = {};
      let filteredOnNullAcceptance = false;
      const chain = () => builder;
      Object.assign(builder, {
        update: () => { builder._op = 'update'; return chain(); },
        insert: async (values: Record<string, unknown>) => {
          await insertSpy();
          if (insertError) return { error: insertError };
          row = { id: String(values.id), terms_accepted_at: String(values.terms_accepted_at) };
          return { error: null };
        },
        select: () => {
          if (builder._op === 'update') {
            if (updateError) return Promise.resolve({ data: null, error: updateError });
            // The write-once filter only matches a row whose column is null.
            if (row && (!filteredOnNullAcceptance || row.terms_accepted_at === null)) {
              row = { ...row, terms_accepted_at: '2026-08-31T00:00:00Z' };
              return Promise.resolve({ data: [{ id: row.id }], error: null });
            }
            return Promise.resolve({ data: [], error: null });
          }
          return chain();
        },
        eq: () => chain(),
        is: () => { filteredOnNullAcceptance = true; return chain(); },
        ilike: () => chain(),
        maybeSingle: async () => {
          if (selectError) return { data: null, error: selectError };
          return { data: row ? { terms_accepted_at: row.terms_accepted_at } : null, error: null };
        },
      });
      return builder;
    },
  }),
}));

/**
 * Read the fake row through a call, not directly: `row` is assigned null in
 * a test and then mutated inside the mock, which TypeScript's control-flow
 * analysis cannot see — it narrows the module-level binding to `never` and
 * the assertion stops compiling. A function call is opaque to narrowing.
 */
const currentRow = (): Row => row;

let existingUser: { id: string; email_confirmed_at: string | null } | null = null;
vi.mock('@/lib/auth/findExistingAuthUser', () => ({
  findExistingAuthUser: async () => existingUser,
}));

const { signUpPatient } = await import('./actions');

const VALID = {
  firstName:     'Recovery',
  lastName:      'Test',
  email:         'recovery-test@example.com',
  password:      'Tr0ub4dourX9',
  termsAccepted: true,
};

/** A fresh signUp response, with the identity a real new user carries. */
function freshUser(id = 'new-user-id') {
  return { data: { user: { id, identities: [{ provider: 'email' }] } }, error: null };
}

beforeEach(() => {
  signUpSpy.mockReset();
  deleteUserSpy.mockClear();
  resendSpy.mockClear();
  insertSpy.mockClear();
  row = null;
  updateError = null;
  selectError = null;
  insertError = null;
  existingUser = null;
});

describe('the happy path still works', () => {
  it('stamps the row the trigger created, and keeps the account', async () => {
    row = { id: 'new-user-id', terms_accepted_at: null };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res).toEqual({ error: null, success: true });
    expect(currentRow()?.terms_accepted_at).toBeTruthy();
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });
});

describe('no profile row to stamp — the reported dead end', () => {
  it('PROVISIONS the row with the acceptance instead of failing the signup', async () => {
    // The trigger did not fire, or the row was removed. This is the state
    // /auth/callback recovers from; the email path now does too.
    row = null;
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(true);
    expect(res.error).toBeNull();
    expect(insertSpy).toHaveBeenCalled();
    // …and the provisioned row carries the acceptance, which is the whole
    // point: no account may exist without one.
    expect(currentRow()?.terms_accepted_at).toBeTruthy();
    // The account is NOT rolled back any more.
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it('still refuses if the provision itself fails', async () => {
    row = null;
    insertError = { code: '42501', message: 'permission denied for table profiles' };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/couldn't record your agreement/i);
    // No acceptance means no account — the rollback still runs.
    expect(deleteUserSpy).toHaveBeenCalledWith('new-user-id');
  });
});

describe('a genuinely refused write is still fatal', () => {
  it('rolls the account back when the UPDATE is refused', async () => {
    row = { id: 'new-user-id', terms_accepted_at: null };
    updateError = { code: '42501', message: 'permission denied for table profiles' };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/couldn't record your agreement/i);
    expect(deleteUserSpy).toHaveBeenCalledWith('new-user-id');
    // It must NOT try to paper over a refusal by inserting.
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('rolls back when the read-back cannot be performed either', async () => {
    row = null;
    selectError = { code: 'PGRST301', message: 'JWT expired' };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(false);
    expect(deleteUserSpy).toHaveBeenCalledWith('new-user-id');
  });
});

describe('an already-registered email is named as such', () => {
  it('treats the obfuscated signUp response as "already exists"', async () => {
    // With both Confirm-email and Confirm-phone on, GoTrue returns a fake
    // user with an EMPTY identities array instead of an error. Untreated,
    // that walked into the stamp, found no row for an id that was never
    // real, and told the visitor we could not record their agreement —
    // for an email that was simply already registered.
    signUpSpy.mockResolvedValue({ data: { user: { id: 'fake-id', identities: [] } }, error: null });

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already exists/i);
    expect(res.error).not.toMatch(/agreement to the terms/i);
    // Nothing was created, so nothing is deleted, and no stamp is tried.
    expect(deleteUserSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('a confirmed existing account is sent to sign in, as before', async () => {
    existingUser = { id: 'old-user', email_confirmed_at: '2026-01-01T00:00:00Z' };

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already exists/i);
    expect(signUpSpy).not.toHaveBeenCalled();
  });
});

describe('the abandoned-at-OTP account', () => {
  it('recovers an orphan by provisioning, without deleting the auth user', async () => {
    // Unconfirmed auth user, no profile row — the AUTH_ONLY orphan.
    // Previously the stamp "failed" here and the account was deleted and
    // re-minted. Provisioning reaches the same end state without that.
    existingUser = { id: 'orphan-user', email_confirmed_at: null };
    row = null;

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(true);
    expect(res.needsVerification).toBe(true);
    expect(res.email).toBe('recovery-test@example.com');
    expect(insertSpy).toHaveBeenCalled();
    expect(resendSpy).toHaveBeenCalled();
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it('re-sends the OTP for an unconfirmed account that already accepted', async () => {
    existingUser = { id: 'unconfirmed-user', email_confirmed_at: null };
    row = { id: 'unconfirmed-user', terms_accepted_at: '2026-08-01T00:00:00Z' };

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(true);
    expect(res.needsVerification).toBe(true);
    expect(resendSpy).toHaveBeenCalled();
    // Write-once: the existing acceptance is an audit fact, not re-dated.
    expect(currentRow()?.terms_accepted_at).toBe('2026-08-01T00:00:00Z');
  });

  it('deletes and recreates only when the write is genuinely refused', async () => {
    existingUser = { id: 'orphan-user', email_confirmed_at: null };
    row = null;
    insertError = { code: '42501', message: 'permission denied' };
    signUpSpy.mockResolvedValue(freshUser('recreated-user'));

    const res = await signUpPatient(VALID);

    // The orphan is cleared, then signUp runs again for a clean account.
    expect(deleteUserSpy).toHaveBeenCalledWith('orphan-user');
    expect(signUpSpy).toHaveBeenCalled();
    // The fresh attempt hits the same refusal, so it also refuses — but
    // the point is that it TRIED rather than dead-ending on the orphan.
    expect(res.success).toBe(false);
  });
});

// ─── The reference on the screen ───────────────────────────────────────
//
// This failure was reported twice and diagnosed neither time, because the
// screen said the same sentence whatever the cause and the reason lived
// only in a server log. A tester can now read a reference off the page.

describe('the failure names itself', () => {
  it('a refused provision quotes the operation and the SQLSTATE', async () => {
    row = null;
    insertError = { code: '42501', message: 'permission denied for table profiles' };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.error).toMatch(/quote reference/i);
    expect(res.error).toMatch(/PROV-42501/);
  });

  it('a refused update is distinguishable from a refused provision', async () => {
    row = { id: 'new-user-id', terms_accepted_at: null };
    updateError = { code: '42501', message: 'permission denied' };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.error).toMatch(/UPD-42501/);
    expect(res.error).not.toMatch(/PROV/);
  });

  it('carries the privileged-key diagnosis when the key is not usable', async () => {
    // The suite runs without SUPABASE_SERVICE_ROLE_KEY set, which is the
    // same class of misconfiguration as holding an anon key: nothing can
    // bypass RLS. That fact rides along in the reference, so a screenshot
    // is enough to tell "the database refused us" from "this deployment
    // has the wrong key".
    row = null;
    insertError = { code: '42501', message: 'permission denied' };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.error).toMatch(/KEY-MISSING/);
  });

  it('leaks nothing beyond an operation, a SQLSTATE and the key KIND', async () => {
    row = null;
    insertError = { code: '42501', message: 'permission denied for table profiles', details: 'user=anon' };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    // No table names, no PostgREST prose, no ids, no key material.
    expect(res.error).not.toMatch(/profiles/);
    expect(res.error).not.toMatch(/permission denied/);
    expect(res.error).not.toMatch(/user=anon/);
    expect(res.error).not.toMatch(/new-user-id/);
  });

  // The NOUSER case is gone from this section on purpose: a null user is
  // no longer an acceptance failure at all. See the section below.
});

// ─── The failure that was actually happening ───────────────────────────
//
// A field report quoted reference NOUSER, which meant signUp had returned
// `{ user: null, error: null }` — Supabase's anti-enumeration SILENT
// RESPONSE for an address that already exists. The code read a null user
// as an internal failure and reported it as "We couldn't record your
// agreement to the terms", on every attempt, forever.
//
// lib/auth/findExistingAuthUser.ts predicted this in its own header: "the
// caller misreads it as 'shouldn't happen', and the user can never sign up
// again with that email." It reached production because the fallback meant
// to prevent it — a PostgREST query against the auth schema — could never
// work, since Supabase does not expose that schema. Migration 0119
// replaces it with a SECURITY DEFINER RPC.

describe('signUp says "that email exists" without erroring', () => {
  it('the SILENT RESPONSE (user: null) is an existing account, not a failure', async () => {
    signUpSpy.mockResolvedValue({ data: { user: null }, error: null });

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already exists/i);
    expect(res.error).toMatch(/sign in/i);
    // The regression this guards: it must NOT be reported as a terms
    // failure, and must NOT quote an internal reference.
    expect(res.error).not.toMatch(/agreement to the terms/i);
    expect(res.error).not.toMatch(/NOUSER|reference/i);
  });

  it('offers the recovery route, since they may not recall signing up', async () => {
    signUpSpy.mockResolvedValue({ data: { user: null }, error: null });
    const res = await signUpPatient(VALID);
    expect(res.error).toMatch(/forgot password/i);
  });

  it('creates nothing and deletes nothing on that branch', async () => {
    signUpSpy.mockResolvedValue({ data: { user: null }, error: null });

    await signUpPatient(VALID);

    // No account was made, so there is nothing to roll back — the old
    // code called deleteUser on an id it never had.
    expect(deleteUserSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('the obfuscated fake user (identities: []) gets the same answer', async () => {
    signUpSpy.mockResolvedValue({ data: { user: { id: 'fake', identities: [] } }, error: null });

    const res = await signUpPatient(VALID);

    expect(res.error).toMatch(/already exists/i);
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it('a real new user is still a real new user', async () => {
    // The guard must key on the ABSENCE of an identity, not merely on
    // truthiness, or every genuine signup would be refused.
    row = { id: 'new-user-id', terms_accepted_at: null };
    signUpSpy.mockResolvedValue(freshUser());

    const res = await signUpPatient(VALID);

    expect(res.success).toBe(true);
  });
});
