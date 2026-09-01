import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── ADVERSARIAL: can anyone get an account without agreeing? ──────────
//
// The question these tests exist to answer, asked from the attacker's
// side rather than the author's: a person WANTS an account and does NOT
// want to tick the box. What can they actually do?
//
// The existing terms suites (app/terms-acceptance.test.ts,
// app/oauth-terms-consent.test.ts, lib/legal/acceptance.test.ts) are
// almost entirely SOURCE-TEXT assertions — they read route.ts and match
// regexes against it. That pins the code against a careless edit, which
// is worth having, but it cannot answer this question: a grep proves a
// line exists, not that the handler refuses when you attack it.
//
// So these drive the REAL GET handlers of /auth/callback and
// /auth/require-terms against a fake Supabase, with attacker-controlled
// URLs and attacker-controlled database failures, and assert on what
// comes back out — the redirect, the Set-Cookie header, and whether an
// acceptance was ever written.
//
// Every test here is written as an attempt, not as a description. If one
// of them ever goes green in the "attack succeeded" direction, someone
// can register without agreeing.

// ─── The fake Supabase ────────────────────────────────────────────────

type ProfileRow = {
  id:                    string;
  first_name?:           string | null;
  last_name?:            string | null;
  role?:                 string | null;
  terms_accepted_at:     string | null;
  onboarding_completed?: boolean | null;
} | null;

type Write = { op: 'update' | 'insert'; values: Record<string, unknown>; filters: Record<string, unknown> };

const state: {
  profile:      ProfileRow;
  readError:    unknown;
  writeError:   unknown;
  /** PostgREST's silent no-op: an UPDATE that matches nothing is not an error. */
  updateMatchesNoRows: boolean;
  /** The row comes back, but the column did not actually land. */
  updateReturnsNullStamp: boolean;
  insertError:  unknown;
  /** The client throws rather than reporting — a reset connection, not a SQL error. */
  readThrows:   boolean;
  writes:       Write[];
  sessionUser:  { id: string; email: string; identities: { provider: string }[]; user_metadata: Record<string, unknown> } | null;
  exchangeError: unknown;
  signOutResult: 'ok' | 'returns-error' | 'throws';
  signOutCalls: { scope?: string }[];
} = {
  profile: null,
  readError: null,
  writeError: null,
  updateMatchesNoRows: false,
  updateReturnsNullStamp: false,
  insertError: null,
  readThrows: false,
  writes: [],
  sessionUser: null,
  exchangeError: null,
  signOutResult: 'ok',
  signOutCalls: [],
};

function fakeTable() {
  const filters: Record<string, unknown> = {};
  let op: 'select' | 'update' | 'insert' | null = null;
  let pending: Record<string, unknown> = {};

  const builder: Record<string, unknown> = {
    select: () => {
      if (op === 'update') {
        // Terminal: the route reads the row BACK rather than trusting a
        // null error, so this is where an update resolves.
        state.writes.push({ op: 'update', values: pending, filters: { ...filters } });
        if (state.writeError) return Promise.resolve({ data: null, error: state.writeError });
        if (state.updateMatchesNoRows) return Promise.resolve({ data: [], error: null });
        const stamp = state.updateReturnsNullStamp ? null : (pending.terms_accepted_at ?? null);
        if (state.profile) state.profile = { ...state.profile, ...pending } as ProfileRow;
        return Promise.resolve({ data: [{ terms_accepted_at: stamp }], error: null });
      }
      op = 'select';
      return builder;
    },
    update: (values: Record<string, unknown>) => { op = 'update'; pending = values; return builder; },
    insert: (values: Record<string, unknown>) => {
      state.writes.push({ op: 'insert', values, filters: {} });
      if (state.insertError) return Promise.resolve({ error: state.insertError });
      state.profile = values as ProfileRow;
      return Promise.resolve({ error: null });
    },
    eq: (col: string, val: unknown) => { filters[col] = val; return builder; },
    is: () => builder,
    maybeSingle: async () => {
      if (state.readThrows) throw new Error('connection reset');
      if (state.readError) return { data: null, error: state.readError };
      return { data: state.profile, error: null };
    },
  };
  return builder;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => fakeTable() }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: state.exchangeError }),
      getUser: async () => ({ data: { user: state.sessionUser }, error: null }),
      signOut: async (opts?: { scope?: string }) => {
        state.signOutCalls.push(opts ?? {});
        if (state.signOutResult === 'throws') throw new Error('network');
        if (state.signOutResult === 'returns-error') return { error: { message: 'revocation failed' } };
        return { error: null };
      },
    },
  }),
}));

import { GET as callbackGET }     from './callback/route';
import { GET as requireTermsGET } from './require-terms/route';
import { issueConsentToken, TERMS_CONSENT_COOKIE } from '@/lib/legal/consentToken';

// ─── Attacker helpers ─────────────────────────────────────────────────

const ATTACKER_ID = 'attacker-user-id';
const VICTIM_ID   = 'victim-user-id';

/** A browser holding a live Supabase session, plus an unrelated cookie. */
function withAuthCookies(req: NextRequest): NextRequest {
  req.cookies.set('sb-project-auth-token', 'live-session');
  req.cookies.set('sb-project-auth-token.1', 'chunk-two');
  req.cookies.set('cf_bm', 'unrelated');
  return req;
}

function callbackReq(query: string): NextRequest {
  return withAuthCookies(new NextRequest(`http://test/auth/callback${query}`));
}

/**
 * A callback request carrying a REAL server-issued consent token.
 *
 * AMENDED 2026-09-02 (audit A-14). `?terms_accepted=1` alone used to be
 * enough, and that was the finding: the legal record was written on the
 * strength of a parameter the visitor's own browser supplied, so it attested
 * to nothing the platform had done. The token is minted by proxy.ts when it
 * serves the page that renders the acceptance control, and the callback
 * requires it.
 *
 * Every test below that exercises the ACCEPTED path now uses this helper.
 * The one that does not is the new ATTACK 2b — a param with no token — which
 * is the defect itself, asserted closed.
 */
function acceptedCallbackReq(query: string): NextRequest {
  const req = callbackReq(query);
  req.cookies.set(TERMS_CONSENT_COOKIE, issueConsentToken().token);
  return req;
}

/** Cookie names this response tells the browser to drop. */
function clearedCookies(res: Response): string[] {
  return res.headers.getSetCookie()
    .filter((c) => /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c))
    .map((c) => c.split('=')[0]);
}

function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

/** Did anything write an acceptance to the profiles table? */
function acceptanceWrites(): Write[] {
  return state.writes.filter((w) => 'terms_accepted_at' in w.values);
}

function googleArrival(overrides: Partial<NonNullable<typeof state.sessionUser>> = {}) {
  return {
    id:            ATTACKER_ID,
    email:         'attacker@example.com',
    identities:    [{ provider: 'google' }],
    user_metadata: { given_name: 'Att', family_name: 'Acker' },
    ...overrides,
  };
}

beforeEach(() => {
  // The consent token is HMAC-signed, and this suite drives the real route,
  // so it needs a real key. Set here rather than in the harness config
  // because the KEY is part of what is under test: a route that stopped
  // requiring a token would still pass every assertion below if the token
  // were mocked away.
  process.env.TERMS_CONSENT_SECRET = 'adversarial-suite-signing-key';
  state.profile = null;
  state.readError = null;
  state.writeError = null;
  state.updateMatchesNoRows = false;
  state.updateReturnsNullStamp = false;
  state.insertError = null;
  state.readThrows = false;
  state.writes = [];
  state.sessionUser = googleArrival();
  state.exchangeError = null;
  state.signOutResult = 'ok';
  state.signOutCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 1 — Just sign in with Google and skip the tick entirely
// ══════════════════════════════════════════════════════════════════════
//
// The cheapest attack there is, and the one a real person stumbles into:
// use the Google button on /login (a sign-in screen, which by design
// carries a disclosure rather than a tick) and let Supabase provision a
// brand-new account on the way through. No box was ever ticked.

describe('ATTACK 1 — Google sign-in with no acceptance anywhere', () => {
  it('does not keep the session, and creates no accepted account', async () => {
    // Trigger made the row; nothing has ever accepted on it.
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null, first_name: '', last_name: '' };

    const res = await callbackGET(callbackReq('?code=valid-pkce'));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(acceptanceWrites()).toHaveLength(0);
  });

  it('deletes the auth cookies on the response the browser actually receives', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null, first_name: '', last_name: '' };

    const res = await callbackGET(callbackReq('?code=valid-pkce'));

    // Both chunks — a half-deleted chunked cookie is worse than either
    // extreme, because @supabase/ssr reassembles whatever it finds.
    expect(clearedCookies(res)).toEqual(
      expect.arrayContaining(['sb-project-auth-token', 'sb-project-auth-token.1']),
    );
    // And nothing that isn't ours.
    expect(clearedCookies(res)).not.toContain('cf_bm');
  });

  it('revokes GLOBALLY, so the refresh token is dead upstream and not just unreachable here', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    await callbackGET(callbackReq('?code=valid-pkce'));

    expect(state.signOutCalls).toContainEqual({ scope: 'global' });
  });

  it('when there is no profile row at all, refuses WITHOUT provisioning one', async () => {
    // The defensive-provision branch must not be reachable without a tick:
    // if we are the ones creating the row, no tick means no account.
    state.profile = null;

    const res = await callbackGET(callbackReq('?code=valid-pkce'));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(state.writes.filter((w) => w.op === 'insert')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 2 — Forge the consent parameter
// ══════════════════════════════════════════════════════════════════════
//
// redirectTo is built in the browser, so the attacker owns every
// character of the URL Google sends them back to. The interesting
// question is not whether they can set `terms_accepted` — they can — but
// whether anything OTHER than a deliberate, exact assertion slips
// through, and whether the assertion can be pointed at someone else.

describe('ATTACK 2 — forging ?terms_accepted', () => {
  const NEAR_MISSES = [
    'true', 'TRUE', 'True', 'yes', 'on', 'Y',
    '0', '2', '01', '1.0', '11',
    '', ' 1', '%201', '1%20', '1%09',
    'null', 'undefined', '[1]', '1,1',
  ];

  // These were the readings of a parameter that used to decide the outcome.
  // They still pass, and now for a stronger reason: without a server-issued
  // token no value of it is an acceptance, including '1'.
  it.each(NEAR_MISSES)('a value of "%s" is NOT an acceptance', async (value) => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const res = await callbackGET(callbackReq(`?code=valid-pkce&terms_accepted=${value}`));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(acceptanceWrites()).toHaveLength(0);
  });

  it('no spelling of the param matters any more, in either direction', async () => {
    // This used to be "a repeated param does not let the second copy vote for
    // the first" — URLSearchParams.get returns the FIRST value, so `=x&=1`
    // had to lose. That test, and the NEAR_MISSES table above it, were
    // careful readings of a parameter that decided the outcome.
    //
    // Since A-14 it decides nothing: the token does. So the property worth
    // pinning is the inverse of the old one — the param cannot help WITHOUT a
    // token, and cannot hurt WITH one. If either half ever fails, the URL has
    // become load-bearing again.
    for (const query of [
      '?code=valid-pkce&terms_accepted=x&terms_accepted=1',
      '?code=valid-pkce&terms_accepted=0',
      '?code=valid-pkce',
    ]) {
      state.writes = [];
      state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
      expect(location(await callbackGET(callbackReq(query))), `${query} without a token`)
        .toBe('http://test/signup?error=terms');
      expect(acceptanceWrites()).toHaveLength(0);

      state.writes = [];
      state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
      expect(location(await callbackGET(acceptedCallbackReq(query))), `${query} with a token`)
        .toBe('http://test/dashboard');
      expect(acceptanceWrites()).toHaveLength(1);
    }
  });

  // ── The one that USED to work, and no longer does ────────────────────
  //
  // This block used to end with the note that `terms_accepted=1` is a
  // client assertion and is honoured, and that this is the design rather
  // than a defect — the tick happens before any session exists, so there is
  // no authenticated row to stamp and the acceptance had to travel on the
  // URL. The blast radius was the argument: an attacker can assert their OWN
  // agreement, which is the same as ticking a box they did not read.
  //
  // Audit A-14 rejected that reasoning, on a point the blast-radius argument
  // misses entirely. The problem was never what an attacker gains — nobody
  // attacks this — it is that THE RECORD IS NOT EVIDENCE. For an NCA credit
  // agreement, and for POPIA §11 consent to process special personal
  // information, the column's whole value is that the platform can show the
  // documents were displayed. A flag the customer set could not show that,
  // and the customer disputing it is the person who would point that out.
  //
  // So the acceptance no longer travels on the URL. It travels as an
  // httpOnly HMAC-signed token minted by proxy.ts when it SERVES the page
  // that renders the acceptance control, carrying both version strings and
  // both document digests. Every test above and below that reaches the
  // accepted path now supplies one, via acceptedCallbackReq.

  it('a param with NO server token records nothing — the finding, closed', async () => {
    // Verbatim what the audit asked for: "a callback carrying
    // terms_accepted=1 with no matching server-issued token must return
    // needs-terms".
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const res = await callbackGET(callbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(acceptanceWrites()).toHaveLength(0);
  });

  it('a FORGED token records nothing either', async () => {
    // The obvious next move once the param stops working: make up a cookie.
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const req = callbackReq('?code=valid-pkce&terms_accepted=1');
    req.cookies.set(TERMS_CONSENT_COOKIE, 'eyJ2IjoidjEifQ.not-a-real-signature');
    const res = await callbackGET(req);

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(acceptanceWrites()).toHaveLength(0);
  });

  it('an EXPIRED token records nothing — a stale one is not a fresh reading', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const req = callbackReq('?code=valid-pkce&terms_accepted=1');
    const stale = issueConsentToken(new Date(Date.now() - 60 * 60 * 1000)).token;
    req.cookies.set(TERMS_CONSENT_COOKIE, stale);
    const res = await callbackGET(req);

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(acceptanceWrites()).toHaveLength(0);
  });

  it('a valid token with NO param still records — the token is what counts', async () => {
    // The param is now only read to log the mismatch. Asserting this stops a
    // future edit from quietly making the URL load-bearing again.
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce'));

    expect(location(res)).toBe('http://test/dashboard');
    expect(acceptanceWrites()).toHaveLength(1);
  });

  it('the recorded row carries the document digests, not just the versions', async () => {
    // "Which text did they accept" has to be answerable from the row. A
    // version string alone is only as good as nobody having edited a clause
    // without bumping it.
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    const values = acceptanceWrites()[0].values;
    expect(values.terms_doc_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(values.privacy_doc_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(values.terms_doc_sha256).not.toBe(values.privacy_doc_sha256);
  });

  it('is honoured with a server-issued token — the documented, self-asserted case', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/dashboard');
    expect(acceptanceWrites()).toHaveLength(1);
  });

  it('stamps the SESSION\'s user, never an id supplied on the URL', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    await callbackGET(acceptedCallbackReq(
      `?code=valid-pkce&terms_accepted=1&user_id=${VICTIM_ID}&id=${VICTIM_ID}&sub=${VICTIM_ID}`,
    ));

    const write = acceptanceWrites()[0];
    expect(write.filters.id).toBe(ATTACKER_ID);
    expect(write.filters.id).not.toBe(VICTIM_ID);
  });

  it('never re-dates an acceptance already on record (write-once audit fact)', async () => {
    // An attacker replaying the flow cannot roll the recorded date, or
    // the recorded VERSION, forward onto a newer set of terms.
    state.profile = { id: ATTACKER_ID, terms_accepted_at: '2024-01-01T00:00:00Z', onboarding_completed: null };

    await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(acceptanceWrites()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 3 — Aim past the gate with ?next=
// ══════════════════════════════════════════════════════════════════════

describe('ATTACK 3 — steering the landing with ?next', () => {
  it('a deep link into onboarding does not survive the refusal', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const res = await callbackGET(callbackReq('?code=valid-pkce&next=%2Fonboarding%2Fphone'));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(location(res)).not.toContain('onboarding');
  });

  it.each([
    ['//evil.example.com',           'protocol-relative'],
    ['https://evil.example.com',     'absolute'],
    ['http://evil.example.com/x',    'absolute http'],
  ])('clamps a %s ?next to /dashboard even on the ACCEPTED path (%s)', async (next) => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const res = await callbackGET(acceptedCallbackReq(
      `?code=valid-pkce&terms_accepted=1&next=${encodeURIComponent(next)}`,
    ));

    expect(location(res)).toBe('http://test/dashboard');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 4 — Break the write and keep the session
// ══════════════════════════════════════════════════════════════════════
//
// The subtler attack, and the one that produced the original field bug:
// don't fight the gate, make the RECORDING fail. If a broken write means
// "carry on", then anyone who can degrade the database — or who simply
// gets lucky during an outage — lands inside the app with nothing on
// record. Every one of these must fail CLOSED.

describe('ATTACK 4 — degrade the write, keep the session', () => {
  it('an unreadable profile row does not resolve to "probably fine"', async () => {
    state.readError = { message: 'permission denied', code: '42501' };

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/signup?error=terms_write');
    expect(clearedCookies(res)).toContain('sb-project-auth-token');
  });

  it('an UPDATE that silently matches no rows is a failure, not a success', async () => {
    // PostgREST does not error on a zero-row UPDATE. Trusting a null
    // error here is exactly how "the write didn't happen" becomes "the
    // write happened".
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
    state.updateMatchesNoRows = true;

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/signup?error=terms_write');
  });

  it('a row that comes back with the column still NULL is a failure', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
    state.updateReturnsNullStamp = true;

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/signup?error=terms_write');
  });

  it('a refused UPDATE is a failure', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
    state.writeError = { message: 'deadlock detected', code: '40P01' };

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/signup?error=terms_write');
  });

  it('a failed defensive provision is a failure', async () => {
    state.profile = null;
    state.insertError = { message: 'insert refused', code: '42501' };

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/signup?error=terms_write');
    expect(clearedCookies(res)).toContain('sb-project-auth-token');
  });

  it('a THROWN error rather than a reported one refuses too', async () => {
    // A reset connection does not come back as { error } — it comes back
    // as an exception. The sync used to swallow those and redirect anyway.
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
    state.readThrows = true;

    const res = await callbackGET(acceptedCallbackReq('?code=valid-pkce&terms_accepted=1'));

    expect(location(res)).toBe('http://test/signup?error=terms_write');
    expect(clearedCookies(res)).toContain('sb-project-auth-token');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 5 — Make the sign-out fail
// ══════════════════════════════════════════════════════════════════════
//
// The actual field bug, from the attacker's side. supabase-js reports a
// failed revocation by RETURNING { error } and early-returns BEFORE
// removing the stored session. A refusal that leans on signOut is a
// refusal an attacker can defeat by making one network call fail.

describe('ATTACK 5 — defeat the refusal by breaking signOut', () => {
  it('a signOut that RETURNS an error still loses the cookies', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
    state.signOutResult = 'returns-error';

    const res = await callbackGET(callbackReq('?code=valid-pkce'));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(clearedCookies(res)).toEqual(
      expect.arrayContaining(['sb-project-auth-token', 'sb-project-auth-token.1']),
    );
  });

  it('a signOut that THROWS still loses the cookies', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };
    state.signOutResult = 'throws';

    const res = await callbackGET(callbackReq('?code=valid-pkce'));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(clearedCookies(res)).toContain('sb-project-auth-token');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 6 — Claim the grandfather clause
// ══════════════════════════════════════════════════════════════════════
//
// One account shape is let through with a NULL acceptance: one whose
// onboarding_completed is already true. If that flag were assertable,
// it would be the whole gate's back door.

describe('ATTACK 6 — forging the grandfather flag', () => {
  it.each([
    ['a string "true"', 'true'],
    ['a string "1"',    '1'],
    ['the number 1',    1],
    ['a non-empty object', {}],
  ])('%s does not satisfy onboarding_completed', async (_label, value) => {
    state.profile = {
      id: ATTACKER_ID,
      terms_accepted_at: null,
      onboarding_completed: value as unknown as boolean,
    };

    const res = await callbackGET(callbackReq('?code=valid-pkce'));

    expect(location(res)).toBe('http://test/signup?error=terms');
  });

  it('only a real boolean true grandfathers — and that column is server-written', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: true };

    const res = await callbackGET(callbackReq('?code=valid-pkce'));

    expect(location(res)).toBe('http://test/dashboard');
  });
});

// ══════════════════════════════════════════════════════════════════════
// ATTACK 7 — Hold the session past the callback
// ══════════════════════════════════════════════════════════════════════
//
// Suppose the callback's refusal is somehow survived — the browser keeps
// a live cookie and walks straight to a patient surface. The page gate
// (lib/legal/termsGate.ts) sends them to /auth/require-terms, which is
// where a session can actually be ended. So that route is attacked from
// both sides: it must end an unaccepted session, and it must NOT be
// usable as a drive-by logout link against an account that is fine.

describe('ATTACK 7 — /auth/require-terms', () => {
  beforeEach(() => { state.sessionUser = googleArrival(); });

  it('ends an unaccepted session and clears its cookies', async () => {
    state.profile = { id: ATTACKER_ID, terms_accepted_at: null, onboarding_completed: null };

    const res = await requireTermsGET(withAuthCookies(new NextRequest('http://test/auth/require-terms')));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(clearedCookies(res)).toEqual(
      expect.arrayContaining(['sb-project-auth-token', 'sb-project-auth-token.1']),
    );
    expect(state.signOutCalls).toContainEqual({ scope: 'global' });
  });

  it('CANNOT be used as a drive-by logout against an accepted account', async () => {
    // e.g. an <img src="/auth/require-terms"> on a forum. A GET that logs
    // people out is only safe because it re-verifies first.
    state.profile = { id: ATTACKER_ID, terms_accepted_at: '2026-01-01T00:00:00Z', onboarding_completed: true };

    const res = await requireTermsGET(withAuthCookies(new NextRequest('http://test/auth/require-terms')));

    expect(location(res)).toBe('http://test/dashboard');
    expect(clearedCookies(res)).toHaveLength(0);
    expect(state.signOutCalls).toHaveLength(0);
  });

  it('fails CLOSED when the profile row cannot be read', async () => {
    state.readError = { message: 'timeout' };

    const res = await requireTermsGET(withAuthCookies(new NextRequest('http://test/auth/require-terms')));

    expect(location(res)).toBe('http://test/signup?error=terms');
    expect(clearedCookies(res)).toContain('sb-project-auth-token');
  });

  it('a session that cannot be identified is cleared, not waved through', async () => {
    state.sessionUser = null;

    const res = await requireTermsGET(withAuthCookies(new NextRequest('http://test/auth/require-terms')));

    expect(location(res)).toBe('http://test/signup?error=terms');
  });
});
