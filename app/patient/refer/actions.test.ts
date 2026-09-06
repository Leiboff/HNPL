import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Behavioural tests — the two referral writes ─────────────────────────
//
// These actions are the entire authorisation boundary for the referral
// system: `referrals` and `referral_codes` have SELECT policies and no write
// policies at all (migration 0145), so nothing else can write them and
// nothing else can get this wrong.
//
// What is asserted, therefore, is mostly about what does NOT happen: a
// caller who is not a patient writes nothing; a caller's own input never
// reaches referrer_id, status or referred_profile_id; a failed referral
// insert does not erase a lead a rep is going to work.
//
// There is no friend action to test, and that absence is itself pinned below:
// the friend side is the shareable link, recorded by lib/referrals/claim.ts
// when the friend arrives, so this module must not grow a mail-sending
// endpoint again without the UI to justify it.
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

let budgetAvailable = true;
const budgetCalls: Array<{ bucket: string; subjects: unknown[] }> = [];

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
    ilike(col: string, value: string) { filters.push([col, value]); return selectApi; },
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

import { ensureMyReferralCode, referADoctor, type ReferDoctorInput } from './actions';

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
  budgetCalls.length = 0;
  budgetAvailable = true;
  authUser.value = null;
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.betternow.test';
  delete process.env.CRM_INBOUND_OWNER_EMAIL;
});

// ─────────────────────────────────────────────────────────────────────────

/** A complete, valid doctor referral. Individual tests spread over it. */
const ADDRESS = {
  formattedAddress: '12 Sturdee Ave, Rosebank, Johannesburg, 2196',
  streetAddress:    '12 Sturdee Ave',
  suburb:           'Rosebank',
  city:             'Johannesburg',
  province:         'Gauteng',
  latitude:         -26.1445,
  longitude:        28.0416,
};

const INPUT: ReferDoctorInput = {
  doctorName:   'Dr Ayanda Naidoo',
  specialty:    'General Dental Practitioner',
  phone:        '011 555 1234',
  address:      ADDRESS,
  practiceName: 'Rosebank Dental',
  email:        'rooms@rosebankdental.test',
  note:         'They asked me how I was paying.',
};

describe('the caller is re-verified server-side, every time', () => {
  it('an anonymous caller writes nothing', async () => {
    expect(await ensureMyReferralCode()).toEqual({ error: 'Not available for this account.' });
    expect(await referADoctor(INPUT)).toMatchObject({ ok: false });
    expect(db.referrals).toHaveLength(0);
    expect(db.crm_leads).toHaveLength(0);
  });

  it('a practice account is refused even with a valid session', async () => {
    // The screen is patient-only, and a Server Action is an HTTP endpoint the
    // screen does not guard. This is the check that counts.
    authUser.value = { id: 'practice-uuid', email: 'rooms@example.com' };
    db.profiles.push({ id: 'practice-uuid', role: 'practice_admin', first_name: 'Ayesha' });
    expect(await referADoctor(INPUT)).toMatchObject({ ok: false });
    expect(db.referrals).toHaveLength(0);
    expect(db.crm_leads).toHaveLength(0);
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

describe('the friend side is a link, not an endpoint', () => {
  it('this module exports no action that emails a stranger', async () => {
    // The friend half of the screen is the shareable code and nothing else,
    // so there is no server action behind it — a friend referral is written
    // by lib/referrals/claim.ts when the friend ARRIVES. A 'use server'
    // export is an HTTP endpoint whether or not anything renders it, and one
    // that puts mail into an uninvolved person's inbox must not come back
    // without a UI that justifies it.
    const mod = await import('./actions');
    expect(Object.keys(mod).sort()).toEqual(['ensureMyReferralCode', 'referADoctor']);
  });
});

describe('referADoctor', () => {
  it('creates the CRM lead a rep works, and the referral the patient sees', async () => {
    signInAsPatient();
    const result = await referADoctor(INPUT);
    expect(result).toMatchObject({ ok: true });

    expect(db.crm_leads).toHaveLength(1);
    expect(db.crm_leads[0]).toMatchObject({
      practice_name:      'Rosebank Dental',
      // 'Dr' is a title, not a given name — splitFullName strips it.
      contact_first_name: 'Ayanda',
      contact_last_name:  'Naidoo',
      specialty:          'General Dental Practitioner',
      email:              'rooms@rosebankdental.test',
      phone:              '+27115551234',
      street_address:     '12 Sturdee Ave',
      suburb:             'Rosebank',
      city:               'Johannesburg',
      province:           'Gauteng',
      latitude:           -26.1445,
      longitude:          28.0416,
      formatted_address:  ADDRESS.formattedAddress,
      source:             'referral',
      stage:              'new',
      owner_user_id:      null,
    });

    expect(db.referrals).toHaveLength(1);
    expect(db.referrals[0]).toMatchObject({
      referrer_id:   PATIENT,
      // The kind records what the referral CONVERTS INTO — a practice trading
      // on this platform — not the label on the form. See referADoctor.
      kind:          'practice',
      channel:       'invite',
      status:        'pending',
      practice_name: 'Rosebank Dental',
      invitee_name:  'Dr Ayanda Naidoo',
      invitee_phone: '+27115551234',
      crm_lead_id:   db.crm_leads[0].id,
    });
    expect(new Date(String(db.referrals[0].expires_at)).getTime())
      .toBeGreaterThan(Date.now());
  });

  it('never lets the caller decide the columns that matter', async () => {
    signInAsPatient();
    await referADoctor({
      // A crafted payload: the action's input type has seven fields, and a
      // Server Action is an HTTP endpoint, so nothing stops extra keys
      // arriving on the wire.
      ...({ referrer_id: 'someone-else', status: 'converted', qualified_at: 'now' } as object),
      ...INPUT,
    } as ReferDoctorInput);

    const row = db.referrals[0];
    expect(row.referrer_id).toBe(PATIENT);
    expect(row.status).toBe('pending');
    expect(row.qualified_at).toBeUndefined();
    expect(row.referred_profile_id).toBeUndefined();
  });

  it('assigns the configured inbound owner so sales RLS exposes the lead', async () => {
    signInAsPatient();
    db.profiles.push({
      id: 'sales-uuid', role: 'sales', email: 'rep@example.com', first_name: 'Rep',
    });
    process.env.CRM_INBOUND_OWNER_EMAIL = ' REP@example.com ';

    await referADoctor(INPUT);

    expect(db.crm_leads[0].owner_user_id).toBe('sales-uuid');
  });

  it('puts the patient’s own words on the lead, labelled as a patient referral', async () => {
    signInAsPatient();
    await referADoctor(INPUT);
    expect(db.crm_activities).toHaveLength(1);
    expect(db.crm_activities[0]).toMatchObject({
      lead_id: db.crm_leads[0].id,
      type:    'note',
      title:   'Referred by a patient',
      body:    'They asked me how I was paying.',
    });
  });

  it('neutralises a formula in every free-text field, the address included', async () => {
    // These rows are exported to CSV from the CRM. A leading '=' is a formula
    // in somebody's spreadsheet — the same treatment the public lead form
    // applies, for the same reason. The address is no exception: it arrives
    // over the wire like everything else.
    signInAsPatient();
    await referADoctor({
      ...INPUT,
      doctorName:   '=cmd|calc',
      practiceName: '+1+1',
      note:         '@SUM(A1)',
      address:      { ...ADDRESS, formattedAddress: '=HYPERLINK("x")', suburb: '-2' },
    });
    const lead = db.crm_leads[0];
    expect(String(lead.practice_name).startsWith('+')).toBe(false);
    expect(String(lead.contact_last_name).startsWith('=')).toBe(false);
    expect(String(lead.formatted_address).startsWith('=')).toBe(false);
    expect(String(lead.suburb).startsWith('-')).toBe(false);
    expect(String(db.crm_activities[0].body).startsWith('@')).toBe(false);
  });

  // ── The four compulsory fields ──────────────────────────────────────────
  //
  // Each is refused BEFORE any budget is spent and before any row is written,
  // because a lead a rep cannot name, classify, phone or find is not a lead.

  it('requires the doctor’s name', async () => {
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, doctorName: '   ' }))
      .toMatchObject({ ok: false, field: 'doctorName' });
    expect(db.crm_leads).toHaveLength(0);
    expect(budgetCalls).toHaveLength(0);
  });

  it('requires a specialty', async () => {
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, specialty: '' }))
      .toMatchObject({ ok: false, field: 'specialty' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('refuses a specialty that is not on the shared register', async () => {
    // crm_leads.specialty is free text (bulk imports keep unrecognised labels
    // verbatim), but the only writer on THIS path is a dropdown built from
    // lib/specialties.ts. Anything else arrived from a crafted payload and
    // would land in a rep's filters as a value nothing else can match.
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, specialty: 'Wizard' }))
      .toMatchObject({ ok: false, field: 'specialty' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('requires a phone number — email is no longer an alternative', async () => {
    // The old rule was email-OR-phone, which produced leads with an address
    // nobody answers. The rep's next action is a call.
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, phone: '' }))
      .toMatchObject({ ok: false, field: 'phone' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('refuses a phone number that is not a South African one', async () => {
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, phone: '12345' }))
      .toMatchObject({ ok: false, field: 'phone' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('accepts a landline, because a practice switchboard is one', async () => {
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, phone: '011 555 1234' })).toMatchObject({ ok: true });
    expect(db.crm_leads[0].phone).toBe('+27115551234');
  });

  it('requires an address that was actually picked', async () => {
    // PlacesAutocomplete only reports a place once it is CHOSEN, so an empty
    // formattedAddress means nothing was picked — typed text never reaches
    // the action at all.
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, address: { ...ADDRESS, formattedAddress: '  ' } }))
      .toMatchObject({ ok: false, field: 'address' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('refuses coordinates outside South Africa', async () => {
    // A real pick always lands inside the box, so a pair that does not either
    // came from somewhere other than the dropdown or names a practice we
    // cannot onboard. Pinning a lead on the wrong continent is the failure
    // lib/maps/saBounds.ts exists to prevent.
    signInAsPatient();
    expect(await referADoctor({
      ...INPUT, address: { ...ADDRESS, latitude: 51.5, longitude: -0.12 },
    })).toMatchObject({ ok: false, field: 'address' });
    expect(db.crm_leads).toHaveLength(0);
  });

  it('takes the address without coordinates rather than refusing it', async () => {
    signInAsPatient();
    expect(await referADoctor({
      ...INPUT, address: { ...ADDRESS, latitude: null, longitude: null },
    })).toMatchObject({ ok: true });
    expect(db.crm_leads[0].latitude).toBeNull();
  });

  // ── The optional three ──────────────────────────────────────────────────

  it('falls back to the doctor’s name when the rooms have none the patient knows', async () => {
    // crm_leads.practice_name and 0145's referrals_practice_named are both
    // NOT NULL, and a patient very often does not know what the rooms trade
    // as. The doctor's name is the honest stand-in — it is what the rep asks
    // for on the phone.
    signInAsPatient();
    await referADoctor({ ...INPUT, practiceName: '' });
    expect(db.crm_leads[0].practice_name).toBe('Dr Ayanda Naidoo');
    expect(db.referrals[0].practice_name).toBe('Dr Ayanda Naidoo');
  });

  it('carries a one-word name on the surname alone', async () => {
    // splitFullName puts a single token in BOTH columns — right for the bulk
    // imports it was written for, and here it would render "Naidoo Naidoo".
    signInAsPatient();
    await referADoctor({ ...INPUT, doctorName: 'Dr Naidoo' });
    expect(db.crm_leads[0]).toMatchObject({
      contact_first_name: '', contact_last_name: 'Naidoo',
    });
  });

  it('accepts a referral with no email address', async () => {
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, email: '' })).toMatchObject({ ok: true });
    expect(db.crm_leads[0].email).toBeNull();
    expect(db.referrals[0].invitee_email).toBeNull();
  });

  it('refuses a malformed email rather than storing it', async () => {
    signInAsPatient();
    expect(await referADoctor({ ...INPUT, email: 'not-an-address' }))
      .toMatchObject({ ok: false, field: 'email' });
    expect(db.crm_leads).toHaveLength(0);
  });

  // ── Budget, and the two failure orders ──────────────────────────────────

  it('spends both the IP and the account budget', async () => {
    signInAsPatient();
    await referADoctor(INPUT);
    expect(budgetCalls[0].bucket).toBe('referral_invite');
    expect(budgetCalls[0].subjects).toHaveLength(2);
    expect((budgetCalls[0].subjects as Array<[string, unknown]>)[1][0]).toBe(PATIENT);
  });

  it('writes nothing once the budget is spent', async () => {
    signInAsPatient();
    budgetAvailable = false;
    expect(await referADoctor(INPUT)).toMatchObject({ ok: false });
    expect(db.crm_leads).toHaveLength(0);
    expect(db.referrals).toHaveLength(0);
  });

  it('keeps the lead when the referral row cannot be written', async () => {
    // The lead is what gets the practice called. Reporting failure would ask
    // the patient to try again and create a second lead for the same rooms.
    signInAsPatient();
    insertFailures.referrals = [{ code: 'XX000', message: 'boom' }];
    const result = await referADoctor(INPUT);
    expect(result).toMatchObject({ ok: true });
    expect(db.crm_leads).toHaveLength(1);
    expect(db.referrals).toHaveLength(0);
    // And the database's own words never reach the screen.
    expect(JSON.stringify(result)).not.toContain('boom');
  });

  it('writes no referral when the lead itself fails', async () => {
    signInAsPatient();
    insertFailures.crm_leads = [{ code: 'XX000', message: 'boom' }];
    expect(await referADoctor(INPUT)).toMatchObject({ ok: false });
    expect(db.referrals).toHaveLength(0);
  });
});

describe('nothing here touches the incentive seam', () => {
  it('no action sets qualified_at on any row it writes', async () => {
    signInAsPatient();
    await referADoctor(INPUT);
    expect(db.referrals).toHaveLength(1);
    for (const row of db.referrals) {
      expect(row.qualified_at, 'an action stamped the incentive seam').toBeUndefined();
    }
  });
});
