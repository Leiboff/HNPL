import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Behavioural tests — the three referral writes ───────────────────────
//
// These actions are the entire authorisation boundary for the referral
// system: `referrals` and `referral_codes` have SELECT policies and no write
// policies at all (migration 0145), so nothing else can write them and
// nothing else can get this wrong.
//
// What is asserted, therefore, is mostly about what does NOT happen: a
// caller who is not a patient writes nothing; a caller's own input never
// reaches referrer_id, status or referred_profile_id; a failed email does not
// erase a recorded referral; a failed referral insert does not erase a lead a
// rep is going to work.
//
// The Supabase client is a small in-memory fake rather than a mock of the
// fluent builder — a mock of a builder tests the mock. This one holds rows,
// so an assertion can read back exactly what the action wrote.

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {
  profiles: [], referral_codes: [], referrals: [], crm_leads: [], crm_activities: [],
};

/** Errors to raise on the NEXT insert into a given table, in order. */
const insertFailures: Record<string, Array<{ code?: string; message: string } | null>> = {};

const sent: Array<Record<string, unknown>> = [];
let sendResult: { ok: true; id: string } | { ok: false; error: string } = { ok: true, id: 'e1' };

let budgetAvailable = true;
const budgetCalls: Array<{ bucket: string; subjects: unknown[] }> = [];

vi.mock('@/lib/email/resend', () => ({
  sendEmail: async (input: Record<string, unknown>) => { sent.push(input); return sendResult; },
}));

vi.mock('@/lib/security/rateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/rateLimit')>();
  return {
    ...actual,
    clientIp: async () => '203.0.113.7',
    consumeAll: async (bucket: string, subjects: unknown[]) => {
      budgetCalls.push({ bucket, subjects });
      return budgetAvailable;
    },
  };
});

const authUser: { value: { id: string; email: string | null } | null } = { value: null };
vi.mock('@/lib/auth/requestUser', () => ({
  getRequestUser: async () => authUser.value,
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// ─── The fake ────────────────────────────────────────────────────────────
//
// Supports exactly the shapes the actions use: select/eq/is/maybeSingle,
// select/eq/single, insert (awaited), and insert().select().single().
// Anything else throws, so a new query shape shows up as a failing test
// rather than as a silent `undefined`.

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([col, value]) => row[col] === value
    || (value === null && (row[col] === null || row[col] === undefined)));
}

function table(name: string) {
  if (!(name in db)) throw new Error(`unexpected table: ${name}`);
  const filters: Array<[string, unknown]> = [];

  const selectApi = {
    eq(col: string, value: unknown) { filters.push([col, value]); return selectApi; },
    is(col: string, value: unknown) { filters.push([col, value]); return selectApi; },
    order() { return selectApi; },
    limit() { return selectApi; },
    async maybeSingle() {
      const found = db[name].find((r) => matches(r, filters));
      return { data: found ?? null, error: null };
    },
    async single() {
      const found = db[name].find((r) => matches(r, filters));
      return found
        ? { data: found, error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    },
  };

  return {
    select() { return selectApi; },
    insert(row: Row | Row[]) {
      const rows = Array.isArray(row) ? row : [row];
      const failure = insertFailures[name]?.shift() ?? null;

      const commit = () => {
        if (failure) return { data: null, error: failure };
        const stored = rows.map((r) => ({ id: `${name}-${db[name].length + 1}`, ...r }));
        db[name].push(...stored);
        return { data: stored, error: null };
      };

      const api = {
        select() {
          return {
            async single() {
              const res = commit();
              return res.error
                ? { data: null, error: res.error }
                : { data: (res.data as Row[])[0], error: null };
            },
            async maybeSingle() {
              const res = commit();
              return res.error
                ? { data: null, error: res.error }
                : { data: (res.data as Row[])[0], error: null };
            },
          };
        },
        // Awaiting the insert directly, with no .select().
        then(resolve: (v: unknown) => unknown) {
          const res = commit();
          return Promise.resolve(res.error ? { error: res.error } : { error: null }).then(resolve);
        },
      };
      return api;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (name: string) => table(name) }),
}));

import { ensureMyReferralCode, referAFriend, referAPractice } from './actions';

const PATIENT = 'patient-uuid';

function signInAsPatient(over: Row = {}) {
  authUser.value = { id: PATIENT, email: 'thandi@example.com' };
  db.profiles.push({
    id: PATIENT, role: 'patient', first_name: 'Thandi', email: 'thandi@example.com', ...over,
  });
}

beforeEach(() => {
  for (const key of Object.keys(db)) db[key] = [];
  for (const key of Object.keys(insertFailures)) delete insertFailures[key];
  sent.length = 0;
  budgetCalls.length = 0;
  sendResult = { ok: true, id: 'e1' };
  budgetAvailable = true;
  authUser.value = null;
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.betternow.test';
});

// ─────────────────────────────────────────────────────────────────────────

describe('the caller is re-verified server-side, every time', () => {
  it('an anonymous caller writes nothing', async () => {
    expect(await ensureMyReferralCode()).toEqual({ error: 'Not available for this account.' });
    expect(await referAFriend({ name: '', email: 'x@example.com' })).toMatchObject({ ok: false });
    expect(await referAPractice({
      practiceName: 'X', contactName: '', email: 'x@example.com', phone: '', suburb: '', note: '',
    })).toMatchObject({ ok: false });
    expect(db.referrals).toHaveLength(0);
    expect(db.crm_leads).toHaveLength(0);
  });

  it('a practice account is refused even with a valid session', async () => {
    // The screen is patient-only, and a Server Action is an HTTP endpoint the
    // screen does not guard. This is the check that counts.
    authUser.value = { id: 'practice-uuid', email: 'rooms@example.com' };
    db.profiles.push({ id: 'practice-uuid', role: 'practice_admin', first_name: 'Ayesha' });
    expect(await referAFriend({ name: '', email: 'x@example.com' })).toMatchObject({ ok: false });
    expect(db.referrals).toHaveLength(0);
  });

  it('a session with no profile row is refused', async () => {
    authUser.value = { id: 'ghost', email: 'ghost@example.com' };
    expect(await ensureMyReferralCode()).toEqual({ error: 'Not available for this account.' });
  });
});

describe('ensureMyReferralCode', () => {
  it('mints a well-formed code on the first call', async () => {
    signInAsPatient();
    const result = await ensureMyReferralCode();
    expect(result).toHaveProperty('code');
    expect((result as { code: string }).code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{8}$/);
    expect(db.referral_codes).toHaveLength(1);
    expect(db.referral_codes[0]).toMatchObject({ owner_id: PATIENT });
  });

  it('returns the existing live code rather than minting a second', async () => {
    signInAsPatient();
    db.referral_codes.push({ id: 'c1', owner_id: PATIENT, code: 'A2C4K9PT', revoked_at: null });
    expect(await ensureMyReferralCode()).toEqual({ code: 'A2C4K9PT' });
    expect(db.referral_codes).toHaveLength(1);
  });

  it('retries a code collision and succeeds', async () => {
    // 23505 from the global code index means the draw collided. The retry
    // uses a different draw; five in a row would mean the generator is broken.
    signInAsPatient();
    insertFailures.referral_codes = [{ code: '23505', message: 'duplicate key' }];
    const result = await ensureMyReferralCode();
    expect(result).toHaveProperty('code');
    expect(db.referral_codes).toHaveLength(1);
  });

  it('reports a non-collision failure rather than looping', async () => {
    signInAsPatient();
    insertFailures.referral_codes = [{ code: '42501', message: 'permission denied' }];
    expect(await ensureMyReferralCode()).toHaveProperty('error');
    // And the message never carries the database's own words.
    expect(JSON.stringify(await ensureMyReferralCode())).not.toContain('permission denied');
  });
});

describe('referAFriend', () => {
  it('records the invitation and sends exactly one email', async () => {
    signInAsPatient();
    const result = await referAFriend({ name: 'Sipho Dlamini', email: 'Sipho@Example.com ' });
    expect(result).toMatchObject({ ok: true });

    expect(db.referrals).toHaveLength(1);
    expect(db.referrals[0]).toMatchObject({
      referrer_id:   PATIENT,
      kind:          'patient',
      channel:       'invite',
      status:        'pending',
      invitee_email: 'sipho@example.com',   // normalised on the way in
      invitee_name:  'Sipho Dlamini',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('sipho@example.com');
  });

  it('never lets the caller decide the columns that matter', async () => {
    signInAsPatient();
    await referAFriend({
      // A crafted payload: the action's input type has two fields, and a
      // Server Action is an HTTP endpoint, so nothing stops extra keys
      // arriving on the wire.
      ...({ referrer_id: 'someone-else', status: 'converted', qualified_at: 'now' } as object),
      name: 'Sipho', email: 'sipho@example.com',
    } as Parameters<typeof referAFriend>[0]);

    const row = db.referrals[0];
    expect(row.referrer_id).toBe(PATIENT);
    expect(row.status).toBe('pending');
    expect(row.qualified_at).toBeUndefined();
    expect(row.referred_profile_id).toBeUndefined();
  });

  it('the invitation link carries the referrer’s own code', async () => {
    signInAsPatient();
    db.referral_codes.push({ id: 'c1', owner_id: PATIENT, code: 'A2C4K9PT', revoked_at: null });
    await referAFriend({ name: '', email: 'sipho@example.com' });
    expect(String(sent[0].html)).toContain('https://app.betternow.test/?ref=A2C4K9PT');
  });

  it('refuses an invalid address before spending any budget', async () => {
    signInAsPatient();
    const result = await referAFriend({ name: '', email: 'not-an-address' });
    expect(result).toMatchObject({ ok: false, field: 'email' });
    expect(budgetCalls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('refuses the caller’s own address, and says why', async () => {
    // Not fraud — a person testing their own link. The honest answer is to
    // say so rather than to email them an invitation to themselves.
    signInAsPatient();
    const result = await referAFriend({ name: '', email: 'THANDI@example.com' });
    expect(result).toMatchObject({ ok: false, field: 'email' });
    expect(String((result as { error: string }).error)).toMatch(/your own email/i);
    expect(sent).toHaveLength(0);
  });

  it('spends both the IP and the account budget', async () => {
    signInAsPatient();
    await referAFriend({ name: '', email: 'sipho@example.com' });
    expect(budgetCalls[0].bucket).toBe('referral_invite');
    expect(budgetCalls[0].subjects).toHaveLength(2);
    expect((budgetCalls[0].subjects as Array<[string, unknown]>)[1][0]).toBe(PATIENT);
  });

  it('sends nothing once the budget is spent', async () => {
    signInAsPatient();
    budgetAvailable = false;
    expect(await referAFriend({ name: '', email: 'sipho@example.com' })).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
    expect(db.referrals).toHaveLength(0);
  });

  it('reports a repeat invitation as a repeat, not as a failure', async () => {
    signInAsPatient();
    insertFailures.referrals = [{ code: '23505', message: 'duplicate key' }];
    const result = await referAFriend({ name: '', email: 'sipho@example.com' });
    expect(result).toMatchObject({ ok: false, field: 'email' });
    expect(String((result as { error: string }).error)).toMatch(/already invited/i);
  });

  it('keeps the referral when the email fails, and says so honestly', async () => {
    // A referral we recorded and failed to deliver is recoverable — the link
    // still works. One we refused to record because Resend was down is not.
    signInAsPatient();
    sendResult = { ok: false, error: 'resend exploded' };
    const result = await referAFriend({ name: '', email: 'sipho@example.com' });
    expect(result).toMatchObject({ ok: true });
    expect(db.referrals).toHaveLength(1);
    expect((result as { message: string }).message).toMatch(/could not send/i);
    // And the provider's own words never reach the screen.
    expect((result as { message: string }).message).not.toContain('resend exploded');
  });
});

describe('referAPractice', () => {
  const INPUT = {
    practiceName: 'Rosebank Dental',
    contactName:  'Dr Naidoo',
    email:        'rooms@rosebankdental.test',
    phone:        '',
    suburb:       'Rosebank',
    note:         'They asked me how I was paying.',
  };

  it('creates the CRM lead a rep works, and the referral the patient sees', async () => {
    signInAsPatient();
    const result = await referAPractice(INPUT);
    expect(result).toMatchObject({ ok: true });

    expect(db.crm_leads).toHaveLength(1);
    expect(db.crm_leads[0]).toMatchObject({
      practice_name:      'Rosebank Dental',
      contact_first_name: 'Dr',
      contact_last_name:  'Naidoo',
      email:              'rooms@rosebankdental.test',
      suburb:             'Rosebank',
      source:             'referral',
      stage:              'new',
    });

    expect(db.referrals).toHaveLength(1);
    expect(db.referrals[0]).toMatchObject({
      referrer_id:   PATIENT,
      kind:          'practice',
      channel:       'invite',
      status:        'pending',
      practice_name: 'Rosebank Dental',
      crm_lead_id:   db.crm_leads[0].id,
    });
  });

  it('puts the patient’s own words on the lead, labelled as a patient referral', async () => {
    signInAsPatient();
    await referAPractice(INPUT);
    expect(db.crm_activities).toHaveLength(1);
    expect(db.crm_activities[0]).toMatchObject({
      lead_id: db.crm_leads[0].id,
      type:    'note',
      title:   'Referred by a patient',
      body:    'They asked me how I was paying.',
    });
  });

  it('neutralises a formula in every free-text field', async () => {
    // These rows are exported to CSV from the CRM. A leading '=' is a formula
    // in somebody's spreadsheet — the same treatment the public lead form
    // applies, for the same reason.
    signInAsPatient();
    await referAPractice({ ...INPUT, practiceName: '=cmd|calc', suburb: '+1+1', note: '@SUM(A1)' });
    const lead = db.crm_leads[0];
    expect(String(lead.practice_name).startsWith('=')).toBe(false);
    expect(String(lead.suburb).startsWith('+')).toBe(false);
    expect(String(db.crm_activities[0].body).startsWith('@')).toBe(false);
  });

  it('requires a practice name', async () => {
    signInAsPatient();
    expect(await referAPractice({ ...INPUT, practiceName: '   ' }))
      .toMatchObject({ ok: false, field: 'practiceName' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('requires some way to reach them', async () => {
    signInAsPatient();
    expect(await referAPractice({ ...INPUT, email: '', phone: '' }))
      .toMatchObject({ ok: false, field: 'email' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('accepts a landline, because a practice switchboard is one', async () => {
    signInAsPatient();
    const result = await referAPractice({ ...INPUT, email: '', phone: '011 555 1234' });
    expect(result).toMatchObject({ ok: true });
    expect(db.crm_leads[0].phone).toBe('+27115551234');
  });

  it('refuses a phone number that is not a South African one', async () => {
    signInAsPatient();
    expect(await referAPractice({ ...INPUT, email: '', phone: '12345' }))
      .toMatchObject({ ok: false, field: 'phone' });
  });

  it('keeps the lead when the referral row cannot be written', async () => {
    // The lead is what gets the practice called. Reporting failure would ask
    // the patient to try again and create a second lead for the same rooms.
    signInAsPatient();
    insertFailures.referrals = [{ code: 'XX000', message: 'boom' }];
    const result = await referAPractice(INPUT);
    expect(result).toMatchObject({ ok: true });
    expect(db.crm_leads).toHaveLength(1);
    expect(db.referrals).toHaveLength(0);
  });

  it('writes no referral when the lead itself fails', async () => {
    signInAsPatient();
    insertFailures.crm_leads = [{ code: 'XX000', message: 'boom' }];
    expect(await referAPractice(INPUT)).toMatchObject({ ok: false });
    expect(db.referrals).toHaveLength(0);
  });
});

describe('nothing here touches the incentive seam', () => {
  it('no action sets qualified_at on any row it writes', async () => {
    signInAsPatient();
    await referAFriend({ name: '', email: 'sipho@example.com' });
    await referAPractice({
      practiceName: 'P', contactName: '', email: 'p@example.test',
      phone: '', suburb: '', note: '',
    });
    for (const row of db.referrals) {
      expect(row.qualified_at, 'an action stamped the incentive seam').toBeUndefined();
    }
  });
});
