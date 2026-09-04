import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';
import { VALID_SA_IDS, INVALID_SA_IDS } from '@/lib/testing/saIdFixtures';

// ─── submitIdentityForVerification — local gates run before any network call ──
//
// Cases 17-19: an invalid ID, an under-18 ID, or missing consent must
// each independently prevent the DHA lookup (and therefore the Didit
// session-create call) from ever happening. We assert this by spying on
// resolveIdentityRoute — if it's never invoked, no HTTP call was made,
// since that's the ONLY thing in this action that talks to the network.

const { resolveIdentityRoute } = vi.hoisted(() => ({ resolveIdentityRoute: vi.fn() }));
vi.mock('@/lib/onboarding/dhaVerification', () => ({ resolveIdentityRoute }));

const { createDhaFaceMatchSession, createDiditSession, diditAppBaseUrl } = vi.hoisted(() => ({
  createDhaFaceMatchSession: vi.fn(),
  createDiditSession:        vi.fn(),
  diditAppBaseUrl:           vi.fn(() => 'https://app.test'),
}));
vi.mock('@/lib/didit/client', () => ({ createDhaFaceMatchSession, createDiditSession, diditAppBaseUrl }));

type Row = Record<string, unknown>;
const dbState: { profiles: Row[] } = { profiles: [] };

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      if (table !== 'profiles') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: dbState.profiles[0] ?? null, error: null }),
          }),
        }),
        update: (row: Row) => ({
          eq: async (_col: string, val: unknown) => {
            const idx = dbState.profiles.findIndex((p) => p.id === val);
            if (idx >= 0) dbState.profiles[idx] = { ...dbState.profiles[idx], ...row };
            return { data: null, error: null };
          },
        }),
      };
    },
  })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1', identities: [] } } }) },
  })),
}));

vi.mock('@/lib/security/rateLimit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/security/rateLimit')>(),
  ...(await import('@/lib/testing/rateLimitTestMock')).allowTestRateLimit,
}));

vi.mock('@/lib/risk/evaluate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/risk/evaluate')>(),
  ...(await import('@/lib/testing/riskTestMock')).allowTestRisk,
}));

beforeEach(() => {
  process.env.SA_ID_ENCRYPTION_KEY  = randomBytes(32).toString('base64');
  process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  dbState.profiles = [{ id: 'user-1', role: 'patient' }];
  resolveIdentityRoute.mockReset();
  createDhaFaceMatchSession.mockReset();
  createDiditSession.mockReset();
});

// Valid Luhn checksum, DOB 2015-06-15 (male, SA citizen) — well under 18
// against any "now" this codebase will run against for years to come.
const UNDER_18_VALID_LUHN_SA_ID = '1506155000008';

describe('17. under_18_id_rejected_before_any_dha_call', () => {
  it('an under-18 (but checksum-valid) ID short-circuits before resolveIdentityRoute is called', async () => {
    const { submitIdentityForVerification } = await import('./actions');
    const result = await submitIdentityForVerification({ saIdNumber: UNDER_18_VALID_LUHN_SA_ID, consent: true });

    expect(result.error).toMatch(/18 or older/);
    expect(resolveIdentityRoute).not.toHaveBeenCalled();
    expect(createDhaFaceMatchSession).not.toHaveBeenCalled();
    expect(createDiditSession).not.toHaveBeenCalled();
  });
});

describe('18. invalid_luhn_rejected_before_any_dha_call', () => {
  it('an invalid SA ID short-circuits before resolveIdentityRoute is called, no session created', async () => {
    const { submitIdentityForVerification } = await import('./actions');
    const result = await submitIdentityForVerification({ saIdNumber: INVALID_SA_IDS[0].id, consent: true });

    expect(result.error).toBe('Please enter a valid SA ID number.');
    expect(resolveIdentityRoute).not.toHaveBeenCalled();
    expect(createDhaFaceMatchSession).not.toHaveBeenCalled();
    expect(createDiditSession).not.toHaveBeenCalled();
  });
});

describe('19. consent_not_given_no_dha_call', () => {
  it('a valid, adult ID with consent:false short-circuits before resolveIdentityRoute is called', async () => {
    const { submitIdentityForVerification } = await import('./actions');
    const result = await submitIdentityForVerification({ saIdNumber: VALID_SA_IDS[0], consent: false });

    expect(result.error).toBe('Please provide consent to continue.');
    expect(resolveIdentityRoute).not.toHaveBeenCalled();
    expect(createDhaFaceMatchSession).not.toHaveBeenCalled();
    expect(createDiditSession).not.toHaveBeenCalled();
  });
});

describe('happy path — DHA route creates a session and stamps pending_sa_id_*', () => {
  it('persists pending_sa_id_number/_lookup_hash, never the canonical sa_id_number', async () => {
    resolveIdentityRoute.mockResolvedValue({
      kind: 'dha', photoBase64: 'cGhvdG8=', dhaFirstName: 'Jane', dhaLastName: 'Doe',
      requestId: 'req-1', outcomeCode: 'MATCH',
    });
    createDhaFaceMatchSession.mockResolvedValue({
      session_id: 'sess-1', url: 'https://verify.didit.me/session/abc',
    });

    const { submitIdentityForVerification } = await import('./actions');
    const result = await submitIdentityForVerification({ saIdNumber: VALID_SA_IDS[0], consent: true });

    expect(result).toEqual({ error: null, outcome: 'redirect', url: 'https://verify.didit.me/session/abc' });
    const profile = dbState.profiles[0];
    expect(profile.sa_id_number).toBeUndefined();
    expect(profile.pending_sa_id_number).toBeTruthy();
    expect(profile.pending_sa_id_lookup_hash).toBeTruthy();
    expect(profile.identity_verification_path).toBe('dha');
    expect(profile.dha_consent_at).toBeTruthy();
  });
});

describe('review route — no session created', () => {
  it('writes in_review and returns outcome:review with no url', async () => {
    resolveIdentityRoute.mockResolvedValue({ kind: 'review', reason: 'dha_not_on_register' });

    const { submitIdentityForVerification } = await import('./actions');
    const result = await submitIdentityForVerification({ saIdNumber: VALID_SA_IDS[0], consent: true });

    expect(result).toEqual({ error: null, outcome: 'review' });
    expect(createDhaFaceMatchSession).not.toHaveBeenCalled();
    expect(createDiditSession).not.toHaveBeenCalled();
    expect(dbState.profiles[0].identity_verification_status).toBe('in_review');
  });
});

describe('reject route — no session created, generic copy', () => {
  it('NO_MATCH writes declined and never calls a session-create function', async () => {
    resolveIdentityRoute.mockResolvedValue({ kind: 'reject', reason: 'dha_no_match' });

    const { submitIdentityForVerification } = await import('./actions');
    const result = await submitIdentityForVerification({ saIdNumber: VALID_SA_IDS[0], consent: true });

    expect(result.error).toBeTruthy();
    expect(createDhaFaceMatchSession).not.toHaveBeenCalled();
    expect(createDiditSession).not.toHaveBeenCalled();
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].identity_verification_reason).toBe('dha_no_match');
  });
});

describe('error route — integration bug, status left untouched', () => {
  it('does not write identity_verification_status at all', async () => {
    resolveIdentityRoute.mockResolvedValue({ kind: 'error', status: 400, detail: 'bad field' });

    const { submitIdentityForVerification } = await import('./actions');
    const result = await submitIdentityForVerification({ saIdNumber: VALID_SA_IDS[0], consent: true });

    expect(result.error).toBeTruthy();
    expect(dbState.profiles[0].identity_verification_status).toBeUndefined();
  });
});

describe('dha_name_mismatch — a registry full-given-name is not a mismatch', () => {
  // Found in production. Datanamix returned Names "Jess Nathan" for
  // someone who signed up as "Jess", and the old exact-string comparison
  // flagged it. Didit's DHA endpoint returned "JESS NATHAN" for the same
  // person, so this was never provider-specific — it just went unnoticed
  // because AML was declining every session before the flag mattered.
  //
  // Registries store the FULL set of given names; a signup form captures
  // whatever the person goes by. Two or three given names is common in
  // South Africa, so exact matching would flag a large share of
  // legitimate applicants — and the registry value is the more correct
  // one, which makes treating the difference as suspicious backwards.

  async function runWith(claimed: { first: string | null; last: string | null },
                         registry: { first?: string; last?: string }) {
    dbState.profiles = [{ id: 'user-1', role: 'patient', first_name: claimed.first, last_name: claimed.last }];
    resolveIdentityRoute.mockResolvedValue({
      kind: 'dha', photoBase64: 'ZmFrZQ==', outcomeCode: 'MATCH',
      dhaFirstName: registry.first, dhaLastName: registry.last,
    });
    createDhaFaceMatchSession.mockResolvedValue({
      session_id: 's1', url: 'https://verify.test/s1', status: 'Not Started',
      workflow_id: 'wf', workflow_version: 1,
    });

    const { submitIdentityForVerification } = await import('./actions');
    await submitIdentityForVerification({ saIdNumber: VALID_SA_IDS[0], consent: true });
    return dbState.profiles[0].dha_name_mismatch as boolean;
  }

  it('the real production case: claimed "Jess" vs registry "Jess Nathan" is NOT a mismatch', async () => {
    expect(await runWith({ first: 'Jess', last: 'Leiboff' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(false);
  });

  it('a middle name used as the everyday name is not a mismatch', async () => {
    // People do go by their second given name.
    expect(await runWith({ first: 'Nathan', last: 'Leiboff' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(false);
  });

  it('the full given names matching exactly is not a mismatch', async () => {
    expect(await runWith({ first: 'Jess Nathan', last: 'Leiboff' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(false);
  });

  it('case and surrounding whitespace are ignored (Didit returns UPPERCASE)', async () => {
    expect(await runWith({ first: '  jess ', last: 'leiboff' }, { first: 'JESS NATHAN', last: 'LEIBOFF' })).toBe(false);
  });

  it('an initial matches the name it abbreviates', async () => {
    expect(await runWith({ first: 'J Nathan', last: 'Leiboff' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(false);
  });

  it('hyphens and apostrophes normalise on surnames', async () => {
    expect(await runWith({ first: 'Jess', last: "O'Brien" },   { first: 'Jess', last: 'O Brien' })).toBe(false);
    expect(await runWith({ first: 'Jess', last: 'Smith-Jones' }, { first: 'Jess', last: 'Smith Jones' })).toBe(false);
  });

  it('a genuinely different given name IS a mismatch', async () => {
    expect(await runWith({ first: 'Sipho', last: 'Leiboff' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(true);
  });

  it('a claimed name the registry does not hold IS a mismatch, even alongside one it does', async () => {
    // "More names than the registry has" is a real discrepancy, not a
    // subset — this is the direction that must NOT be forgiven.
    expect(await runWith({ first: 'Jess Sipho', last: 'Leiboff' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(true);
  });

  it('a different surname IS a mismatch — surnames are compared exactly', async () => {
    expect(await runWith({ first: 'Jess', last: 'Naidoo' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(true);
  });

  it('a missing value on either side is not treated as a mismatch', async () => {
    // Only ever sets a review flag, so silence beats a false positive.
    expect(await runWith({ first: null, last: 'Leiboff' }, { first: 'Jess Nathan', last: 'Leiboff' })).toBe(false);
    expect(await runWith({ first: 'Jess', last: 'Leiboff' }, { first: undefined,   last: 'Leiboff' })).toBe(false);
  });
});
