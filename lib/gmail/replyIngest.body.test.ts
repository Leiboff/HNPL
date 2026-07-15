import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Behavioural — ingestion stores the full clean body ─────────────
//
// Before this pass the reply-poll and push handler stored the Gmail
// snippet as-is. Now `ingestOneMessage` calls fetchMessageFull(),
// extracts text/plain → html-to-text → snippet fallback, decodes
// HTML entities, and stores that as the crm_activities.body.

const state: {
  activities: Array<{
    gmail_thread_id: string | null;
    gmail_message_id: string | null;
    stage?: string;
  }>;
  full: Record<string, {
    bodyPlain: string | null;
    bodyHtml:  string | null;
    snippet:   string;
  }>;
  inserts: Array<Record<string, unknown>>;
  fullShouldThrow: boolean;
} = {
  activities: [],
  full: {},
  inserts: [],
  fullShouldThrow: false,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const chain: {
        select(): typeof chain;
        eq(): typeof chain;
        not(): typeof chain;
        insert(row: Record<string, unknown>): Promise<{ error: null }>;
        then?: (fn: (r: unknown) => unknown) => unknown;
      } = {
        select() { return chain; },
        eq()     { return chain; },
        not()    { return chain; },
        insert: async (row) => {
          if (table === 'crm_activities') state.inserts.push(row);
          return { error: null };
        },
      };
      Object.defineProperty(chain, 'then', {
        value: (fn: (r: unknown) => unknown) => {
          if (table === 'crm_activities') {
            const withStage = state.activities.map(a => ({
              id: a.gmail_message_id ?? 'x',
              lead_id: 'lead-1',
              gmail_message_id: a.gmail_message_id,
              crm_leads: { stage: a.stage ?? 'contacted' },
            }));
            return fn({ data: withStage, error: null });
          }
          return fn({ data: null, error: null });
        },
        configurable: true,
      });
      return chain;
    },
  }),
}));

vi.mock('./gmailClient', () => ({
  fetchThread: async () => [],
  fetchMessageFull: async (_token: string, id: string) => {
    if (state.fullShouldThrow) throw new Error('full-fetch simulated failure');
    const f = state.full[id];
    if (!f) return null;
    return {
      id,
      threadId:     'thread-X',
      labelIds:     [],
      internalDate: '1704067200000',   // fixed ISO-parsable ms
      from:         'Alice <alice@x.com>',
      snippet:      f.snippet,
      rfcMessageId: '<orig@mail>',
      subject:      'subj',
      references:   null,
      inReplyTo:    null,
      bodyPlain:    f.bodyPlain,
      bodyHtml:     f.bodyHtml,
    };
  },
}));

async function fresh() {
  vi.resetModules();
  return await import('./replyIngest');
}

beforeEach(() => {
  state.activities = [
    { gmail_thread_id: 'thread-X', gmail_message_id: 'own-outbound' },
  ];
  state.full = {};
  state.inserts = [];
  state.fullShouldThrow = false;
});

const anchorMsg = {
  id:           'inbound-msg-1',
  threadId:     'thread-X',
  labelIds:     [],
  internalDate: '1704067200000',
  from:         'Alice <alice@x.com>',
  snippet:      '&lt;html snippet&gt; that Gmail entity-encoded',
  rfcMessageId: null,
  subject:      'Re: intro',
  references:   null,
  inReplyTo:    null,
};

const account = { id: 'acct-A', user_id: 'user-1', gmail_address: 'sam@x.com' };

describe('ingestOneMessage — stores full clean body', () => {
  it('prefers text/plain content over snippet', async () => {
    state.full['inbound-msg-1'] = {
      bodyPlain: 'This is the full plain body\n\nWith paragraphs.',
      bodyHtml:  '<p>ignored</p>',
      snippet:   'snippet only',
    };
    const { ingestOneMessage } = await fresh();
    const verdict = await ingestOneMessage(account, anchorMsg, 'ya29.token');
    expect(verdict).toBe('inserted');
    expect(state.inserts.length).toBe(1);
    const row = state.inserts[0];
    expect(row.body).toContain('This is the full plain body');
    expect(row.body).toContain('With paragraphs.');
    expect(row.body).not.toBe('snippet only');
  });

  it('falls back to text/html converted to text when text/plain is missing', async () => {
    state.full['inbound-msg-1'] = {
      bodyPlain: null,
      bodyHtml:  '<p>Alice replied.</p><p>Thanks &amp; regards.</p>',
      snippet:   'ignored',
    };
    const { ingestOneMessage } = await fresh();
    await ingestOneMessage(account, anchorMsg, 'ya29.token');
    const row = state.inserts[0];
    expect(row.body).toContain('Alice replied.');
    expect(row.body).toContain('Thanks & regards.');
    expect(String(row.body)).not.toMatch(/<[a-z]/i);
  });

  it('falls back to entity-decoded snippet when full-body fetch returns nothing', async () => {
    state.full = {};   // full-fetch returns null
    const { ingestOneMessage } = await fresh();
    await ingestOneMessage(account, anchorMsg, 'ya29.token');
    const row = state.inserts[0];
    expect(row.body).toContain('<html snippet>');   // entities decoded
  });

  it('falls back to snippet when the full-body fetch itself throws', async () => {
    state.fullShouldThrow = true;
    const { ingestOneMessage } = await fresh();
    await ingestOneMessage(account, anchorMsg, 'ya29.token');
    const row = state.inserts[0];
    expect(row.body).toContain('<html snippet>');
  });

  it('occurred_at is derived from internalDate (unchanged behaviour)', async () => {
    state.full['inbound-msg-1'] = {
      bodyPlain: 'hi', bodyHtml: null, snippet: '',
    };
    const { ingestOneMessage } = await fresh();
    await ingestOneMessage(account, anchorMsg, 'ya29.token');
    const row = state.inserts[0];
    // internalDate '1704067200000' → 2024-01-01T00:00:00.000Z
    expect(row.occurred_at).toBe(new Date(1704067200000).toISOString());
  });
});
