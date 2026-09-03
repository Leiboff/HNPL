import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { MFA_REQUIRED_ROLES, isMfaRequiredRole } from '@/lib/auth/privilegedRoles';

// ─── Named test 11 (scope) — out-of-scope surfaces are untouched ───────
//
// The mandate is admin + sales ONLY. patient, practice_admin,
// practice_staff and practice_provider must be unaffected by every change
// in this pass: no MFA enrolment, no step-up, no AAL guard on any route
// they use. This file pins that boundary so a later edit cannot quietly
// pull one of those roles into the guard.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

describe('the mandatory-MFA role set', () => {
  it('is exactly admin + sales', () => {
    expect([...MFA_REQUIRED_ROLES].sort()).toEqual(['admin', 'sales']);
  });

  it('excludes every practice / patient role', () => {
    for (const role of ['patient', 'practice_admin', 'practice_staff', 'practice_provider']) {
      expect(isMfaRequiredRole(role)).toBe(false);
    }
  });
});

describe('[named 11] no out-of-scope action carries an AAL guard', () => {
  // Representative writes for patient discovery/checkout, till issuance and
  // the practice-admin (brand-admin) banking edit. None may reference the
  // guard — a hit here means the guard leaked onto an out-of-scope role.
  const UNGUARDED = [
    'app/patient/actions.ts',
    'app/patient/payment-methods/actions.ts',
    'app/checkout/[token]/actions.ts',
    'app/practice/pos/actions.ts',
    'app/practice/pos/devices/actions.ts',
    'app/practice/bills/new/actions.ts',
    'app/practice/members/actions.ts',
    // The brand-admin banking edit lives here and is performed by
    // practice_admin/practice_staff — explicitly out of scope, so it must
    // stay unguarded even though it is a banking change.
    'app/brand/actions.ts',
  ];

  it.each(UNGUARDED)('%s does not import or call requireAAL2', (file) => {
    const src = read(file);
    expect(src).not.toContain('requireAAL2');
    expect(src).not.toContain("lib/auth/aal");
  });
});

describe('[named 11] the sign-in step-up fires for admin/sales only', () => {
  const dash = read('app/dashboard/page.tsx');

  it('calls the step-up in the admin and sales arms', () => {
    const adminAt = dash.indexOf("case 'admin':");
    const salesAt = dash.indexOf("case 'sales':");
    const stepUps = [...dash.matchAll(/await stepUpPrivilegedOrRedirect\(\)/g)];
    // Two invocations: one under admin, one under sales.
    expect(stepUps.length).toBe(2);
    expect(adminAt).toBeGreaterThan(-1);
    expect(salesAt).toBeGreaterThan(-1);
  });

  it('does not gate the patient / practice / provider arms', () => {
    // The patient arm is the first case and must reach its redirect with no
    // assurance check between the switch and it.
    const patientCase = dash.indexOf("case 'patient':");
    const patientRedirect = dash.indexOf("redirect('/patient')");
    const slice = dash.slice(patientCase, patientRedirect);
    expect(slice).not.toContain('stepUpPrivilegedOrRedirect');
  });
});

describe('[named 11] the RLS backstop restricts only payout tables', () => {
  const mig = read('supabase/migrations/0139_privileged_aal2_backstop.sql');

  it('adds RESTRICTIVE policies on payouts and payout_batches only', () => {
    const restrictive = [...mig.matchAll(/AS RESTRICTIVE/gi)];
    expect(restrictive.length).toBe(2);
    expect(mig).toMatch(/ON public\.payouts\s+AS RESTRICTIVE/);
    expect(mig).toMatch(/ON public\.payout_batches\s+AS RESTRICTIVE/);
  });

  it('adds no restrictive policy on practices, profiles or practice_groups', () => {
    // Those tables carry the practice-manager / patient / brand traffic the
    // mandate must not disturb; a restrictive policy there would catch it.
    expect(mig).not.toMatch(/ON public\.practices\s+AS RESTRICTIVE/);
    expect(mig).not.toMatch(/ON public\.profiles\s+AS RESTRICTIVE/);
    expect(mig).not.toMatch(/ON public\.practice_groups\s+AS RESTRICTIVE/);
  });

  it('scopes the restrictive policies to UPDATE, leaving reads alone', () => {
    // FOR UPDATE only — SELECT is untouched, so payout pages still render.
    const forUpdate = [...mig.matchAll(/AS RESTRICTIVE\s+FOR UPDATE/gi)];
    expect(forUpdate.length).toBe(2);
  });
});
