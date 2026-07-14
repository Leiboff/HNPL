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

type ActivityRow = {
  id: string;
  lead_id: string;
  type: string;
  title: string | null;
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  message_rfc_id: string | null;
  reply_from: string | null;
  sent_from: string | null;
};

const state: {
  profile:     { role: string; first_name?: string | null; last_name?: string | null } | null;
  lead:        LeadRow | null;
  authUser:    { id: string } | null;
  templates:   Array<{ id: string; name: string; subject: string; body: string }>;
  activityInserts: Array<Record<string, unknown>>;
  sendResult:  { throw: unknown } | { ok: { messageId: string; threadId: string } };
  tokenResult: { accessToken: string; account: { id: string; gmail_address: string } } | { error: string };
  gmailAccountsListResult: Array<{ id: string; gmail_address: string; last_used_at: string | null; connected_at: string; status: string }>;
  signatureRow: { display_name: string; title: string; phone: string; email: string; html_override: string | null; text_fallback: string | null } | null;
  sendCallArgs: Array<Record<string, unknown>>;
  updateCalls: Array<{ table: string; patch: Record<string, unknown> }>;
  activityById: Record<string, ActivityRow>;
  accountByAddress: Record<string, { id: string; gmail_address: string; status: string }>;
  fetchedMessageMetadata: Record<string, { rfcMessageId: string | null; subject: string; references: string | null } | null>;
} = {
  profile:     { role: 'sales', first_name: 'Sam', last_name: 'S.' },
  lead:        null,
  authUser:    { id: 'user-1' },
  templates:   [],
  activityInserts: [],
  sendResult:  { ok: { messageId: 'msg-1', threadId: 'thread-1' } },
  tokenResult: { accessToken: 'ya29.fixture', account: { id: 'acct-A', gmail_address: 'sam@x.com' } },
  gmailAccountsListResult: [],
  signatureRow: null,
  sendCallArgs: [],
  updateCalls: [],
  activityById: {},
  accountByAddress: {},
  fetchedMessageMetadata: {},
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

// Service-role mock — used by sendComposedEmail to log the activity + look up signatures/accounts
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      // Track the chain's filter state so maybeSingle() can look up
      // the right row when tests seed activityById / accountByAddress.
      const filters: { eqById: string | null; ilikeAddress: string | null; limitOne: boolean } =
        { eqById: null, ilikeAddress: null, limitOne: false };

      const chain: {
        select(): typeof chain;
        eq(col: string, val: unknown): typeof chain;
        ilike(col: string, val: string): typeof chain;
        order(): typeof chain;
        limit(n: number): typeof chain;
        update(patch: Record<string, unknown>): { eq: (...args: unknown[]) => Promise<{ error: null }> };
        insert(row: Record<string, unknown>): Promise<{ error: null }>;
        maybeSingle(): Promise<{ data: unknown; error: null }>;
        then?: (fn: (r: unknown) => unknown) => unknown;
      } = {
        select() { return chain; },
        eq(col, val) {
          if (col === 'id') filters.eqById = String(val);
          return chain;
        },
        ilike(col, val) {
          if (col === 'gmail_address') filters.ilikeAddress = String(val).toLowerCase();
          return chain;
        },
        order()  { return chain; },
        limit(_n) { filters.limitOne = true; return chain; },
        update(patch) {
          return { eq: async () => { state.updateCalls.push({ table, patch }); return { error: null }; } };
        },
        insert: async (row) => {
          if (table === 'crm_activities') state.activityInserts.push(row);
          return { error: null };
        },
        maybeSingle: async () => {
          if (table === 'crm_signatures')   return { data: state.signatureRow, error: null };
          if (table === 'crm_activities' && filters.eqById) {
            return { data: state.activityById[filters.eqById] ?? null, error: null };
          }
          if (table === 'crm_leads' && filters.eqById) {
            // Reply-mode recipient lookup — service-role side.
            return { data: state.lead && state.lead.id === filters.eqById
              ? { id: state.lead.id, email: state.lead.email }
              : null, error: null };
          }
          if (table === 'crm_email_accounts' && filters.ilikeAddress) {
            return { data: state.accountByAddress[filters.ilikeAddress] ?? null, error: null };
          }
          if (table === 'crm_email_accounts' && filters.limitOne) {
            const first = state.gmailAccountsListResult[0] ?? null;
            return { data: first, error: null };
          }
          return { data: null, error: null };
        },
      };
      // The list-accounts path awaits the query directly — expose then()
      // to satisfy `await q.from('crm_email_accounts')...`.
      Object.defineProperty(chain, 'then', {
        value: (fn: (r: unknown) => unknown) => {
          if (table === 'crm_email_accounts') return fn({ data: state.gmailAccountsListResult, error: null });
          return fn({ data: null, error: null });
        },
        configurable: true,
      });
      return chain;
    },
  }),
}));

// Gmail client mock — records send args so we can assert bodyHtml/bodyText.
vi.mock('@/lib/gmail/gmailClient', () => ({
  getAccessToken: async () => state.tokenResult,
  sendGmail: async (args: Record<string, unknown>) => {
    state.sendCallArgs.push(args);
    if ('throw' in state.sendResult) {
      const e = state.sendResult.throw;
      if (e instanceof Error) throw e;
      throw new Error(String(e));
    }
    return state.sendResult.ok;
  },
  fetchMessageMetadata: async (_token: string, messageId: string) => {
    const m = state.fetchedMessageMetadata[messageId] ?? null;
    if (!m) return null;
    return {
      id:           messageId,
      threadId:     'thread-x',
      labelIds:     [],
      internalDate: '0',
      from:         '',
      snippet:      '',
      rfcMessageId: m.rfcMessageId,
      subject:      m.subject,
      references:   m.references,
      inReplyTo:    null,
    };
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
  state.tokenResult = { accessToken: 'ya29.fixture', account: { id: 'acct-A', gmail_address: 'sam@x.com' } };
  state.gmailAccountsListResult = [];
  state.signatureRow = null;
  state.sendCallArgs = [];
  state.updateCalls  = [];
  state.activityById = {};
  state.accountByAddress = {};
  state.fetchedMessageMetadata = {};
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

describe('sendComposedEmail — multi-account, attribution, signature', () => {
  it('records sent_from + gmail_thread_id on the crm_activities insert', async () => {
    const { sendComposedEmail } = await fresh();
    await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    const emailAct = state.activityInserts.find(a => a.type === 'email');
    expect(emailAct).toBeDefined();
    expect(emailAct!.sent_from).toBe('sam@x.com');
    expect(emailAct!.gmail_thread_id).toBe('thread-1');
    expect(emailAct!.gmail_message_id).toBe('msg-1');
    expect(emailAct!.created_by).toBe('user-1');
  });

  it('updates last_used_at on the connected account after a successful send', async () => {
    const { sendComposedEmail } = await fresh();
    await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    const updated = state.updateCalls.find(c => c.table === 'crm_email_accounts' && 'last_used_at' in c.patch);
    expect(updated).toBeDefined();
    expect(typeof updated!.patch.last_used_at).toBe('string');
  });

  it('signature auto-appended: bodyHtml + bodyText carry the signature text', async () => {
    state.signatureRow = {
      display_name: 'Sam S.', title: 'BD', phone: '+27 82 111 2222', email: 'sam@x.com',
      html_override: null, text_fallback: null,
    };
    const { sendComposedEmail } = await fresh();
    await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    expect(state.sendCallArgs.length).toBe(1);
    const args = state.sendCallArgs[0];
    expect(args.bodyText).toContain('Hello');
    expect(args.bodyText).toContain('betternow');   // signature block
    expect(args.bodyHtml).toContain('better');
    expect(args.bodyHtml).toContain('#13294B');
  });

  it('signature omitted when omitSignature=true (bodyHtml empty)', async () => {
    state.signatureRow = {
      display_name: 'Sam S.', title: '', phone: '', email: '',
      html_override: null, text_fallback: null,
    };
    const { sendComposedEmail } = await fresh();
    await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello', omitSignature: true });
    const args = state.sendCallArgs[0];
    expect(args.bodyText).toBe('Hello');
    expect(args.bodyHtml).toBeUndefined();
  });

  it('signature raw-HTML override is sanitised in the send body', async () => {
    state.signatureRow = {
      display_name: 'Sam', title: '', phone: '', email: '',
      html_override: 'Hi <script>alert(1)</script> <a href="javascript:evil()">click</a>',
      text_fallback: null,
    };
    const { sendComposedEmail } = await fresh();
    await sendComposedEmail({ leadId: 'lead-1', subject: 'Hi', body: 'Hello' });
    const args = state.sendCallArgs[0];
    expect(args.bodyHtml).not.toContain('<script');
    expect(args.bodyHtml).not.toContain('alert(1)');
    expect(String(args.bodyHtml).toLowerCase()).not.toContain('javascript:');
  });
});

describe('listMyGmailAccounts — Send-as source', () => {
  it('lists connected accounts most-recently-used first, flags default', async () => {
    state.gmailAccountsListResult = [
      { id: 'acct-1', gmail_address: 'jess@betternow.co.za', last_used_at: '2026-07-14', connected_at: '2026-07-01', status: 'connected' },
      { id: 'acct-2', gmail_address: 'admin@betternow.co.za', last_used_at: null,        connected_at: '2026-07-02', status: 'connected' },
    ];
    const { listMyGmailAccounts } = await fresh();
    const list = await listMyGmailAccounts();
    expect(list.map(l => l.gmailAddress)).toEqual(['jess@betternow.co.za', 'admin@betternow.co.za']);
    expect(list[0].isDefault).toBe(true);
    expect(list[1].isDefault).toBe(false);
    // No token material in the returned list.
    assertNoTokenMaterial(list);
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

// ── Reply mode ──────────────────────────────────────────────────────

describe('loadReplyContext — prefill for reply mode', () => {
  beforeEach(() => {
    state.accountByAddress['sam@x.com'] = {
      id: 'acct-A', gmail_address: 'sam@x.com', status: 'connected',
    };
  });

  it('email_reply anchor → To = reply_from, subject "Re: …" idempotent, sender locked to sent_from', async () => {
    state.activityById['act-1'] = {
      id: 'act-1',
      lead_id: 'lead-1',
      type: 'email_reply',
      title: 'Reply from Alice',
      gmail_thread_id: 'thread-A',
      gmail_message_id: 'gmail-msg-1',
      message_rfc_id: '<orig@mail>',
      reply_from: 'alice@rosebank.co.za',
      sent_from: 'sam@x.com',
    };
    // Anchor has no derivable subject (title is "Reply from ..."). We
    // fall through to fetchMessageMetadata for the subject header.
    state.fetchedMessageMetadata['gmail-msg-1'] = {
      rfcMessageId: '<orig@mail>',
      subject: 'betternow for Rosebank Dental',
      references: null,
    };
    const { loadReplyContext } = await fresh();
    const res = await loadReplyContext({ activityId: 'act-1' });
    expect(res.error).toBeUndefined();
    const ctx = res.context!;
    expect(ctx.to).toBe('alice@rosebank.co.za');
    expect(ctx.subject).toBe('Re: betternow for Rosebank Dental');
    expect(ctx.lockedAccount).toEqual({ id: 'acct-A', gmailAddress: 'sam@x.com' });
    expect(ctx.threadId).toBe('thread-A');
    expect(ctx.messageRfcId).toBe('<orig@mail>');
    expect(ctx.ownerDisconnected).toBe(false);
    assertNoTokenMaterial(res);
  });

  it('sent email anchor → To = lead.email, Re: prefix idempotent from title', async () => {
    state.activityById['act-2'] = {
      id: 'act-2',
      lead_id: 'lead-1',
      type: 'email',
      title: 'Email sent: Re: hello there',  // note already prefixed
      gmail_thread_id: 'thread-B',
      gmail_message_id: 'gmail-msg-2',
      message_rfc_id: '<me@mail>',
      reply_from: null,
      sent_from: 'sam@x.com',
    };
    const { loadReplyContext } = await fresh();
    const res = await loadReplyContext({ activityId: 'act-2' });
    const ctx = res.context!;
    expect(ctx.to).toBe('alice@rosebank.co.za');   // lead.email fixture
    expect(ctx.subject).toBe('Re: hello there');    // idempotent — not "Re: Re: …"
    expect(ctx.lockedAccount?.gmailAddress).toBe('sam@x.com');
  });

  it('anchor owner disconnected → ownerDisconnected=true, lockedAccount=null', async () => {
    state.activityById['act-3'] = {
      id: 'act-3',
      lead_id: 'lead-1',
      type: 'email_reply',
      title: 'Reply from Alice',
      gmail_thread_id: 'thread-C',
      gmail_message_id: 'msg-3',
      message_rfc_id: '<x@mail>',
      reply_from: 'alice@rosebank.co.za',
      sent_from: 'orphan@x.com',   // no matching account in accountByAddress
    };
    const { loadReplyContext } = await fresh();
    const res = await loadReplyContext({ activityId: 'act-3' });
    expect(res.context!.ownerDisconnected).toBe(true);
    expect(res.context!.lockedAccount).toBeNull();
  });

  it('not-replyable activity type (note) → error', async () => {
    state.activityById['act-4'] = {
      id: 'act-4', lead_id: 'lead-1', type: 'note',
      title: 'A note', gmail_thread_id: null, gmail_message_id: null,
      message_rfc_id: null, reply_from: null, sent_from: null,
    };
    const { loadReplyContext } = await fresh();
    const res = await loadReplyContext({ activityId: 'act-4' });
    expect(res.error).toBe('not_replyable');
  });

  it('missing activity → activity_not_found', async () => {
    const { loadReplyContext } = await fresh();
    const res = await loadReplyContext({ activityId: 'nope' });
    expect(res.error).toBe('activity_not_found');
  });
});

describe('sendComposedEmail — reply-mode send passes threading through', () => {
  beforeEach(() => {
    state.accountByAddress['sam@x.com'] = {
      id: 'acct-A', gmail_address: 'sam@x.com', status: 'connected',
    };
    state.activityById['act-1'] = {
      id: 'act-1', lead_id: 'lead-1', type: 'email_reply',
      title: 'Reply from Alice',
      gmail_thread_id: 'thread-A',
      gmail_message_id: 'gmail-msg-1',
      message_rfc_id: '<orig@mail>',
      reply_from: 'alice@rosebank.co.za',
      sent_from: 'sam@x.com',
    };
  });

  it('threadId + inReplyTo + references reach sendGmail', async () => {
    state.fetchedMessageMetadata['gmail-msg-1'] = {
      rfcMessageId: '<orig@mail>',
      subject: '',
      references: '<earlier-a@mail> <earlier-b@mail>',
    };
    // Gmail returns the same thread id we asked for.
    state.sendResult = { ok: { messageId: 'msg-reply', threadId: 'thread-A' } };
    const { sendComposedEmail } = await fresh();
    await sendComposedEmail({
      leadId: 'lead-1', subject: 'Re: hello', body: 'thanks!',
      replyToActivityId: 'act-1',
    });
    expect(state.sendCallArgs.length).toBe(1);
    const args = state.sendCallArgs[0];
    expect(args.threadId).toBe('thread-A');
    expect(args.inReplyTo).toBe('<orig@mail>');
    expect(args.references).toBe('<earlier-a@mail> <earlier-b@mail>');
    expect(args.to).toBe('alice@rosebank.co.za');
    // Logged activity carries the Gmail-returned thread id + sent_from.
    const emailAct = state.activityInserts.find(a => a.type === 'email');
    expect(emailAct!.gmail_thread_id).toBe('thread-A');
    expect(emailAct!.sent_from).toBe('sam@x.com');
  });

  it('falls back to threadId-only when the anchor has no message_rfc_id', async () => {
    state.activityById['act-1'].message_rfc_id = null;
    const { sendComposedEmail } = await fresh();
    await sendComposedEmail({
      leadId: 'lead-1', subject: 'Re: hello', body: 'thanks!',
      replyToActivityId: 'act-1',
    });
    const args = state.sendCallArgs[0];
    expect(args.threadId).toBe('thread-A');
    expect(args.inReplyTo).toBeUndefined();
    expect(args.references).toBeUndefined();
  });

  it('owner-address disconnected → { error: reply_owner_disconnected, needsReconnect: true }', async () => {
    delete state.accountByAddress['sam@x.com'];
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({
      leadId: 'lead-1', subject: 'Re: hello', body: 'thanks!',
      replyToActivityId: 'act-1',
    });
    expect(res.error).toBe('reply_owner_disconnected');
    expect(res.needsReconnect).toBe(true);
    // No send attempted.
    expect(state.sendCallArgs.length).toBe(0);
  });

  it('rejects a mismatched accountId (client cannot override the locked sender)', async () => {
    const { sendComposedEmail } = await fresh();
    const res = await sendComposedEmail({
      leadId: 'lead-1', subject: 'Re: hello', body: 'thanks!',
      replyToActivityId: 'act-1',
      accountId: 'acct-DIFFERENT',
    });
    expect(res.error).toBe('reply_owner_locked');
    expect(state.sendCallArgs.length).toBe(0);
  });
});
