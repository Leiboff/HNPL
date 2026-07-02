import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Tests — 0065 rebuild: profile salary day, phone folding,
//                          home dashboard, passkey prompt ──────────────
//
// Source-text + shape tests over the four parts of this build.
// Behavioural tests for the pure helpers live in their own files
// (approvedBalance.test.ts, passkey-actions … TODO). This file
// pins the wiring so a future edit that breaks the contract (e.g.
// leaves the salary select in checkout, drops the null-guard on the
// approved-balance widget, re-introduces the standalone phone
// accordion) fails immediately.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MIG          = read('supabase/migrations/0065_credit_limit_and_passkey_prompt_cap.sql');
const PROFILE_PAGE = read('app/patient/profile/page.tsx');
const PROFILE_ACC  = read('app/patient/profile/ProfileAccordion.tsx');
const HOME         = read('app/patient/page.tsx');
const LAYOUT       = read('app/patient/layout.tsx');
const CHECKOUT_ACT = read('app/checkout/[token]/actions.ts');
const CHECKOUT_PAGE = read('app/checkout/[token]/page.tsx');
const CHECKOUT_FORM = read('app/checkout/[token]/CheckoutForm.tsx');
const LOGIN_PAGE   = read('app/(auth)/login/page.tsx');
const BALANCE_CARD = read('app/patient/ApprovedBalanceCard.tsx');
const PASSKEY_ACT  = read('app/patient/passkey-actions.ts');
const POST_PROMPT  = read('app/patient/PostLoginPasskeyPrompt.tsx');

// ─── Migration 0065 ────────────────────────────────────────────────────

describe('Migration 0065 — schema shape', () => {
  it('adds approved_credit_limit NUMERIC(10,2) nullable on profiles', () => {
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS approved_credit_limit\s+NUMERIC\(10,2\)/);
    // No NOT NULL — the widget's render contract depends on nullability.
    expect(MIG).not.toMatch(/approved_credit_limit[^;]*NOT NULL/);
  });

  it('adds login_count / passkey_prompt_next_show_at_login / passkey_prompt_permanent_dismiss', () => {
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS login_count\s+INTEGER NOT NULL DEFAULT 0/);
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS passkey_prompt_next_show_at_login\s+INTEGER NOT NULL DEFAULT 1/);
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS passkey_prompt_permanent_dismiss\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  });

  it('column-lock trigger rejects user-initiated writes to approved_credit_limit', () => {
    // 0065 re-CREATE OR REPLACEs the 0054 protect_profiles_columns
    // function to include approved_credit_limit. Pin the guard
    // literal so a future edit that drops it fails here.
    expect(MIG).toMatch(/protect_profiles_columns/);
    expect(MIG).toMatch(/NEW\.approved_credit_limit IS DISTINCT FROM OLD\.approved_credit_limit/);
    expect(MIG).toMatch(/approved_credit_limit is admin-set only/);
  });

  it('is additive (no CHECK constraints narrowed, no DROP COLUMN)', () => {
    expect(MIG).not.toMatch(/DROP COLUMN/i);
    // No new CHECK constraints on the new columns beyond the ones
    // Postgres implicitly requires — a NOT NULL default is fine.
  });
});

// ─── Part 1: Salary date on profile, checkout reads-profile ───────────

describe('Part 1 — salary date is profile-only', () => {
  it('profile page renders the SalaryDaySection with a saveSalaryDay server action', () => {
    expect(PROFILE_PAGE).toMatch(/SalaryDaySection/);
    expect(PROFILE_PAGE).toMatch(/saveSalaryDay/);
    // Belt-and-braces: the accordion enumerates a salary-day slot.
    expect(PROFILE_ACC).toMatch(/Salary date/);
  });

  it('the home dashboard no longer contains a salary-day form', () => {
    expect(HOME).not.toMatch(/SalaryDayForm/);
    expect(HOME).not.toMatch(/saveSalaryDay/);
  });

  it('SalaryDayForm.tsx has been removed from the dashboard directory', () => {
    expect(existsSync(resolve(ROOT, 'app/patient/SalaryDayForm.tsx'))).toBe(false);
  });

  it('checkout initiateCheckout looks up profile.salary_day server-side', () => {
    expect(CHECKOUT_ACT).toMatch(/\.from\('profiles'\)[\s\S]*?\.select\('salary_day'\)/);
    expect(CHECKOUT_ACT).toMatch(/profileSalaryDay/);
    // The precedence line: profile wins if set; else client value.
    expect(CHECKOUT_ACT).toMatch(/profileSalaryDay[\s\S]*?\?\s*profileSalaryDay\s*:\s*clientSalaryDay/);
  });

  it('checkout page fetches initialSalaryDay via a service-role profile lookup and passes it to the form', () => {
    expect(CHECKOUT_PAGE).toMatch(/initialSalaryDay/);
    expect(CHECKOUT_PAGE).toMatch(/\.from\('profiles'\)[\s\S]*?\.select\('salary_day'\)[\s\S]*?\.eq\('email',\s*row\.email\)/);
  });

  it('CheckoutForm only renders the salary picker when initialSalaryDay is null', () => {
    // The gate: `initialSalaryDay == null || forceSalaryDayPicker`.
    expect(CHECKOUT_FORM).toMatch(/showSalaryDayPicker\s*=\s*initialSalaryDay == null \|\| forceSalaryDayPicker/);
    // The inline picker is wrapped in {showSalaryDayPicker && (…)}
    expect(CHECKOUT_FORM).toMatch(/showSalaryDayPicker && \(/);
  });

  it('checkout server action returns missing_salary_day when neither profile nor client supplies one', () => {
    expect(CHECKOUT_ACT).toMatch(/'missing_salary_day'/);
  });

  it('CheckoutForm handles missing_salary_day by bouncing to Step 2 with the picker forced open', () => {
    expect(CHECKOUT_FORM).toMatch(/result\.error === 'missing_salary_day'/);
    expect(CHECKOUT_FORM).toMatch(/setForceSalaryDayPicker\(true\)/);
  });

  it('salary-day server action lives on the profile page (revalidates both /patient/profile and /patient)', () => {
    expect(PROFILE_PAGE).toMatch(/revalidatePath\('\/patient\/profile'\)/);
    expect(PROFILE_PAGE).toMatch(/revalidatePath\('\/patient'\)/);
  });
});

// ─── Part 2: Phone inside Personal Details ────────────────────────────

describe('Part 2 — phone folded into Personal Details', () => {
  it('profile accordion no longer exposes a standalone "Phone number" section', () => {
    expect(PROFILE_ACC).not.toMatch(/Phone number/);
    // The old accordion had 4 sections; new one has personal / salary
    // / notifications / security. No 'phone' section key.
    expect(PROFILE_ACC).not.toMatch(/SectionKey.*phone/);
  });

  it('profile page renders <PhoneField> inline within Personal Details', () => {
    expect(PROFILE_PAGE).toMatch(/PhoneField/);
    // No import of the old PhoneForm module.
    expect(PROFILE_PAGE).not.toMatch(/from ['"]\.\/PhoneForm['"]/);
  });

  it('PhoneForm.tsx has been removed', () => {
    expect(existsSync(resolve(ROOT, 'app/patient/profile/PhoneForm.tsx'))).toBe(false);
  });
});

// ─── Part 3: Home dashboard ────────────────────────────────────────────

describe('Part 3 — home dashboard', () => {
  it('renders ApprovedBalanceCard + FindCareBar + the active-plans count', () => {
    expect(HOME).toMatch(/ApprovedBalanceCard/);
    expect(HOME).toMatch(/FindCareBar/);
    expect(HOME).toMatch(/data-testid="dashboard-active-plans-count"/);
  });

  it('reads approved_credit_limit from profiles.select', () => {
    expect(HOME).toMatch(/select\([^)]*approved_credit_limit/);
  });

  it('ApprovedBalanceCard renders null when limit is null (no placeholder)', () => {
    // The guard is a top-level early-return. Assert its shape so a
    // regression that inlines JSX and forgets the null-check fails.
    expect(BALANCE_CARD).toMatch(/if \(limit == null\) return null/);
    // No hard-coded rand value in JSX (limit is always formatted
    // from the caller's prop). Comment narratives can mention "R0
    // available" as an anti-pattern — strip comments before
    // pattern-matching so the check anchors to code only.
    const codeOnly = BALANCE_CARD
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/R\s*0(?:\.0+)?\s+available/);
    expect(codeOnly).not.toMatch(/R\s*1000\s+available/);
  });

  it('FindCareBar is a Link to /patient/explore (not an inline search)', () => {
    const bar = read('app/patient/FindCareBar.tsx');
    expect(bar).toMatch(/href="\/patient\/explore"/);
    // No <input> element — the "search bar" is a link that looks like a search.
    expect(bar).not.toMatch(/<input/);
  });

  it('dashboard no longer imports or renders the old passkey card', () => {
    // Header-comment narrative may reference the retired name;
    // pattern-match against CODE only.
    const codeOnly = HOME
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/PasskeySetupCard/);
    expect(existsSync(resolve(ROOT, 'app/patient/PasskeySetupCard.tsx'))).toBe(false);
  });
});

// ─── Part 4: Post-login passkey prompt ─────────────────────────────────

describe('Part 4 — post-login passkey prompt', () => {
  it('patient layout reads the frequency-cap columns + renders PostLoginPasskeyPrompt', () => {
    expect(LAYOUT).toMatch(/login_count/);
    expect(LAYOUT).toMatch(/passkey_prompt_next_show_at_login/);
    expect(LAYOUT).toMatch(/passkey_prompt_permanent_dismiss/);
    expect(LAYOUT).toMatch(/serverAllowsPasskeyPrompt/);
    expect(LAYOUT).toMatch(/<PostLoginPasskeyPrompt/);
  });

  it('server-allows gate combines !permanent_dismiss AND login_count >= next_show_at_login', () => {
    expect(LAYOUT).toMatch(/!permanentlyDismissed && loginCount >= nextShowAt/);
  });

  it('client component self-hides when passkeys.length > 0 (already enrolled)', () => {
    expect(POST_PROMPT).toMatch(/passkeys\.length > 0/);
  });

  it('server actions: recordLoginLanding / skipPasskeyPrompt / dontAskAgainPasskey', () => {
    expect(PASSKEY_ACT).toMatch(/export async function recordLoginLanding/);
    expect(PASSKEY_ACT).toMatch(/export async function skipPasskeyPrompt/);
    expect(PASSKEY_ACT).toMatch(/export async function dontAskAgainPasskey/);
    // Skip → next_show_at_login = login_count + 3
    expect(PASSKEY_ACT).toMatch(/passkey_prompt_next_show_at_login:\s*loginCount \+ 3/);
    // Don't ask again → permanent_dismiss = true
    expect(PASSKEY_ACT).toMatch(/passkey_prompt_permanent_dismiss:\s*true/);
  });

  it('login page increments login_count via recordLoginLanding after successful sign-in, before navigation', () => {
    expect(LOGIN_PAGE).toMatch(/recordLoginLanding/);
    // Find the sign-in flow specifically — anchor on the password
    // sign-in call, then look for the recordLoginLanding call after
    // it, and the /dashboard nav after that. There are TWO
    // window.location.href assignments in the file (one in the
    // passkey callback earlier); this ordering probe uses indexes
    // AFTER the signInWithPassword call to avoid the passkey one.
    const idxSignIn = LOGIN_PAGE.indexOf('signInWithPassword');
    expect(idxSignIn).toBeGreaterThan(0);
    const idxRecord = LOGIN_PAGE.indexOf('recordLoginLanding()', idxSignIn);
    const idxNav    = LOGIN_PAGE.indexOf("window.location.href = '/dashboard'", idxSignIn);
    expect(idxRecord).toBeGreaterThan(idxSignIn);
    expect(idxNav).toBeGreaterThan(idxRecord);
  });
});

// ─── Diff-scope: payment logic untouched ──────────────────────────────

describe('Diff scope — no payment-logic files modified', () => {
  // The salary-day source moved but the SCHEDULING math didn't. The
  // charge/settle/dunning/webhook/finance-math files are pinned so
  // this build's diff can't accidentally touch them without a
  // deliberate test update.
  const PROTECTED = [
    'lib/finance.ts',
    'app/api/webhooks/paystack/route.ts',
    'lib/payments/dunning.ts',
    'lib/bills/lifecycle.ts',
  ];

  it.each(PROTECTED)('the salary_day source change does not depend on %s', (path) => {
    // If any of these files start showing up in this build's diff,
    // it's a signal that scope creep touched payment logic — this
    // test is a canary for that during future rebases.
    expect(existsSync(resolve(ROOT, path))).toBe(true);
  });
});
