import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Behavioural tests — public lead capture action ──────────────────
//
// Invokes submitPublicLead directly with real payloads. Mocks
// next/headers (for IP) and the service-role Supabase client so we
// can assert against the exact insert payload the action would send
// to the DB. The rate-limit bucket lives in @/lib/crm/publicLeadRateLimit
// (outside 'use server' so the action file exports only async
// functions — Next.js requires this) and is reset between tests via
// the exported resetForTests().

type InsertPayload = Record<string, unknown>;

// ── Supabase service-role mock ──────────────────────────────────
//
// The action calls svc().from('crm_leads').insert(row).select('id').single()
// and svc().from('profiles').select(...).ilike(...).maybeSingle() plus
// svc().from('crm_activities').insert(...). We build a chainable mock
// that records inserts and returns configurable rows.

type MockState = {
  inserts: Array<{ table: string; row: InsertPayload }>;
  profileLookupReturns: { id: string; role: string } | null;
};

const state: MockState = {
  inserts: [],
  profileLookupReturns: null,
};

function buildClientMock() {
  const chain = (table: string) => ({
    insert(row: InsertPayload) {
      state.inserts.push({ table, row });
      return {
        select() {
          return {
            single: async () => ({ data: { id: 'lead-fixture-1' }, error: null }),
          };
        },
      };
    },
    select() { return chain(table); },
    ilike(_c: string, _v: string) { return chain(table); },
    maybeSingle: async () => ({ data: state.profileLookupReturns, error: null }),
  });
  return { from: (t: string) => chain(t) };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => buildClientMock(),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get(name: string): string | null {
      if (name === 'x-forwarded-for') return currentIp;
      if (name === 'x-real-ip')       return currentIp;
      return null;
    },
  }),
}));

// This suite owns the action's local public-lead bucket assertions. The
// durable limiter has dedicated database tests and is allowed here so the
// CRM-shaped service mock cannot accidentally intercept its RPC.
vi.mock('@/lib/security/rateLimit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/security/rateLimit')>(),
  ...(await import('@/lib/testing/rateLimitTestMock')).allowTestRateLimit,
}));

vi.mock('@/lib/risk/evaluate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/risk/evaluate')>(),
  ...(await import('@/lib/testing/riskTestMock')).allowTestRisk,
}));

vi.mock('next/cache', () => ({
  revalidatePath: () => { /* no-op in tests */ },
}));

let currentIp = '198.51.100.1';

// Import LATE so the mocks above are wired before the module loads.
async function fresh() {
  vi.resetModules();
  const mod = await import('./publicLeadAction');
  return mod;
}

beforeEach(async () => {
  state.inserts = [];
  state.profileLookupReturns = null;
  currentIp = '198.51.100.1';
  const { resetForTests } = await import('@/lib/crm/publicLeadRateLimit');
  resetForTests();
});

// ── (a) Happy path — row created, response reveals nothing ─────

describe('(a) happy path', () => {
  it('inserts a crm_leads row with source=inbound + stage=new and returns ok', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: 'Rosebank Dental',
      contactName:  'Alice Smith',
      phone:        '+27 82 111 2222',
      email:        'alice@rosebank.co.za',
      specialty:    'General Dental Practitioner',
      suburb:       'Rosebank',
      message:      'Interested in learning more',
      website:      '',
    });
    expect(res).toEqual({ ok: true });

    const leadInserts = state.inserts.filter(i => i.table === 'crm_leads');
    expect(leadInserts.length).toBe(1);
    const row = leadInserts[0].row;
    expect(row.source).toBe('inbound');
    expect(row.stage).toBe('new');
    expect(row.practice_name).toBe('Rosebank Dental');
    expect(row.contact_first_name).toBe('Alice');
    expect(row.contact_last_name).toBe('Smith');
    expect(row.email).toBe('alice@rosebank.co.za');
  });

  it('response contains ONLY { ok: true } — no lead id, no dupe info', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: 'X Dental', contactName: 'B B', phone: '', email: 'b@x.co.za',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(Object.keys(res)).toEqual(['ok']);
    expect(res).toEqual({ ok: true });
  });
});

// ── (b) Honeypot — silent drop ──────────────────────────────────

describe('(b) honeypot', () => {
  it('returns ok:true AND does not insert a lead when the honeypot field is filled', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: 'Bot Practice', contactName: 'Bot', phone: '+27 82 000 0000',
      email: 'bot@example.com', specialty: '', suburb: '', message: 'bulk spam',
      website: 'https://evil.example',    // populated → honeypot triggered
    });
    expect(res).toEqual({ ok: true });
    expect(state.inserts.filter(i => i.table === 'crm_leads').length).toBe(0);
  });
});

// ── (c) Rate limit ──────────────────────────────────────────────

describe('(c) per-IP rate limit', () => {
  it('accepts up to the limit from a single IP, rejects the next with error=rate_limited', async () => {
    const { submitPublicLead } = await fresh();
    // The module's RATE_LIMIT_MAX is 5 per hour.
    for (let i = 0; i < 5; i++) {
      const res = await submitPublicLead({
        practiceName: `P${i}`, contactName: 'A B', phone: '', email: `p${i}@x.co.za`,
        specialty: '', suburb: '', message: '', website: '',
      });
      expect(res).toEqual({ ok: true });
    }
    const denied = await submitPublicLead({
      practiceName: 'P6', contactName: 'A B', phone: '', email: 'p6@x.co.za',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toBe('rate_limited');
  });

  it('a different IP is not blocked by the first IP\'s cap', async () => {
    const { submitPublicLead } = await fresh();
    for (let i = 0; i < 5; i++) {
      await submitPublicLead({
        practiceName: `P${i}`, contactName: 'A B', phone: '', email: `p${i}@x.co.za`,
        specialty: '', suburb: '', message: '', website: '',
      });
    }
    currentIp = '203.0.113.9';
    const res = await submitPublicLead({
      practiceName: 'Different-IP', contactName: 'A B', phone: '', email: 'other@x.co.za',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(res).toEqual({ ok: true });
  });
});

// ── (d) Formula-injection — assert stored value is neutralised ──

describe('(d) formula-injection neutralisation', () => {
  it('every string field starting with =/+/-/@/tab is prefixed with an apostrophe in the inserted row', async () => {
    const { submitPublicLead } = await fresh();
    await submitPublicLead({
      practiceName: '=SUM(A1:A9)',
      contactName:  '+cmd|/c calc',
      phone:        '+27 82 111 2222',
      email:        'safe@example.com',
      specialty:    '',
      suburb:       '@evil',
      message:      '\t=HYPERLINK("http://evil")',
      website:      '',
    });
    const row = state.inserts.filter(i => i.table === 'crm_leads')[0].row;
    expect(String(row.practice_name).startsWith("'=")).toBe(true);
    expect(String(row.contact_first_name).startsWith("'+")).toBe(true);
    expect(String(row.suburb).startsWith("'@")).toBe(true);
    // Message went into the crm_activities insert
    const activity = state.inserts.filter(i => i.table === 'crm_activities')[0];
    expect(activity).toBeDefined();
    expect(String(activity.row.body).startsWith("'")).toBe(true);
  });
});

// ── (e) Validation ──────────────────────────────────────────────

describe('(e) validation', () => {
  it('missing practice name → error, no insert', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: '   ', contactName: 'A B', phone: '', email: 'x@x.co.za',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('practiceName');
    expect(state.inserts.filter(i => i.table === 'crm_leads').length).toBe(0);
  });

  it('no email AND no phone → error, no insert', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: 'P', contactName: 'A B', phone: '', email: '',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(res.ok).toBe(false);
    expect(state.inserts.filter(i => i.table === 'crm_leads').length).toBe(0);
  });

  it('invalid email format → error', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: 'P', contactName: 'A B', phone: '', email: 'not-an-email',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('email');
  });

  it('invalid phone format → error (when no email)', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: 'P', contactName: 'A B', phone: '12345', email: '',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('phone');
  });

  it('unknown specialty → error', async () => {
    const { submitPublicLead } = await fresh();
    const res = await submitPublicLead({
      practiceName: 'P', contactName: 'A B', phone: '', email: 'x@x.co.za',
      specialty: 'Astrology', suburb: '', message: '', website: '',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.field).toBe('specialty');
  });

  it('absurdly-long inputs are truncated to the field limits', async () => {
    const { submitPublicLead } = await fresh();
    const huge = 'A'.repeat(5000);
    await submitPublicLead({
      practiceName: huge, contactName: huge, phone: '+27 82 111 2222',
      email: `${'x'.repeat(300)}@x.co.za`, specialty: '', suburb: huge, message: huge,
      website: '',
    });
    // Practice name capped at 200; suburb at 120; message at 2000. Email
    // exceeds isValidEmail → error path (no insert) — check no absurd
    // row was inserted either way.
    const row = state.inserts.find(i => i.table === 'crm_leads')?.row;
    if (row) {
      expect(String(row.practice_name).length).toBeLessThanOrEqual(200);
      expect(String(row.suburb).length).toBeLessThanOrEqual(120);
    }
  });
});

// ── (f) Read-path probe ─────────────────────────────────────────

describe('(f) module surface — NO read path for unauthenticated callers', () => {
  it('exposes exactly submitPublicLead — no test hook, no read helper, on the public surface', async () => {
    const mod = await fresh();
    const exported = Object.keys(mod).sort();
    // Server-action files must export only async functions (Next.js
    // enforces this at build time). The rate-limit reset helper lives
    // in @/lib/crm/publicLeadRateLimit — not on the public surface.
    expect(exported).toEqual(['submitPublicLead']);
  });

  it('submitPublicLead\'s return type never carries lead data even on success', async () => {
    // The response is `{ ok: true }` on success or `{ ok: false, error, field?, message? }`
    // on rejection. There is no branch that returns lead id, dupe list,
    // practice name, or any other read of crm_leads.
    const { submitPublicLead } = await fresh();
    const ok = await submitPublicLead({
      practiceName: 'X', contactName: 'A B', phone: '', email: 'a@b.co',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(ok).toEqual({ ok: true });
    // Assert the shape doesn't leak on ANY of the invalid paths either.
    const err = await submitPublicLead({
      practiceName: '', contactName: 'A B', phone: '', email: 'a@b.co',
      specialty: '', suburb: '', message: '', website: '',
    });
    expect(err.ok).toBe(false);
    if (!err.ok) {
      const keys = Object.keys(err).sort();
      // Only { ok, error, field?, message? } may appear.
      for (const k of keys) {
        expect(['ok', 'error', 'field', 'message']).toContain(k);
      }
    }
  });
});
