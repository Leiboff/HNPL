import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import { VALID_SA_IDS } from '@/lib/testing/saIdFixtures';

// ─── SA ID mandatory on every bill; QR/email as a delivery toggle ────────
//
// The decided model: the SA ID is the CUSTOMER key, QR and email are
// DELIVERY methods. Before this the two surfaces disagreed — the till took
// an ID and bound nobody, the dashboard took an email and bound from it.
//
// This file drives BOTH server actions through the same five-case table
// with the same mocked database, which is the point: a rule that lives in
// one shared module can be proven to hold on both surfaces rather than
// asserted twice. lib/patients/billIdentity.test.ts covers the decision in
// isolation; here it is wired to real inserts.

const SA_ID       = VALID_SA_IDS[0];
const OTHER_SA_ID = VALID_SA_IDS[1];

beforeAll(() => {
  process.env.SA_ID_ENCRYPTION_KEY  = randomBytes(32).toString('base64');
  process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
  process.env.NEXT_PUBLIC_APP_URL   = 'https://app.test';
});

// ── The world the actions run against ───────────────────────────────────

type Account = { id: string; email: string | null; first_name?: string; last_name?: string };

/** Set per test: who the ID lookup finds, and who the email lookup finds. */
let idOwner:    Account | null = null;
let emailOwner: Account | null = null;

const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
const emailsSent: Array<{ kind: string; to: string }> = [];

vi.mock('@/lib/practice/tradingGate', () => ({
  checkTradingGate: vi.fn(async () => ({ ok: true })),
  PENDING_APPROVAL_MESSAGE: 'x',
  NO_PROVIDERS_MESSAGE: 'x',
}));

vi.mock('@/lib/auth/tillDevice', () => ({
  requireUnlockedDevice: vi.fn(async () => ({
    ok: true, practiceId: 'practice-1', deviceId: 'device-1',
  })),
  hashTillSecret: vi.fn(), generateDeviceSecret: vi.fn(),
  PIN_MAX_ATTEMPTS: 5, PIN_LOCKOUT_MS: 1000,
}));

vi.mock('@/lib/email/templates/patientInvitation', () => ({
  sendPatientInvitationEmail: vi.fn(async ({ to }: { to: string }) => {
    emailsSent.push({ kind: 'invitation', to });
    return { ok: true };
  }),
}));

vi.mock('@/lib/email/templates/existingPatientBill', () => ({
  sendExistingPatientBillEmail: vi.fn(async ({ to }: { to: string }) => {
    emailsSent.push({ kind: 'existing', to });
    return { ok: true };
  }),
}));

/**
 * A Supabase stub that answers the two identity lookups by which COLUMN
 * was filtered on, so the ID path and the email path can disagree — which
 * is the entire subject of this file.
 */
function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    rpc: async () => ({ data: 'INV-0001', error: null }),
    from(table: string) {
      const filters: Record<string, unknown> = {};

      const chain: Record<string, unknown> = {
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        select: () => chain,
        eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
        gte: async () => ({ data: [], error: null }),
        order: () => chain,
        limit: async () => {
          // findPatientBySaId: profiles filtered on the blind index.
          if (table === 'profiles' && 'sa_id_lookup_hash' in filters) {
            return { data: idOwner ? [idOwner] : [], error: null };
          }
          if (table === 'practice_members') {
            return { data: [{ practice_id: 'practice-1', created_at: '2026-01-01' }], error: null };
          }
          return { data: [], error: null };
        },
        maybeSingle: async () => {
          if (table === 'practice_members') {
            return { data: { user_id: 'provider-1', practice_id: 'practice-1' }, error: null };
          }
          if (table === 'practices') return { data: { name: 'Mock Practice', fee_percent: 6 }, error: null };
          if (table === 'profiles') {
            // The email lookup filters on email; the bound-name read filters on id.
            if ('email' in filters) return { data: emailOwner, error: null };
            if ('id' in filters) {
              const acct = [idOwner, emailOwner].find((a) => a?.id === filters.id) ?? null;
              return { data: acct, error: null };
            }
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'practices') return { data: { name: 'Mock Practice', fee_percent: 6 }, error: null };
          return { data: null, error: null };
        },
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => makeClient()) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => makeClient()) }));

import { createBill } from './actions';
import { issueCounterSession } from '@/app/practice/pos/actions';

beforeEach(() => {
  inserts.length = 0;
  emailsSent.length = 0;
  idOwner = null;
  emailOwner = null;
});

const planRow  = () => inserts.find((i) => i.table === 'plans')?.row;
const appRow   = () => inserts.find((i) => i.table === 'applications')?.row;
const session  = () => inserts.find((i) => i.table === 'checkout_sessions')?.row;
const invite   = () => inserts.find((i) => i.table === 'patient_invitations')?.row;

const dashboard = (over: Record<string, unknown> = {}) =>
  createBill({
    saIdNumber: SA_ID, billAmount: 1000, providerMemberId: 'provider-1', ...over,
  } as Parameters<typeof createBill>[0]);

const till = (over: Record<string, unknown> = {}) =>
  issueCounterSession({
    deviceSecret: 'secret', saIdNumber: SA_ID, billAmount: 1000, providerMemberId: 'provider-1', ...over,
  } as Parameters<typeof issueCounterSession>[0]);

// ─── The ID is required, and validated where it counts ───────────────────

describe('the SA ID is mandatory on a dashboard bill', () => {
  it('rejects a missing ID SERVER-side, and writes nothing', async () => {
    const r = await dashboard({ saIdNumber: '' });
    expect(r.error).toMatch(/SA ID number/i);
    expect(inserts).toHaveLength(0);
  });

  it('rejects a checksum-invalid ID server-side', async () => {
    // 13 digits, right shape, wrong Luhn — the exact thing a client-side
    // check alone would let through if someone posted straight to the action.
    const r = await dashboard({ saIdNumber: '9001015800086' });
    expect(r.error).toBe('Enter a valid 13-digit SA ID number.');
    expect(inserts).toHaveLength(0);
  });

  it('rejects a date-invalid ID server-side', async () => {
    const r = await dashboard({ saIdNumber: '9013015800088' });
    expect(r.error).toBe('Enter a valid 13-digit SA ID number.');
    expect(inserts).toHaveLength(0);
  });
});

describe('the 18+ gate applies on BOTH surfaces', () => {
  // Was till-only. A dashboard that could issue a bill the till refuses is
  // the same asymmetry this task exists to remove.
  const minor = (() => {
    const now  = new Date();
    const yy   = String((now.getFullYear() - 5) % 100).padStart(2, '0');
    const base = `${yy}0101500008`;
    for (let c = 0; c < 10; c += 1) {
      const id = `${base}${c}`;
      let sum = 0, dbl = false;
      for (let i = id.length - 1; i >= 0; i--) {
        let d = id.charCodeAt(i) - 48;
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d; dbl = !dbl;
      }
      if (sum % 10 === 0) return id;
    }
    throw new Error('no valid minor ID');
  })();

  it('the dashboard refuses an under-18 ID', async () => {
    const r = await dashboard({ saIdNumber: minor });
    expect(r.error).toBe('The patient must be 18 or older.');
    expect(inserts).toHaveLength(0);
  });

  it('the till refuses the same ID', async () => {
    const r = await till({ saIdNumber: minor });
    expect(r.error).toBe('The patient must be 18 or older.');
    expect(inserts).toHaveLength(0);
  });
});

// ─── Delivery ────────────────────────────────────────────────────────────

describe('QR is the default on both surfaces, email is reachable on both', () => {
  it('the dashboard defaults to QR — a checkout_session, no invitation, no email', async () => {
    const r = await dashboard();
    expect(r.error).toBeNull();
    expect(session()).toBeTruthy();
    expect(invite()).toBeUndefined();
    expect(emailsSent).toHaveLength(0);
    expect(r.summary?.counterSession?.token).toBeTruthy();
  });

  it('the till defaults to QR — unchanged behaviour', async () => {
    const r = await till();
    expect(r.error).toBeNull();
    expect(r.token).toBeTruthy();
    expect(session()).toBeTruthy();
    expect(emailsSent).toHaveLength(0);
  });

  it('the dashboard can deliver by email', async () => {
    const r = await dashboard({ delivery: 'email', patientEmail: 'new@example.com' });
    expect(r.error).toBeNull();
    expect(invite()).toBeTruthy();
    expect(session()).toBeUndefined();
    expect(emailsSent).toEqual([{ kind: 'invitation', to: 'new@example.com' }]);
  });

  it('the till can deliver by email', async () => {
    const r = await till({ delivery: 'email', patientEmail: 'new@example.com' });
    expect(r.error).toBeNull();
    expect(r.token).toBeUndefined();
    expect(r.emailSent).toBe(true);
    expect(session()).toBeUndefined();
    expect(emailsSent).toEqual([{ kind: 'invitation', to: 'new@example.com' }]);
  });

  it('both write the SAME session TTL — one expiry authority for one table', async () => {
    await dashboard();
    const fromDashboard = session() as { expires_at: string };
    inserts.length = 0;
    await till();
    const fromTill = session() as { expires_at: string };
    const delta = Math.abs(
      new Date(fromDashboard.expires_at).getTime() - new Date(fromTill.expires_at).getTime(),
    );
    expect(delta).toBeLessThan(5000);
  });
});

// ─── The five cases, end to end ──────────────────────────────────────────

describe('case B — ID and email resolve to the SAME account', () => {
  it('stamps BOTH plans.patient_id and applications.patient_id at issuance', async () => {
    idOwner = emailOwner = { id: 'acct-X', email: 'x@example.com', first_name: 'Xola', last_name: 'M' };
    const r = await dashboard({ delivery: 'email', patientEmail: 'x@example.com' });
    expect(r.error).toBeNull();
    expect(planRow()?.patient_id).toBe('acct-X');
    expect(appRow()?.patient_id).toBe('acct-X');
    // Bound → the dashboard email, not an invitation.
    expect(emailsSent).toEqual([{ kind: 'existing', to: 'x@example.com' }]);
  });

  it('binds on the till too, which it never used to do', async () => {
    idOwner = emailOwner = { id: 'acct-X', email: 'x@example.com' };
    const r = await till({ delivery: 'email', patientEmail: 'x@example.com' });
    expect(r.error).toBeNull();
    expect(planRow()?.patient_id).toBe('acct-X');
    expect(appRow()?.patient_id).toBe('acct-X');
  });
});

describe('case A — neither resolves', () => {
  it('issues UNBOUND, and the till session still carries the encrypted ID so checkout can claim it', async () => {
    const r = await till();
    expect(r.error).toBeNull();
    expect(planRow()?.patient_id).toBeNull();
    expect(appRow()?.patient_id).toBeNull();
    const s = session() as { sa_id_number: string };
    expect(s.sa_id_number).toMatch(/^v1:/);          // encrypted, never plaintext
    expect(s.sa_id_number).not.toContain(SA_ID);
  });

  it('the dashboard issues unbound too, and emails an invitation', async () => {
    const r = await dashboard({ delivery: 'email', patientEmail: 'new@example.com' });
    expect(r.error).toBeNull();
    expect(planRow()?.patient_id).toBeNull();
    expect(invite()).toBeTruthy();
  });
});

describe('case C — the ID resolves, the email does not', () => {
  it('QR: binds to the ID\'s account and proceeds', async () => {
    idOwner = { id: 'acct-X', email: 'x@example.com' };
    const r = await dashboard();
    expect(r.error).toBeNull();
    expect(planRow()?.patient_id).toBe('acct-X');
  });

  it('EMAIL to an address that is NOT the account\'s: REFUSED, nothing written', async () => {
    idOwner = { id: 'acct-X', email: 'x@example.com' };
    const r = await dashboard({ delivery: 'email', patientEmail: 'someone.else@example.com' });
    expect(r.error).toBeTruthy();
    expect(inserts).toHaveLength(0);
    expect(emailsSent).toHaveLength(0);
  });

  it('EMAIL to the account\'s OWN address: proceeds and binds', async () => {
    idOwner = { id: 'acct-X', email: 'x@example.com' };
    const r = await dashboard({ delivery: 'email', patientEmail: 'x@example.com' });
    expect(r.error).toBeNull();
    expect(planRow()?.patient_id).toBe('acct-X');
  });

  it('the till applies the identical rule', async () => {
    idOwner = { id: 'acct-X', email: 'x@example.com' };
    const refused = await till({ delivery: 'email', patientEmail: 'someone.else@example.com' });
    expect(refused.error).toBeTruthy();
    expect(inserts).toHaveLength(0);

    const allowed = await till({ delivery: 'email', patientEmail: 'x@example.com' });
    expect(allowed.error).toBeNull();
    expect(planRow()?.patient_id).toBe('acct-X');
  });
});

describe('cases D and E — refused, on both surfaces', () => {
  it('D: the email has an account, the ID does not → points at the ID field', async () => {
    emailOwner = { id: 'acct-Y', email: 'y@example.com' };
    const r = await dashboard({ delivery: 'email', patientEmail: 'y@example.com' });
    expect(r.error).toMatch(/ID number/i);
    expect(inserts).toHaveLength(0);
  });

  it('E: two different accounts → names both fields', async () => {
    idOwner    = { id: 'acct-X', email: 'x@example.com' };
    emailOwner = { id: 'acct-Y', email: 'y@example.com' };
    const r = await dashboard({ delivery: 'email', patientEmail: 'y@example.com' });
    expect(r.error).toMatch(/two different BetterNow accounts/i);
    expect(inserts).toHaveLength(0);
  });

  it('the till refuses D and E identically', async () => {
    emailOwner = { id: 'acct-Y', email: 'y@example.com' };
    expect((await till({ delivery: 'email', patientEmail: 'y@example.com' })).error).toBeTruthy();
    expect(inserts).toHaveLength(0);

    idOwner = { id: 'acct-X', email: 'x@example.com' };
    expect((await till({ delivery: 'email', patientEmail: 'y@example.com' })).error).toBeTruthy();
    expect(inserts).toHaveLength(0);
  });
});

// ─── Adversarial ─────────────────────────────────────────────────────────

describe('nothing about the matched account ever reaches the practice', () => {
  it('no refusal leaks the other account\'s email, name or id', async () => {
    const secrets = ['acct-X', 'acct-Y', 'x@example.com', 'y@example.com', 'Xola'];

    const refusals: string[] = [];
    idOwner = { id: 'acct-X', email: 'x@example.com', first_name: 'Xola', last_name: 'M' };
    refusals.push((await dashboard({ delivery: 'email', patientEmail: 'nope@example.com' })).error ?? '');
    idOwner = null;
    emailOwner = { id: 'acct-Y', email: 'y@example.com' };
    refusals.push((await dashboard({ delivery: 'email', patientEmail: 'y@example.com' })).error ?? '');
    idOwner = { id: 'acct-X', email: 'x@example.com' };
    refusals.push((await dashboard({ delivery: 'email', patientEmail: 'y@example.com' })).error ?? '');

    expect(refusals.every((m) => m.length > 0)).toBe(true);
    for (const msg of refusals) {
      for (const s of secrets) expect(msg).not.toContain(s);
    }
  });

  it('a QR bill bound by ID alone returns a MASKED id, never a name', async () => {
    // The practice proved it knows the ID and nothing else, so the ID is
    // all it gets back. A name here would be new information.
    idOwner = { id: 'acct-X', email: 'x@example.com', first_name: 'Xola', last_name: 'Mahlangu' };
    const r = await dashboard();
    expect(r.summary?.patientName).toMatch(/^•+\d{4}$/);
    expect(r.summary?.patientName).not.toMatch(/Xola|Mahlangu/);
    expect(JSON.stringify(r.summary)).not.toContain('x@example.com');
  });

  it('a QR response carries no patient identity at all beyond the masked id', async () => {
    idOwner = { id: 'acct-X', email: 'x@example.com', first_name: 'Xola', last_name: 'Mahlangu' };
    const r = await dashboard();
    const body = JSON.stringify(r);
    expect(body).not.toContain('acct-X');
    expect(body).not.toContain('Xola');
    expect(body).not.toContain(SA_ID);        // the plaintext ID never travels back
  });
});

describe('a typo\'d ID that lands on a real stranger never bills them by email', () => {
  it('refuses rather than binding, and writes nothing', async () => {
    // Reception means to bill the patient in front of them, fat-fingers a
    // digit, and it resolves to somebody else's account.
    idOwner = { id: 'acct-stranger', email: 'stranger@example.com' };
    const r = await dashboard({
      saIdNumber: OTHER_SA_ID, delivery: 'email', patientEmail: 'patient@example.com',
    });
    expect(r.error).toBeTruthy();
    expect(inserts).toHaveLength(0);
    expect(emailsSent).toHaveLength(0);
  });

  it('and never emails the stranger either', async () => {
    idOwner    = { id: 'acct-stranger', email: 'stranger@example.com' };
    emailOwner = { id: 'acct-Y', email: 'y@example.com' };
    await dashboard({ delivery: 'email', patientEmail: 'y@example.com' });
    expect(emailsSent).toHaveLength(0);
  });
});

// ─── Regression ──────────────────────────────────────────────────────────

describe('the till QR path is unchanged end to end', () => {
  it('still returns a token + expiry and writes the session with its device id', async () => {
    const r = await till();
    expect(r.error).toBeNull();
    expect(r.token).toHaveLength(64);
    expect(r.expiresAt).toBeTruthy();
    expect(r.planId).toBeTruthy();

    const s = session() as Record<string, unknown>;
    expect(s.issued_via_device_id).toBe('device-1');
    expect(s.practice_id).toBe('practice-1');
    expect(s.sa_id_number).toMatch(/^v1:/);
  });

  it('a dashboard QR session records NO device — the column is nullable for exactly this', async () => {
    await dashboard();
    expect((session() as Record<string, unknown>).issued_via_device_id).toBeNull();
  });

  it('the optional cell number still rides along on a till QR', async () => {
    await till({ cellNumber: '0821234567' });
    expect((session() as Record<string, unknown>).cell_e164).toBeTruthy();
  });
});
