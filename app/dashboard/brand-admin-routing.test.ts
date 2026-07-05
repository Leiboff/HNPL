import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Dispatcher — brand-admin routing + no bypass sites ────────────────
//
// The /dashboard page is the ONE role → destination decision point.
// After 2026-07-05 it also checks practice_group_members to route
// brand-admins to /brand (which self-redirects solo owners back to
// /practice via its n=1 rule).
//
// Post-auth landings that must funnel through /dashboard:
//   • /login (window.location.href = '/dashboard')
//   • /update-password (same)
//   • /auth/confirmed (now routes authenticated users to /dashboard)
//   • /auth/callback (redirects to ?next=; the reset flow's default
//     next is /update-password → /dashboard)

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const DISPATCHER  = read('app/dashboard/page.tsx');
const CONFIRMED   = read('app/auth/confirmed/page.tsx');
const LOGIN       = read('app/(auth)/login/page.tsx');
const UPDATE_PW   = read('app/update-password/UpdatePasswordForm.tsx');
const BRAND_PAGE  = read('app/brand/page.tsx');

describe('Dispatcher — brand-admin membership check', () => {
  it('queries practice_group_members for the caller before routing to /practice', () => {
    // The check must come inside the practice_admin/practice_staff
    // branch — patients / providers / platform-admin are unchanged.
    const casesIdx = DISPATCHER.indexOf("case 'practice_admin':");
    expect(casesIdx).toBeGreaterThan(0);
    const branch = DISPATCHER.slice(casesIdx);
    expect(branch).toMatch(/\.from\('practice_group_members'\)/);
    expect(branch).toMatch(/\.eq\('user_id', user\.id\)/);
    expect(branch).toMatch(/\.eq\('active', true\)/);
  });

  it('routes to /brand when a practice-side user has any active brand_admin membership', () => {
    const casesIdx = DISPATCHER.indexOf("case 'practice_admin':");
    const branch = DISPATCHER.slice(casesIdx);
    expect(branch).toMatch(/redirect\('\/brand'\)/);
  });

  it('routes to /practice when there is NO brand_admin membership', () => {
    const casesIdx = DISPATCHER.indexOf("case 'practice_admin':");
    const branch = DISPATCHER.slice(casesIdx);
    // The /practice redirect must come AFTER the brand check — so a
    // regression that reorders the two would fail this pin.
    const brandCheckIdx  = branch.indexOf("from('practice_group_members')");
    const brandRedirect  = branch.indexOf("redirect('/brand')");
    const practiceRedir  = branch.indexOf("redirect('/practice')");
    expect(brandCheckIdx).toBeGreaterThan(0);
    expect(brandRedirect).toBeGreaterThan(brandCheckIdx);
    expect(practiceRedir).toBeGreaterThan(brandRedirect);
  });

  it('does NOT special-case n=1 in the dispatcher (leaves that to /brand)', () => {
    // A regression that starts counting branches here (to skip /brand
    // for solo owners) would defeat the DRY intent. The n=1 rule stays
    // in /brand/page.tsx.
    expect(DISPATCHER).not.toMatch(/\.from\('practices'\)/);
    expect(DISPATCHER).not.toMatch(/branches?\.length/);
  });

  it('patient / provider / admin routing is unchanged', () => {
    expect(DISPATCHER).toMatch(/case 'patient':\s*redirect\('\/patient'\)/);
    expect(DISPATCHER).toMatch(/case 'practice_provider':\s*redirect\('\/provider'\)/);
    expect(DISPATCHER).toMatch(/case 'admin':\s*redirect\('\/admin'\)/);
  });
});

describe('n=1 chain — brand still owns the solo-owner redirect', () => {
  it('/brand redirects a single-branch group to /practice?practiceId=…', () => {
    expect(BRAND_PAGE).toMatch(/branchRows\.length === 1[\s\S]*?redirect\(`\/practice\?practiceId=/);
  });

  it('the dispatcher does NOT duplicate that logic', () => {
    // Cross-check: no /practice?practiceId= wiring in the dispatcher.
    expect(DISPATCHER).not.toMatch(/\?practiceId=/);
  });
});

describe('No other post-auth site bypasses the dispatcher', () => {
  it('/auth/confirmed routes authenticated users to /dashboard (no local role map)', () => {
    // The old page carried its own ROLE_DESTINATIONS. Pinning that map
    // is GONE — the dispatcher owns role → destination.
    expect(CONFIRMED).not.toMatch(/ROLE_DESTINATIONS/);
    expect(CONFIRMED).toMatch(/destination = user \? ['"]\/dashboard['"]/);
    // Unauthenticated fallback stays as /login (the resend-email
    // recovery flow lives there).
    expect(CONFIRMED).toMatch(/['"]\/login['"]/);
  });

  it('/login funnels post-signin through /dashboard', () => {
    expect(LOGIN).toMatch(/window\.location\.href\s*=\s*['"]\/dashboard['"]/);
  });

  it('/update-password funnels post-reset through /dashboard', () => {
    expect(UPDATE_PW).toMatch(/window\.location\.href\s*=\s*['"]\/dashboard['"]/);
  });

  it('/auth/confirmed does NOT hard-code role-specific destinations any more', () => {
    // A regression that reintroduces /patient / /practice / /provider
    // hard-links (bypassing the dispatcher's brand check) fails here.
    expect(CONFIRMED).not.toMatch(/['"]\/patient['"]/);
    expect(CONFIRMED).not.toMatch(/['"]\/practice['"]/);
    expect(CONFIRMED).not.toMatch(/['"]\/provider['"]/);
  });
});

// ─── Diff scope — no payment / guard / revenue changes ─────────────────

describe('Diff scope — routing fix only', () => {
  it('dispatcher does not import payment or webhook or finance modules', () => {
    const FORBIDDEN = [
      '@/lib/payments/',
      '@/lib/paystack/',
      '@/lib/bills/lifecycle',
      'app/api/webhooks/paystack',
      '@/lib/brand/revenue',
      '@/lib/brand/monthlyRevenue',
      '@/lib/finance',
    ];
    for (const mod of FORBIDDEN) {
      expect(DISPATCHER).not.toContain(`from '${mod}`);
      expect(DISPATCHER).not.toContain(`from "${mod}`);
    }
  });

  it('dispatcher does not import any guard helper — routing is not a guard', () => {
    expect(DISPATCHER).not.toMatch(/guardBrand/);
    expect(DISPATCHER).not.toMatch(/guardManager/);
    expect(DISPATCHER).not.toMatch(/guardPracticeAdmin/);
  });
});
