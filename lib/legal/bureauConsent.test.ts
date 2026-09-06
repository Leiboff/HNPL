import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hasBureauConsent, BUREAU_CONSENT_VERSIONS } from './bureauConsent';
import { hasAcceptedTerms } from './acceptance';
import { TERMS_VERSION } from './terms';
import { assessAtSignup, __resetInFlightForTests, type AssessmentDeps } from '@/lib/experian/assessAtSignup';
import { soapSuccess, FIXTURES } from '@/lib/testing/experianFixtures';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';

// ─── The bureau consent gate ───────────────────────────────────────────
//
// A bureau enquiry discloses personal information to a third party and puts
// a permanent entry on a real person's credit file. The lawful basis under
// POPIA §71 has to be EVIDENCED, which means a recorded acceptance row — not
// a checkbox that was rendered, and not an inference from having finished
// onboarding.

const ACCEPTED = '2026-09-01T10:00:00.000Z';

describe('hasBureauConsent — strict, with no grandfather clause', () => {
  it('accepts a recorded acceptance of an allowlisted version', () => {
    expect(hasBureauConsent({ terms_accepted_at: ACCEPTED, terms_version: '1.0' })).toBe(true);
  });

  it('refuses a null row — "we do not know" has to mean no on this gate', () => {
    expect(hasBureauConsent(null)).toBe(false);
    expect(hasBureauConsent(undefined)).toBe(false);
  });

  it('refuses a missing timestamp even with a good version', () => {
    expect(hasBureauConsent({ terms_accepted_at: null, terms_version: '1.0' })).toBe(false);
  });

  it('refuses a missing or blank version even with a timestamp', () => {
    expect(hasBureauConsent({ terms_accepted_at: ACCEPTED, terms_version: null })).toBe(false);
    expect(hasBureauConsent({ terms_accepted_at: ACCEPTED, terms_version: '   ' })).toBe(false);
  });

  it('refuses a version outside the allowlist', () => {
    // The failure this guards is silent and points the wrong way: a future
    // T&Cs version that reworded or dropped clause 10 would otherwise pass
    // automatically, and enquiries would keep happening on a basis that no
    // longer exists. Refusing to pull is recoverable; pulling without a basis
    // is not.
    for (const version of ['2.0', '1.1', '0.9', '1', 'v1.0']) {
      expect(hasBureauConsent({ terms_accepted_at: ACCEPTED, terms_version: version }), version)
        .toBe(false);
    }
  });

  it('the allowlist covers the version the app currently stamps', () => {
    // If this fails, either TERMS_VERSION moved without anyone confirming the
    // new document still carries the §71 disclosure, or the allowlist is
    // stale. Both are worth stopping for: the first would refuse every
    // enquiry, the second would allow one on unreviewed wording.
    expect(BUREAU_CONSENT_VERSIONS).toContain(TERMS_VERSION);
  });
});

describe('the divergence from hasAcceptedTerms is deliberate', () => {
  it('a GRANDFATHERED row passes the app gate and fails the bureau gate', () => {
    // This is the whole reason the two predicates exist separately.
    // hasAcceptedTerms says yes because the account finished onboarding
    // before acceptance was recorded at all — correct for "may this person
    // use the app", and not evidence of anything for "may we pull their
    // credit file".
    const grandfathered = { terms_accepted_at: null, onboarding_completed: true };
    expect(hasAcceptedTerms(grandfathered), 'may use the app').toBe(true);

    expect(
      hasBureauConsent({ terms_accepted_at: null, terms_version: null }),
      'but is not consent to a bureau enquiry',
    ).toBe(false);
  });

  it('hasBureauConsent does not look at onboarding_completed at all', () => {
    // Passed deliberately as an extra property: even if a caller hands over
    // the whole profile row, the completion flag must not rescue a missing
    // acceptance.
    const row = { terms_accepted_at: null, terms_version: null, onboarding_completed: true };
    expect(hasBureauConsent(row)).toBe(false);
  });
});

// ─── The gate, wired to the real predicate ─────────────────────────────

describe('an out-of-allowlist version blocks the billable call', () => {
  const HMAC_KEY = 'jXIQJ/clclWd6qkwBdP97RBEB0ePkRiwBMfh5gm3cJA=';
  let fetchMock: ReturnType<typeof vi.fn>;

  function depsForVersion(version: string | null): AssessmentDeps {
    fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => soapSuccess(FIXTURES.real_su_credit_active),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    return {
      config: {
        env: 'uat', username: 'u', password: 'p', origin: 'BetterNow',
        pVersion: '4.0', timeoutMs: 5_000,
      },
      // The REAL predicate, over a row shaped like the profile read.
      hasBureauConsent: async () =>
        hasBureauConsent({ terms_accepted_at: ACCEPTED, terms_version: version }),
      findFreshEnquiry: async () => null,
      openAttempt: async () => 'attempt-1',
      closeAttempt: async () => {},
    };
  }

  beforeEach(() => {
    process.env.SA_ID_LOOKUP_HMAC_KEY = HMAC_KEY;
    __resetInFlightForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetInFlightForTests();
  });

  it('an allowlisted version DOES reach the transport', async () => {
    // The control. Without this the test below would pass on a gate that
    // refuses everything.
    await assessAtSignup('p1', VALID_SA_ID, depsForVersion('1.0'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a version outside the allowlist does not', async () => {
    const out = await assessAtSignup('p1', VALID_SA_ID, depsForVersion('2.0'));
    expect(fetchMock, 'no billable call on unreviewed wording').not.toHaveBeenCalled();
    expect(out.decision).toBe('error');
    expect(out.detail).toMatch(/no recorded bureau consent/);
  });

  it('a missing version does not either', async () => {
    await assessAtSignup('p1', VALID_SA_ID, depsForVersion(null));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
