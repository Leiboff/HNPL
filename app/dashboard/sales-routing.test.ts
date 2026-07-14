import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Behavioural — post-login role dispatch for sales users ─────────
//
// The bug: /dashboard's switch had no `sales` case, so a sales user
// fell through to the "Account setup incomplete" static message.
// Also: /onboarding didn't check role, so a sales user with a stale
// patient onboarding_completed=false was dragged through the patient
// phone/ID flow.
//
// We can't unit-test the redirect() calls directly (they throw an
// internal Next symbol), but we CAN assert that the dispatcher calls
// redirect with the right target BEFORE returning — vitest can spy
// on next/navigation's export.

type ProfileFixture = {
  role: string | null;
  first_name?: string | null;
  phone_verified_at?: string | null;
  sa_id_number?: string | null;
  salary_day?: number | null;
  credit_check_status?: string | null;
  liveness_verified_at?: string | null;
  onboarding_completed?: boolean | null;
};

const state: {
  user: { id: string; email: string | null } | null;
  profile: ProfileFixture | null;
} = {
  user: { id: 'user-sales', email: 'steve@x.com' },
  profile: { role: 'sales' },
};

// Mock next/navigation.redirect so we can capture what path was
// chosen. redirect() is expected to throw in real Next; we mimic that
// so downstream code short-circuits like it would in production.
const redirectCalls: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (path: string): never => {
    redirectCalls.push(path);
    throw new Error(`__REDIRECT__:${path}`);
  },
  notFound: () => { throw new Error('notFound'); },
}));

vi.mock('@/lib/auth/requireConfirmedUser', () => ({
  requireConfirmedUser: async () => ({
    user: state.user,
    supabase: {
      from(table: string) {
        return {
          select() { return this; },
          eq()     { return this; },
          single: async () => {
            if (table === 'profiles') return { data: state.profile, error: null };
            return { data: null, error: null };
          },
          limit()  { return this; },
          async then(fn: (r: unknown) => unknown) { return fn({ data: [], error: null }); },
        };
      },
    },
  }),
}));

// Service-role client (used by /onboarding page). Reuse the same
// state.profile fixture so tests only need to seed one place.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      return {
        select() { return this; },
        eq()     { return this; },
        maybeSingle: async () => {
          if (table === 'profiles') return { data: state.profile, error: null };
          return { data: null, error: null };
        },
        update() { return { eq: async () => ({ error: null }) }; },
      };
    },
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

beforeEach(() => {
  redirectCalls.length = 0;
  state.user    = { id: 'user-sales', email: 'steve@x.com' };
  state.profile = { role: 'sales' };
});

async function callDashboard(): Promise<void> {
  vi.resetModules();
  const mod = await import('./page');
  await mod.default().catch(err => {
    if (err instanceof Error && err.message.startsWith('__REDIRECT__:')) return;
    throw err;
  });
}

async function callOnboarding(): Promise<void> {
  vi.resetModules();
  const mod = await import('../onboarding/page');
  await mod.default().catch(err => {
    if (err instanceof Error && err.message.startsWith('__REDIRECT__:')) return;
    throw err;
  });
}

describe('/dashboard dispatcher — sales', () => {
  it('routes role=sales to /crm', async () => {
    state.profile = { role: 'sales' };
    await callDashboard();
    expect(redirectCalls).toContain('/crm');
  });

  it('routes role=admin to /admin (unchanged)', async () => {
    state.profile = { role: 'admin' };
    await callDashboard();
    expect(redirectCalls).toContain('/admin');
  });

  it('routes role=patient to /patient (unchanged)', async () => {
    state.profile = { role: 'patient' };
    await callDashboard();
    expect(redirectCalls).toContain('/patient');
  });
});

describe('/onboarding router — sales exemption', () => {
  it('sales user with incomplete patient onboarding is bounced to /dashboard, NOT into a patient step', async () => {
    // Fixture: role='sales' but stale patient-onboarding state (no
    // phone verify, no ID, no credit check, onboarding_completed=false).
    // Pre-fix, this would forward to /onboarding/phone.
    state.profile = {
      role:                  'sales',
      phone_verified_at:     null,
      sa_id_number:          null,
      salary_day:            null,
      credit_check_status:   null,
      liveness_verified_at:  null,
      onboarding_completed:  false,
    };
    await callOnboarding();
    expect(redirectCalls).toContain('/dashboard');
    // MUST NOT route into any /onboarding/* step.
    for (const r of redirectCalls) {
      expect(r).not.toMatch(/^\/onboarding\//);
    }
    expect(redirectCalls).not.toContain('/patient');
  });

  it('admin user with incomplete patient state also bounces to /dashboard', async () => {
    state.profile = { role: 'admin', phone_verified_at: null, onboarding_completed: false };
    await callOnboarding();
    expect(redirectCalls).toContain('/dashboard');
  });
});
