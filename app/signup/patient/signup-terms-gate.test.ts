import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Adversarial: acceptance is gated SERVER-SIDE ───────────────────────
//
// The "I agree" checkbox is a client-side gate, but a crafted POST can
// omit or falsify it. This test proves signUpPatient rejects termsAccepted
// !== true on the server, BEFORE any account is created (auth.signUp is
// never reached), so the acceptance decision is genuinely server-side.

const signUpSpy = vi.fn();
const profileUpdateSpy = vi.fn(() => ({ eq: () => ({ error: null }) }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ set: vi.fn() }),
}));

vi.mock('@/lib/security/rateLimit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/security/rateLimit')>(),
  ...(await import('@/lib/testing/rateLimitTestMock')).allowTestRateLimit,
}));

vi.mock('@/lib/risk/evaluate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/risk/evaluate')>(),
  ...(await import('@/lib/testing/riskTestMock')).allowTestRisk,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { signUp: signUpSpy },
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { resend: vi.fn() },
    from: () => ({ update: profileUpdateSpy }),
  }),
}));

vi.mock('@/lib/auth/findExistingAuthUser', () => ({
  findExistingAuthUser: async () => null,
}));

import { signUpPatient } from './actions';

const VALID = {
  firstName: 'Gate',
  lastName:  'Test',
  email:     'gate-test@example.com',
  password:  'Tr0ub4dourX9',
};

describe('signUpPatient — server-side acceptance gate', () => {
  beforeEach(() => {
    signUpSpy.mockClear();
    profileUpdateSpy.mockClear();
  });

  it('rejects when termsAccepted is false, and never calls auth.signUp', async () => {
    const res = await signUpPatient({ ...VALID, termsAccepted: false });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/accept the betternow terms/i);
    // The gate short-circuits before any account is created.
    expect(signUpSpy).not.toHaveBeenCalled();
    expect(profileUpdateSpy).not.toHaveBeenCalled();
  });

  it('rejects when termsAccepted is omitted entirely (undefined)', async () => {
    // Simulates a hand-crafted POST that never sent the field.
    const res = await signUpPatient({ ...VALID } as never);
    expect(res.success).toBe(false);
    expect(signUpSpy).not.toHaveBeenCalled();
  });
});
