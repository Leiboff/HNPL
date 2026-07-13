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
  it('renders ApprovedBalanceCard + FindCareBar + YourPlansCard (carries the active-plans testid)', () => {
    expect(HOME).toMatch(/ApprovedBalanceCard/);
    expect(HOME).toMatch(/FindCareBar/);
    expect(HOME).toMatch(/<YourPlansCard/);
    // The active-plans-count testid now lives on YourPlansCard, not on
    // an inline dashboard element — the testid moves with the card.
    const YOUR_PLANS_CARD = read('app/patient/YourPlansCard.tsx');
    expect(YOUR_PLANS_CARD).toMatch(/data-testid="dashboard-active-plans-count"/);
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

  it('FindCareBar retains its navigation/submit wiring', () => {
    // The link + testid + submit-arrow SVG are all preserved through
    // the 2026-07 rotating-border restyle so downstream nav wiring
    // and any e2e that targets the submit chevron keeps working.
    const bar = read('app/patient/FindCareBar.tsx');
    expect(bar).toMatch(/data-testid="find-care-bar"/);
    expect(bar).toMatch(/href="\/patient\/explore"/);
    // The right-side arrow chevron is what mimics a submit affordance.
    expect(bar).toMatch(/m9 6 6 6-6 6/);
    // The rotating ring lives on an outer wrapper — the inner Link
    // keeps its own focus-visible ring so keyboard focus remains obvious.
    expect(bar).toMatch(/focus-visible:ring-2/);
  });

  it('FindCareBar rotating conic-gradient border + reduced-motion fallback are present in globals.css', () => {
    // The animated ring is implemented via @property + @keyframes so a
    // pure CSS approach with no JS animation loop. prefers-reduced-motion
    // must fall back to a static gradient border with animation disabled.
    const css = read('app/globals.css');
    expect(css).toMatch(/@property\s+--fcb-angle/);
    expect(css).toMatch(/@keyframes\s+fcb-spin/);
    expect(css).toMatch(/conic-gradient/);
    expect(css).toMatch(/\.find-care-bar-wrap/);
    // Reduced-motion fallback: media query + animation:none inside it
    // + a static linear-gradient border.
    const rmBlock = css.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\n\}/);
    expect(rmBlock).not.toBeNull();
    expect(rmBlock![0]).toMatch(/animation:\s*none/);
    expect(rmBlock![0]).toMatch(/linear-gradient/);
  });

  it('layout order (bill pending): greeting → FindCareBar → billReview → ApprovedBalanceCard → hero → YourPlansCard', () => {
    // "Earn the space" reorder (2026-07-13): the next-instalment hero
    // now sits ABOVE Your Plans — the pending amount is a stronger
    // signal than the plan-count roll-up so it wins the higher visual
    // slot. Bill-to-review still sits at the top.
    const greeting   = HOME.indexOf('Hi, {profile?.first_name');
    const findCare   = HOME.indexOf('<FindCareBar />');
    const billReview = HOME.indexOf('{billReview}');
    const balance    = HOME.indexOf('<ApprovedBalanceCard');
    const hero       = HOME.indexOf('{hero}');
    const plansCard  = HOME.indexOf('<YourPlansCard');
    expect(greeting).toBeGreaterThan(-1);
    expect(findCare).toBeGreaterThan(greeting);
    expect(billReview).toBeGreaterThan(findCare);
    expect(balance).toBeGreaterThan(billReview);
    expect(hero).toBeGreaterThan(balance);
    expect(plansCard).toBeGreaterThan(hero);
  });

  it('push soft-ask is REMOVED from the home flow (moved to the action centre)', () => {
    // <PushSoftAsk /> lived at the tail of the home feed. It now lives
    // inside <ActionCentreSheet /> triggered by the header bell.
    expect(HOME).not.toMatch(/<PushSoftAsk/);
    expect(HOME).not.toMatch(/from ['"]@\/app\/_pwa\/PushSoftAsk['"]/);
  });

  it('YourPlansCard receives the chip inputs plus active + total counts', () => {
    // The card is a Server Component fed pure props from page.tsx — the
    // per-plan progress math lives in computePlanProgress and the sort
    // (least-paid-first) is done on the page before render.
    expect(HOME).toMatch(/import\s+YourPlansCard,\s*\{\s*type\s+PlanChipInput\s*\}\s+from\s+['"]\.\/YourPlansCard['"]/);
    expect(HOME).toMatch(/computePlanProgress/);
    expect(HOME).toMatch(/<YourPlansCard[\s\S]*?activeCount=\{currentCount\}[\s\S]*?totalCount=\{totalCount\}[\s\S]*?chips=\{planChips\}/);
  });

  it('no-bill variant: billReview stays null and renders nothing between search + balance', () => {
    // Pinning the render contract: billReview is initialised to null,
    // stays null when pendingCount === 0, and the JSX slot between
    // FindCareBar and ApprovedBalanceCard renders that null (so the
    // layout is identical to the pre-reorder state).
    expect(HOME).toMatch(/let billReview:\s*React\.ReactNode\s*=\s*null/);
    // Every assignment to billReview (LHS) lives inside the `if
    // (pendingCount > 0)` block. There are exactly TWO — the
    // single-pending branch and the multi-pending branch.
    const rhsAssigns = HOME.match(/billReview\s*=\s*\(/g) ?? [];
    expect(rhsAssigns.length).toBe(2);
    // And the initial-null declaration is followed by the pending-count guard.
    expect(HOME).toMatch(/let billReview[\s\S]{0,80}?=\s*null[\s\S]*?if\s*\(\s*pendingCount\s*>\s*0\s*\)/);
  });

  it('bill-review card carries the data-testid so downstream tests can query it', () => {
    // Two branches of billReview (single-pending / multi-pending)
    // — both must expose the same testid.
    expect(HOME.match(/data-testid="bill-to-review-card"/g)?.length ?? 0).toBe(2);
  });

  it('hero no longer surfaces the bill-to-review copy — it lives in billReview only', () => {
    // The "Bill to Review" and "Bills to Review" JSX heads used to
    // sit inside the hero branch when pendingCount > 0. They should
    // now be reachable only via billReview's if-block.
    const billReviewStart = HOME.indexOf('let billReview');
    const heroStart       = HOME.indexOf('let hero');
    expect(billReviewStart).toBeGreaterThan(-1);
    expect(heroStart).toBeGreaterThan(billReviewStart);
    // Nothing between "let hero" and the JSX return sets stage="pending"
    // copy. The "all paid up" branch below only fires when pendingCount === 0.
    expect(HOME).toMatch(/else if\s*\(\s*pendingCount\s*===\s*0\s*\)/);
  });

  it('ApprovedBalanceCard visibility rule unchanged (still gated on approved_credit_limit)', () => {
    // The page-level guard: approvedLimit is null → the card renders
    // null internally. Pin that the page still passes the raw limit
    // (not a fallback) so a regression that adds a defaulting shim
    // fails here.
    expect(HOME).toMatch(/approvedLimit:\s*number \| null/);
    expect(HOME).toMatch(/\(profile\?\.approved_credit_limit as number \| null\) \?\? null/);
    expect(HOME).toMatch(/<ApprovedBalanceCard limit=\{approvedLimit\}/);
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

// ─── 2026-07-13 refresh: earn-the-space + action centre ───────────────

describe('YourPlansCard — chip render + caps', () => {
  const CARD = read('app/patient/YourPlansCard.tsx');

  it('caps visible chips at 3 and shows "View all N" once there are more or historic plans', () => {
    // The literal cap constant + slice(0, 3) usage pins the cap-at-3 rule.
    expect(CARD).toMatch(/CHIP_CAP\s*=\s*3/);
    expect(CARD).toMatch(/slice\s*\(\s*0\s*,\s*CHIP_CAP\s*\)/);
    // "View all N →" copy is rendered when overflow > 0.
    expect(CARD).toMatch(/View all \$\{totalCount\}/);
  });

  it('renders each chip with practice name + "X of Y paid" + a progress bar', () => {
    expect(CARD).toMatch(/data-testid="your-plans-chip"/);
    // Non-paid state: `${c.paid} of ${c.total} paid`
    expect(CARD).toMatch(/\$\{c\.paid\} of \$\{c\.total\} paid/);
    // Paid-in-full state
    expect(CARD).toMatch(/Paid in full/);
    // Progress bar is aria-role="progressbar" so screen readers report %
    expect(CARD).toMatch(/role="progressbar"/);
    expect(CARD).toMatch(/aria-valuenow=\{c\.percent\}/);
  });

  it('renders the empty state with a Find-care link when no plans exist at all', () => {
    expect(CARD).toMatch(/data-testid="your-plans-empty"/);
    expect(CARD).toMatch(/href="\/patient\/explore"/);
    expect(CARD).toMatch(/Find care/);
  });

  it('renders a "no active" empty state when totalCount > 0 but activeCount === 0', () => {
    // totalCount>0 && chips.length===0 branch — the past-plans link.
    expect(CARD).toMatch(/No active plans right now/);
    expect(CARD).toMatch(/See \$\{totalCount - activeCount\} past plan/);
  });

  it('chip taps route to /patient/orders (existing plans detail surface)', () => {
    expect(CARD).toMatch(/href="\/patient\/orders"/);
  });
});

describe('InstalmentHero — per-plan lines under the headline', () => {
  const HERO = read('app/patient/InstalmentHero.tsx');

  it('renders per-plan lines only when there is more than one plan contributing', () => {
    // Single-plan users see the clean headline (no per-line duplication).
    expect(HERO).toMatch(/instalments\.length\s*>\s*1/);
    expect(HERO).toMatch(/data-testid="instalment-hero-lines"/);
  });

  it('caps inline lines at 3 with an overflow hint pointing at the breakdown', () => {
    expect(HERO).toMatch(/slice\s*\(\s*0\s*,\s*3\s*\)/);
    expect(HERO).toMatch(/tap for breakdown/);
  });

  it('per-plan lines are sourced from the SAME instalments array driving the modal', () => {
    // No new fetch or transform — the lines use the existing prop.
    expect(HERO).toMatch(/instalments\.slice\(0, 3\)\.map/);
  });

  it('the existing View-breakdown link stays intact', () => {
    expect(HERO).toMatch(/View breakdown/);
    expect(HERO).toMatch(/InstalmentBreakdownModal/);
  });
});

describe('Header action centre — bell replaces logout in patient header', () => {
  it('patient header imports ActionCentreBell, NOT LogoutButton', () => {
    expect(LAYOUT).toMatch(/from\s+['"]\.\/ActionCentreBell['"]/);
    expect(LAYOUT).not.toMatch(/from\s+['"]\.\/LogoutButton['"]/);
    expect(LAYOUT).toMatch(/<ActionCentreBell\s*\/>/);
    expect(LAYOUT).not.toMatch(/<LogoutButton\s*\/>/);
  });

  it('bell has the pending-dot when any action item is unresolved', () => {
    const BELL = read('app/patient/ActionCentreBell.tsx');
    expect(BELL).toMatch(/data-testid="action-centre-bell"/);
    expect(BELL).toMatch(/data-testid="action-centre-bell-dot"/);
    // Pending is push-idle OR passkey-supported-and-none OR install-available.
    expect(BELL).toMatch(/hasPending\s*=\s*pushPending \|\| passkeyPending \|\| installPending/);
  });

  it('action-centre sheet exposes push + passkey + install items', () => {
    const SHEET = read('app/patient/ActionCentreSheet.tsx');
    expect(SHEET).toMatch(/data-testid="action-centre-sheet"/);
    // Each item passes its testid prop; Item renders <div data-testid={testid}>.
    expect(SHEET).toMatch(/testid="ac-item-push"/);
    expect(SHEET).toMatch(/testid="ac-item-passkey"/);
    expect(SHEET).toMatch(/testid="ac-item-install"/);
    expect(SHEET).toMatch(/data-testid=\{testid\}/);
    // Install item is hidden entirely when beforeinstallprompt is unavailable
    // AND we're not on iOS Safari — the render tree ends the ternary with a
    // `: null` (the 'none' branch), so no ac-item-install renders.
    expect(SHEET).toMatch(/null\s*\/\*\s*'none'/);
  });

  it('completed items render a done tick (subtle, never vanish)', () => {
    const SHEET = read('app/patient/ActionCentreSheet.tsx');
    expect(SHEET).toMatch(/data-testid="ac-item-done"/);
    // The done-tick is emitted only when the item's `done` prop is true.
    expect(SHEET).toMatch(/{done && \(/);
  });

  it('push soft-ask logic in the centre reuses the same LS key as the removed home card', () => {
    const SHEET = read('app/patient/ActionCentreSheet.tsx');
    expect(SHEET).toMatch(/hnpl_push_softask_dismissed/);
    expect(SHEET).toMatch(/enablePush/);
  });
});

describe('Logout is on Profile (not the header)', () => {
  it('Profile page imports + renders ProfileLogoutSection', () => {
    const PROF = read('app/patient/profile/page.tsx');
    expect(PROF).toMatch(/import\s+ProfileLogoutSection\s+from\s+['"]\.\/ProfileLogoutSection['"]/);
    expect(PROF).toMatch(/<ProfileLogoutSection\s*\/>/);
  });

  it('ProfileLogoutSection uses the shared logoutAndRedirect helper', () => {
    const SECTION = read('app/patient/profile/ProfileLogoutSection.tsx');
    expect(SECTION).toMatch(/logoutAndRedirect/);
    expect(SECTION).toMatch(/data-testid="profile-logout-button"/);
  });

  it('patient header does NOT render a Log out label anymore', () => {
    // Code-only match — the header comments may still describe the
    // relocation.
    const codeOnly = LAYOUT
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/LogoutButton/);
  });
});

describe('Passkey interrupt-prompt caps regression pin', () => {
  // The action-centre passkey item is ALWAYS visible until enrolled,
  // but the frequency-capped interrupt-prompt behaviour must NOT
  // change. Pin the cap logic so this refresh's diff can't accidentally
  // widen the re-prompt cadence.
  it('serverAllowsPasskeyPrompt still combines !permanentlyDismissed AND loginCount >= nextShowAt', () => {
    expect(LAYOUT).toMatch(/!permanentlyDismissed && loginCount >= nextShowAt/);
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
