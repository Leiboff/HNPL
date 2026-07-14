import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Behavioural — composeEmail server-action shapes ────────────────
//
// The compose surface never returns token material. We invoke the
// actions with mocked Supabase clients + a mocked Gmail path and
// assert the returned shape on happy + error paths. Any string in a
// return value that matches known token / ciphertext markers fails
// the test.

// ── Mocks ────────────────────────────────────────────────────────

type LeadRow = { id: string; practice_name: string; email: string | null; contact_first_name: string; contact_last_name: string; };

const state: {
  profile:     { role: string; first_name?: string | null; last_name?: string | null } | null;
  lead:        LeadRow | null;
  authUser:    { id: string } | null;
  templates:   Array<{ id: string; name: string; subject: string; body: string }>;
  activityInserts: Array<Record<string, unknown>>;
  sendResult:  { throw: unknown } | { ok: { messageId: string; threadId: string } };
  tokenResult: { accessToken: string; account: { gmail_address: string } } | { error: string };
} = {
  profile:     { role: 'sales', first_name: 'Sam', last_name: 'S.' },
  lead:        null,
  authUser:    { id: 'user-1' },
  templates:   [],
  activityInserts: [],
  sendResult:  { ok: { messageId: 'msg-1', threadId: 'thread-1' } },
  tokenResult: { accessToken: 'ya29.fixture', account: { gmail_address: 'sam@x.com' } },
};

// Session-client mock (createClient from lib/supabase/server)
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.authUser } }) },
    from(table: string) {
      return {
        select() { return this; },
        eq()     { return this; },
        maybeSingle: async () => {
          if (table === 'profiles')            return { data: state.profile,   error: null };
          if (table === 'crm_leads')           return { data: state.lead,      error: null };
          if (table === 'crm_email_templates') return { data: state.templates[0] ?? null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'profiles') return { data: state.profile, error: null };
          return { data: null, error: null };
        },
        order() { return this; },
        limit() { return this; },
        async then(onFulfilled: (r: unknown) => unknown) {
          // Bare await on a query returns { data, error }
          if (table === 'crm_email_templates') return onFulfilled({ data: state.templates, error: null });
          return onFulfilled({ data: null, error: null });
        },
      };
    },
  }),
}));

// Service-role mock — used by sendComposedEmail to log the activity
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      return {
        update() { return { eq: async () => ({ error: null }) }; },
        insert(row: Record<string, unknown>) {
          if (table === 'crm_activities') state.activityInserts.push(row);
          return { error: null };
        },
      };
    },
  }),
}));

// Gmail client mock
vi.mock('@/lib/gmail/gmailClient', () => ({
  getAccessToken: async () => state.tokenResult,
  sendGmail: async () => {
    if ('throw' in state.sendResult) {
      const e = state.sendResult.throw;
      if (e instanceof Error) throw e;
      throw new Error(String(e));
    }
    return state.sendResult.ok;
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: () => { /* no-op */ } }));

// Anything a return value MUST NOT contain.
const FORBIDDEN_MARKERS = [
  'refresh_token', 'access_token', 'refresh_token_enc', 'access_token_cache',
  'ya29.', 'v1:', 'gmail-access-token', 'ciphertext',
];

function assertNoTokenMaterial(result: unknown): void {
  const serialised = JSON.stringify(result);
  for (const m of FORBIDDEN_MARKERS) {
    expect(serialised).not.toContain(m);
  }
}

async function fresh() {
  vi.resetModules();
  return await import('./composeEmail');
}

beforeEach(() => {
  state.profile     = { role: 'sales', first_name: 'Sam', last_name: 'S.' };
  state.lead        = { id: 'lead-1', practice_name: 'Rosebank Dental', email: 'alice@rosebank.co.za', contact_first_name: 'Alice', contact_last_name: 'Smith' };
  state.authUser    = { id: 'user-1' };
  state.templates   = [];
  state.activityInserts = [];
  state.sendResult  = { ok: { messageId: 'msg-1', threadId: 'thread-1' } };
  state.tokenResult = { accessToken: 'ya29.fixture', account: { gmail_address: 'sam@x.com' } };
});

describe('sendComposedEmail — return shape has NO token material', () => {
  it('happy-path returns {} (empty object; no ids, no tokens)', async () => {
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(res).toEqual({});
    assertNoTokenMaterial(res);
  });

  it('gmail_not_connected → { error, needsReconnect } and no token material', async () => {
    state.tokenResult = { error: 'gmail_not_connected' };
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(res.error).toBe('gmail_not_connected');
    expect(res.needsReconnect).toBe(true);
    assertNoTokenMaterial(res);
  });

  it('gmail_reauth_required from token layer → { error, needsReconnect }; no token material', async () => {
    state.tokenResult = { error: 'gmail_reauth_required' };
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(res.error).toBe('gmail_reauth_required');
    expect(res.needsReconnect).toBe(true);
    assertNoTokenMaterial(res);
  });

  it('401 / Invalid Credentials at send time → { error: gmail_reauth_required, needsReconnect } with NO token material', async () => {
    state.sendResult = { throw: new Error('Gmail send failed: 401 Invalid Credentials — token expired') };
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(res.error).toBe('gmail_reauth_required');
    expect(res.needsReconnect).toBe(true);
    assertNoTokenMaterial(res);
    // Even though the underlying error string mentions "token expired",
    // the caller only sees the semantic code — not the raw error.
    expect(JSON.stringify(res)).not.toContain('Gmail send failed');
  });

  it('generic send failure → { error } truncated to 200 chars, still no token material', async () => {
    state.sendResult = { throw: new Error('Some transient network glitch — 5xx from Gmail — ' + 'x'.repeat(500)) };
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(typeof res.error).toBe('string');
    expect(res.error!.length).toBeLessThanOrEqual(200);
    expect(res.needsReconnect).toBeUndefined();
    assertNoTokenMaterial(res);
  });

  it('lead with no email → { error: lead_has_no_email } and no token material', async () => {
    state.lead = { ...state.lead!, email: null };
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(res.error).toBe('lead_has_no_email');
    assertNoTokenMaterial(res);
  });

  it('unauthorized (non-sales, non-admin) → error, no side effects, no token material', async () => {
    state.profile = { role: 'patient' };
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(res.error).toBe('unauthorized');
    expect(state.activityInserts.length).toBe(0);
    assertNoTokenMaterial(res);
  });
});

describe('previewCompose — pure merge, no token material', () => {
  it('substitutes merge fields without touching Gmail (no token in the return)', async () => {
    state.lead = { id: 'lead-1', practice_name: 'Rosebank Dental', email: 'a@b.co',
                   contact_first_name: 'Alice', contact_last_name: 'Smith' };
    const { previewCompose } = await fresh();
    const res = await previewCompose({
      leadId:  'lead-1',
      subject: 'Hi {{contact_first_name}}',
      body:    'A note about {{practice_name}} — {{my_name}}',
    });
    expect(res.preview?.subject).toBe('Hi Alice');
    expect(res.preview?.body).toMatch(/Rosebank Dental/);
    expect(res.preview?.body).toMatch(/Sam S\./);
    assertNoTokenMaterial(res);
  });

  it('lead not found → { error }, no token material', async () => {
    state.lead = null;
    const { previewCompose } = await fresh();
    const res = await previewCompose({ leadId: 'gone', subject: 's', body: 'b' });
    expect(res.error).toBe('lead_not_found');
    assertNoTokenMaterial(res);
  });
});
