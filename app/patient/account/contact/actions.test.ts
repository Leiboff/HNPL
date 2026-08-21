import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Behavioural tests — signed-in patient contact enquiry action ───────
//
// Mirrors app/contact/contactAction.test.ts's shape: sendEmail is mocked so
// the exact request the provider would receive can be asserted, and the
// email TEMPLATE is deliberately NOT mocked, for the same reason — the
// properties that matter (support mailbox, Reply-To, and here, that
// name/email/phone/ID come from the account rather than the input) are
// decided inside it.
//
// The rate-limit bucket is the SAME module the public form uses
// (lib/contact/contactRateLimit) — the action keys it by `patient:${uid}`
// rather than IP, so resetForTests() between cases here does not need its
// own bucket implementation, just a reset of the shared one.

type SentEmail = { to: string | string[]; subject: string; html: string; replyTo?: string; from?: string };

const sent: SentEmail[] = [];
let sendResult: { ok: true; id: string } | { ok: false; error: string } =
  { ok: true, id: 'email-fixture-1' };

vi.mock('@/lib/email/resend', () => ({
  sendEmail: async (input: SentEmail) => {
    sent.push(input);
    return sendResult;
  },
}));

// Auth + profile — one Supabase client stub, same client for both, mirroring
// how the action itself only ever creates one.
const authUser: { value: { id: string; email: string | null } | null } = { value: null };
const profileRow: { value: Record<string, unknown> | null } = { value: null };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser.value }, error: null }),
    },
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: profileRow.value, error: null }),
          }),
        }),
      };
    },
  })),
}));

import { submitPatientContactEnquiry } from './actions';
import { resetForTests, CONTACT_RATE_LIMIT_MAX } from '@/lib/contact/contactRateLimit';
import { SUPPORT_EMAIL } from '@/lib/config/contact';

function signIn(over: Partial<{ id: string; email: string | null }> = {}) {
  authUser.value = { id: 'patient-1', email: 'thandi@example.com', ...over };
}

function withProfile(over: Partial<Record<string, unknown>> = {}) {
  profileRow.value = {
    first_name: 'Thandi', last_name: 'Mokoena', phone: '0821234567', sa_id_number: null, ...over,
  };
}

beforeEach(() => {
  sent.length = 0;
  sendResult = { ok: true, id: 'email-fixture-1' };
  authUser.value = null;
  profileRow.value = null;
  resetForTests();
});

describe('unauthenticated callers are refused, not fallen through to a guest send', () => {
  it('returns not_authenticated and sends nothing', async () => {
    const res = await submitPatientContactEnquiry('Where is my instalment?');
    expect(res).toEqual({ ok: false, error: 'not_authenticated', message: 'Please sign in and try again.' });
    expect(sent).toHaveLength(0);
  });
});

describe('the message is the only client-supplied field', () => {
  beforeEach(() => { signIn(); withProfile(); });

  it('rejects an empty message without sending', async () => {
    const res = await submitPatientContactEnquiry('   ');
    expect(res).toEqual({ ok: false, error: 'invalid', message: 'Please add a short message so we know how to help.' });
    expect(sent).toHaveLength(0);
  });

  it('a valid message sends exactly one email to support', async () => {
    const res = await submitPatientContactEnquiry('Please call me about instalment three.');
    expect(res).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(SUPPORT_EMAIL);
  });
});

describe('name, email, phone and ID come from the account — never from the input', () => {
  it('the signed-in profile\'s name, email and phone land in the email body', async () => {
    signIn({ id: 'patient-1', email: 'thandi@example.com' });
    withProfile({ first_name: 'Thandi', last_name: 'Mokoena', phone: '0821234567' });

    await submitPatientContactEnquiry('I have a question about my payment plan.');

    const { html, replyTo } = sent[0];
    expect(html).toContain('Thandi Mokoena');
    expect(html).toContain('thandi@example.com');
    expect(html).toContain('0821234567');
    expect(replyTo).toBe('thandi@example.com');
  });

  it('there is no name/email/phone/ID parameter for a caller to pass in the first place', () => {
    // submitPatientContactEnquiry's only parameter is the message — this is
    // a structural guarantee, not a runtime check, that nothing else can be
    // supplied by the client.
    expect(submitPatientContactEnquiry.length).toBe(1);
  });

  it('a masked SA ID reaches the email when one is on file', async () => {
    signIn();
    withProfile({ sa_id_number: '8501015800082' });

    await submitPatientContactEnquiry('Please verify my account.');

    // decryptIdForDisplay passes a plain (non "v1:"-prefixed) string through
    // unchanged, and maskSaId reveals only the last four digits.
    expect(sent[0].html).toContain('•••••••••0082');
    expect(sent[0].html).not.toContain('8501015800082');
  });

  it('no ID row appears in the email when the profile has none on file', async () => {
    signIn();
    withProfile({ sa_id_number: null });

    await submitPatientContactEnquiry('Just a question.');

    expect(sent[0].html).not.toContain('Patient ID');
  });

  it('marks the enquiry as verified — the reader-facing trust signal an anonymous submission never gets', async () => {
    signIn();
    withProfile();

    await submitPatientContactEnquiry('Hello');

    expect(sent[0].html).toContain('signed-in account');
    expect(sent[0].html).not.toContain('unverified');
  });

  it('a blank name on the profile still sends, with a fallback label', async () => {
    signIn();
    withProfile({ first_name: null, last_name: null });

    const res = await submitPatientContactEnquiry('Hi');
    expect(res).toEqual({ ok: true });
    expect(sent[0].html).toContain('betternow patient');
  });
});

describe('rate limiting is keyed per account, not per IP', () => {
  it('two different patients each get their own budget', async () => {
    signIn({ id: 'patient-a' });
    withProfile();
    for (let i = 0; i < CONTACT_RATE_LIMIT_MAX; i++) {
      const res = await submitPatientContactEnquiry(`message ${i}`);
      expect(res).toEqual({ ok: true });
    }
    // The next one from the SAME account is rate limited.
    const sixth = await submitPatientContactEnquiry('one more');
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.error).toBe('rate_limited');

    // A different account is unaffected.
    signIn({ id: 'patient-b' });
    const otherPatient = await submitPatientContactEnquiry('hello from someone else');
    expect(otherPatient).toEqual({ ok: true });
  });
});

describe('a provider failure is reported honestly, matching the public form\'s copy contract', () => {
  it('does not claim success, and names no provider detail', async () => {
    signIn();
    withProfile();
    sendResult = { ok: false, error: 'Resend 422: domain not verified' };

    const res = await submitPatientContactEnquiry('Help please');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('send_failed');
      expect(res.message).not.toContain('Resend');
      expect(res.message).toContain('nothing was sent');
    }
  });
});
