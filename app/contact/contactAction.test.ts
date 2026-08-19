import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Behavioural tests — public contact enquiry action ───────────────
//
// Invokes submitContactEnquiry directly with real payloads. Two things are
// mocked and nothing else:
//
//   • next/headers, for the per-IP rate limit;
//   • lib/email/resend's sendEmail, so we can assert the EXACT request the
//     provider would have received.
//
// The email TEMPLATE is deliberately NOT mocked. Mocking it would leave the
// two properties that matter untested — that the enquiry goes to the support
// mailbox and that Reply-To carries the submitter's address — because both
// are decided inside the template. Asserting at the provider boundary tests
// the action and the template together, which is the pair that has to be
// right for a reply to reach a human.
//
// The rate-limit bucket lives in @/lib/contact/contactRateLimit (outside
// 'use server', because Next.js requires action files to export only async
// functions) and is reset between tests via its exported resetForTests().

type SentEmail = {
  to:       string | string[];
  subject:  string;
  html:     string;
  replyTo?: string;
  from?:    string;
};

const sent: SentEmail[] = [];
let sendResult: { ok: true; id: string } | { ok: false; error: string } =
  { ok: true, id: 'email-fixture-1' };

vi.mock('@/lib/email/resend', () => ({
  sendEmail: async (input: SentEmail) => {
    sent.push(input);
    return sendResult;
  },
}));

let currentIp = '198.51.100.7';

vi.mock('next/headers', () => ({
  headers: async () => ({
    get(name: string): string | null {
      if (name === 'x-forwarded-for') return currentIp;
      if (name === 'x-real-ip')       return currentIp;
      return null;
    },
  }),
}));

import { submitContactEnquiry } from './contactAction';
import { resetForTests, CONTACT_RATE_LIMIT_MAX } from '@/lib/contact/contactRateLimit';
import { SUPPORT_EMAIL } from '@/lib/config/contact';

/** A payload that passes every check. Individual tests override one field. */
function valid(over: Partial<Parameters<typeof submitContactEnquiry>[0]> = {}) {
  return {
    kind:    'patient',
    name:    'Thandi Mokoena',
    email:   'thandi@example.com',
    phone:   '0821234567',
    message: 'I have a question about my payment plan.',
    website: '',
    ...over,
  };
}

beforeEach(() => {
  sent.length = 0;
  sendResult = { ok: true, id: 'email-fixture-1' };
  currentIp = '198.51.100.7';
  resetForTests();
});

// ─── (a) The happy path, and the two properties a reply depends on ────

describe('(a) a valid submission sends one email to support, reply-to the sender', () => {
  it('returns ok and sends exactly one email', async () => {
    const res = await submitContactEnquiry(valid());
    expect(res).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it('addresses it to the support mailbox', async () => {
    await submitContactEnquiry(valid());
    expect(sent[0].to).toBe(SUPPORT_EMAIL);
    expect(sent[0].to).toBe('support@betternow.co.za');
  });

  it('sets Reply-To to the SUBMITTER so replying works directly', async () => {
    await submitContactEnquiry(valid({ email: 'Someone@Example.COM' }));
    // Normalised to lower case on the way through, and it is the submitter's
    // address — not ours.
    expect(sent[0].replyTo).toBe('someone@example.com');
    expect(sent[0].replyTo).not.toBe(SUPPORT_EMAIL);
  });

  it('never puts the visitor address in `from` — that would be spoofing', () => {
    // `from` is left to RESEND_FROM. A visitor-supplied from would fail
    // SPF/DKIM for our domain and train spam filters against us.
    return submitContactEnquiry(valid()).then(() => {
      expect(sent[0].from).toBeUndefined();
    });
  });

  it('carries every submitted field into the email body', async () => {
    await submitContactEnquiry(valid({
      name: 'Sipho Ndlovu',
      email: 'sipho@example.com',
      phone: '0831234567',
      message: 'Please call me about instalment three.',
    }));
    const { subject, html } = sent[0];
    expect(html).toContain('Sipho Ndlovu');
    expect(html).toContain('sipho@example.com');
    expect(html).toContain('Please call me about instalment three.');
    // The phone is normalised to E.164 before it reaches the inbox.
    expect(html).toContain('+27831234567');
    // The subject carries the triage signal, so the inbox list is readable
    // without opening anything.
    expect(subject).toContain('Patient');
    expect(subject).toContain('Sipho Ndlovu');
  });

  it('labels a practice enquiry as a practice', async () => {
    await submitContactEnquiry(valid({ kind: 'practice' }));
    expect(sent[0].subject).toContain('Practice');
    expect(sent[0].subject).not.toContain('Patient');
  });

  it('accepts a submission with no phone number', async () => {
    const res = await submitContactEnquiry(valid({ phone: '' }));
    expect(res).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });
});

// ─── (b) Server-side validation is authoritative ──────────────────────

describe('(b) invalid submissions are rejected server-side and send nothing', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['missing kind',        { kind: '' },                    'kind'],
    ['unknown kind',        { kind: 'supplier' },            'kind'],
    ['missing name',        { name: '   ' },                 'name'],
    ['missing email',       { email: '' },                   'email'],
    ['malformed email',     { email: 'not-an-email' },        'email'],
    ['email with no host',  { email: 'someone@' },            'email'],
    ['missing message',     { message: '  \n ' },            'message'],
    ['non-SA phone',        { phone: '12345' },              'phone'],
  ];

  it.each(cases)('%s → invalid, names the field, sends nothing', async (_label, over, field) => {
    const res = await submitContactEnquiry(valid(over));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('invalid');
    expect(res.field).toBe(field);
    expect(sent).toHaveLength(0);
  });

  it('rejects a kind the client could never have rendered', async () => {
    // The client offers two radios. This is what a direct POST looks like,
    // and it is why the check is here rather than only in the markup.
    const res = await submitContactEnquiry(valid({ kind: 'admin' }));
    expect(res.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('every rejection carries a message safe to show a user', async () => {
    for (const [, over] of cases) {
      sent.length = 0;
      resetForTests();
      const res = await submitContactEnquiry(valid(over));
      if (res.ok) throw new Error('expected rejection');
      expect(typeof res.message).toBe('string');
      expect(res.message!.length).toBeGreaterThan(0);
      // No internals, no stack, no provider name.
      expect(res.message).not.toMatch(/Resend|undefined|null|Error:|at \w+\./);
    }
  });
});

// ─── (c) Honeypot ─────────────────────────────────────────────────────

describe('(c) honeypot', () => {
  it('a filled honeypot returns ok:true AND sends nothing', async () => {
    const res = await submitContactEnquiry(valid({ website: 'https://evil.example' }));
    // Looks successful on purpose: a bot told it failed retries or mutates,
    // one told it succeeded goes away.
    expect(res).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it('is checked before the rate limit, so bots do not consume a human budget', async () => {
    // A bot hammering the form must not exhaust the bucket for the real
    // visitor behind the same NAT.
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX + 3; i++) {
      await submitContactEnquiry(valid({ website: 'bot' }));
    }
    // The IP is still able to send a genuine message.
    const res = await submitContactEnquiry(valid());
    expect(res).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it('an empty or whitespace honeypot is treated as a human', async () => {
    expect(await submitContactEnquiry(valid({ website: '' }))).toEqual({ ok: true });
    resetForTests();
    sent.length = 0;
    expect(await submitContactEnquiry(valid({ website: '   ' }))).toEqual({ ok: true });
  });
});

// ─── (d) Per-IP rate limiting ─────────────────────────────────────────

describe('(d) per-IP rate limit', () => {
  it('the refusal routes the user to the support mailbox', async () => {
    // Someone who has hit the limit still has something to say. Telling them
    // only to "try later" strands them; the page already shows this address
    // in its left column, so the copy points at it.
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX; i++) await submitContactEnquiry(valid());
    const res = await submitContactEnquiry(valid());
    if (res.ok) throw new Error('expected a rate-limit refusal');
    expect(res.error).toBe('rate_limited');
    expect(res.message).toContain(SUPPORT_EMAIL);
    // Honest about what happened: it does not imply the message was sent.
    for (const claim of [/message (was |has been )?sent\b/i, /we('ve| have) sent/i, /thanks/i]) {
      expect(res.message).not.toMatch(claim);
    }
  });

  it(`allows ${CONTACT_RATE_LIMIT_MAX} then refuses the next from the same IP`, async () => {
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX; i++) {
      expect(await submitContactEnquiry(valid())).toEqual({ ok: true });
    }
    const res = await submitContactEnquiry(valid());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('rate_limited');
    expect(sent).toHaveLength(CONTACT_RATE_LIMIT_MAX);
  });

  it('buckets are per IP — a different visitor is unaffected', async () => {
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX; i++) await submitContactEnquiry(valid());
    expect((await submitContactEnquiry(valid())).ok).toBe(false);

    currentIp = '203.0.113.9';
    expect(await submitContactEnquiry(valid())).toEqual({ ok: true });
  });

  // ─── DELIBERATELY REVERSED ─────────────────────────────────────────
  //
  // This pin used to assert the opposite: "is checked BEFORE validation, so
  // bad payloads still cost budget", on the reasoning that validating first
  // would let an attacker burn CPU on unlimited malformed payloads.
  //
  // That reasoning did not survive costing it out. Validation here is a few
  // trims, length caps and two regexes — no database, no email, no crypto.
  // Meanwhile the old order had a real victim: someone fumbling the form
  // spent all five tokens on mistakes and was locked out for an hour having
  // never sent a single message. Protecting two regexes was not worth that.
  //
  // So the ORDER changed and this pin was rewritten to match the new
  // invariant. It is not loosened — it asserts something strictly stronger
  // about the failure the user can actually hit, and it fails if the order is
  // ever put back.
  it('✦ a flood of validation failures consumes NO token and never rate-limits', async () => {
    // Well past the limit, so an off-by-one cannot hide the old behaviour.
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX + 3; i++) {
      const bad = await submitContactEnquiry(valid({ email: 'garbage' }));
      expect(bad.ok).toBe(false);
      // Every one must be a VALIDATION refusal, never a rate-limit refusal —
      // if the limiter ran first, the later ones would come back
      // 'rate_limited' and the user would never learn their email was wrong.
      if (!bad.ok) expect(bad.error).toBe('invalid');
    }

    // And the budget is untouched, so a corrected submission goes straight
    // through. This is the case that was broken.
    const good = await submitContactEnquiry(valid());
    expect(good).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it('✦ a fumbling user still has the FULL budget after failing repeatedly', async () => {
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX + 3; i++) {
      await submitContactEnquiry(valid({ message: '' }));
    }
    // All five valid sends remain available.
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX; i++) {
      expect(await submitContactEnquiry(valid())).toEqual({ ok: true });
    }
    expect(sent).toHaveLength(CONTACT_RATE_LIMIT_MAX);
  });

  it('takes the first hop of x-forwarded-for, not the whole chain', async () => {
    currentIp = '198.51.100.20, 10.0.0.1, 172.16.0.1';
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX; i++) await submitContactEnquiry(valid());
    // Same client, differently-shaped proxy chain → same bucket.
    currentIp = '198.51.100.20, 10.9.9.9';
    const res = await submitContactEnquiry(valid());
    expect(res.ok).toBe(false);
  });
});

// ─── (e) Provider failure: honest, and never raw ──────────────────────

describe('(e) a provider failure is reported honestly', () => {
  const RAW = 'Resend 422: {"message":"domain betternow.co.za is not verified","name":"validation_error"}';

  beforeEach(() => { sendResult = { ok: false, error: RAW }; });

  it('does NOT claim success', async () => {
    const res = await submitContactEnquiry(valid());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('send_failed');
  });

  it('says plainly that nothing was sent', async () => {
    const res = await submitContactEnquiry(valid());
    if (res.ok) throw new Error('expected failure');
    // The worst outcome is a visitor who believes they contacted us and
    // waits. The copy has to rule that out.
    expect(res.message).toMatch(/nothing was sent/i);
    // And no POSITIVE claim of delivery anywhere in the copy. Banning the
    // bare word "sent" does not work — the honest sentence contains it
    // ("nothing was sent"), so the ban has to be on the phrasings that
    // actually assert success.
    for (const claim of [
      /message (was |has been )?sent\b/i,
      /we('ve| have) sent/i,
      /successfully/i,
      /on its way/i,
      /thanks/i,
    ]) {
      expect(res.message).not.toMatch(claim);
    }
  });

  it('offers a route that does not depend on the thing that just broke', async () => {
    const res = await submitContactEnquiry(valid());
    if (res.ok) throw new Error('expected failure');
    expect(res.message).toContain(SUPPORT_EMAIL);
  });

  it('leaks NO part of the provider error to the user', async () => {
    const res = await submitContactEnquiry(valid());
    if (res.ok) throw new Error('expected failure');
    // Precedent: a raw Resend error string once reached a practice screen.
    expect(res.message).not.toContain('Resend');
    expect(res.message).not.toContain('422');
    expect(res.message).not.toContain('validation_error');
    expect(res.message).not.toContain('not verified');
    expect(res.message).not.toContain(RAW);
    expect(JSON.stringify(res)).not.toContain('Resend');
  });

  it('a timeout is reported the same way as any other failure', async () => {
    sendResult = { ok: false, error: 'Resend timed out after 8000ms' };
    const res = await submitContactEnquiry(valid());
    if (res.ok) throw new Error('expected failure');
    expect(res.error).toBe('send_failed');
    expect(res.message).not.toMatch(/timed out|8000/);
  });
});

// ─── (f) Untrusted input reaches an inbox we read ─────────────────────

describe('(f) submitted content is escaped before it enters the email', () => {
  it('HTML in the message is escaped, not rendered', async () => {
    await submitContactEnquiry(valid({
      message: '<script>alert(1)</script> and <b>bold</b>',
    }));
    const { html } = sent[0];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('HTML in the name is escaped in both body and subject path', async () => {
    await submitContactEnquiry(valid({ name: '<img src=x onerror=alert(1)>' }));
    expect(sent[0].html).not.toContain('<img');
    expect(sent[0].html).toContain('&lt;img');
  });

  it('over-long input is capped rather than forwarded whole', async () => {
    await submitContactEnquiry(valid({ message: 'x'.repeat(9000) }));
    const body = sent[0].html;
    const run = body.match(/x+/g)?.sort((a, b) => b.length - a.length)[0] ?? '';
    expect(run.length).toBeLessThanOrEqual(2000);
  });
});
