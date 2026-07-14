import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Behavioural — sendGmail emits proper threading headers ──────
//
// We can't hit the real Gmail endpoint, but we can spy on fetch and
// inspect the raw MIME + the request body Gmail would receive. This
// asserts:
//   • the raw payload has In-Reply-To + References headers when
//     inReplyTo is supplied
//   • References = prior + inReplyTo when a prior chain is present
//   • the send body includes threadId when supplied
//   • without inReplyTo, neither header appears (fresh send)

type CapturedCall = { url: string; body: string; init?: RequestInit };
const captured: CapturedCall[] = [];

// Mock global fetch — the client calls the send endpoint once per
// invocation with an OAuth token we don't care about.
beforeEach(() => {
  captured.length = 0;
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    captured.push({ url: String(url), body: bodyStr, init });
    return new Response(JSON.stringify({ id: 'gmail-msg-id', threadId: 'gmail-thread-id' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

async function loadSendGmail() {
  // Fresh import so any module-level state is bypassed.
  vi.resetModules();
  const mod = await import('./gmailClient');
  return mod.sendGmail;
}

function decodeRawMime(sendBodyJson: string): string {
  const parsed = JSON.parse(sendBodyJson) as { raw: string };
  const b64 = parsed.raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('sendGmail — reply-mode threading', () => {
  it('includes In-Reply-To + References headers when inReplyTo is supplied', async () => {
    const sendGmail = await loadSendGmail();
    await sendGmail({
      accessToken: 'ya29.fixture',
      from:        'jess@betternow.co.za',
      fromName:    'Jess',
      to:          'alice@example.com',
      subject:     'Re: hello',
      bodyText:    'thanks!',
      threadId:    'the-thread',
      inReplyTo:   '<orig-msg-id@mail.example>',
    });

    expect(captured.length).toBe(1);
    const raw = decodeRawMime(captured[0].body);
    expect(raw).toContain('In-Reply-To: <orig-msg-id@mail.example>');
    // References equals inReplyTo when no prior chain is passed.
    expect(raw).toContain('References: <orig-msg-id@mail.example>');
  });

  it('References = prior chain + inReplyTo when references is passed', async () => {
    const sendGmail = await loadSendGmail();
    await sendGmail({
      accessToken: 'ya29.fixture',
      from:        'jess@betternow.co.za',
      fromName:    'Jess',
      to:          'alice@example.com',
      subject:     'Re: hello',
      bodyText:    'part 3 of the thread',
      threadId:    'the-thread',
      inReplyTo:   '<msg-c@mail>',
      references:  '<msg-a@mail> <msg-b@mail>',
    });
    const raw = decodeRawMime(captured[0].body);
    expect(raw).toContain('References: <msg-a@mail> <msg-b@mail> <msg-c@mail>');
  });

  it('adds threadId to the send request body when supplied', async () => {
    const sendGmail = await loadSendGmail();
    await sendGmail({
      accessToken: 'ya29.fixture',
      from:        'jess@betternow.co.za',
      fromName:    'Jess',
      to:          'alice@example.com',
      subject:     'Re: hello',
      bodyText:    'thanks!',
      threadId:    'the-thread',
      inReplyTo:   '<orig@mail>',
    });
    const parsed = JSON.parse(captured[0].body) as { raw: string; threadId?: string };
    expect(parsed.threadId).toBe('the-thread');
  });

  it('fresh send (no inReplyTo) emits NO In-Reply-To / References + no threadId', async () => {
    const sendGmail = await loadSendGmail();
    await sendGmail({
      accessToken: 'ya29.fixture',
      from:        'jess@betternow.co.za',
      fromName:    'Jess',
      to:          'alice@example.com',
      subject:     'fresh outreach',
      bodyText:    'hi',
    });
    const parsed = JSON.parse(captured[0].body) as { raw: string; threadId?: string };
    expect(parsed.threadId).toBeUndefined();
    const raw = decodeRawMime(captured[0].body);
    expect(raw).not.toMatch(/^In-Reply-To:/m);
    expect(raw).not.toMatch(/^References:/m);
  });

  it('threadId-only send (missing rfc id fallback) omits threading headers but still threads via body.threadId', async () => {
    const sendGmail = await loadSendGmail();
    await sendGmail({
      accessToken: 'ya29.fixture',
      from:        'jess@betternow.co.za',
      fromName:    'Jess',
      to:          'alice@example.com',
      subject:     'Re: hello',
      bodyText:    'thanks!',
      threadId:    'the-thread',
      // no inReplyTo — legacy activity without RFC id
    });
    const parsed = JSON.parse(captured[0].body) as { raw: string; threadId?: string };
    expect(parsed.threadId).toBe('the-thread');
    const raw = decodeRawMime(captured[0].body);
    expect(raw).not.toMatch(/^In-Reply-To:/m);
  });
});
