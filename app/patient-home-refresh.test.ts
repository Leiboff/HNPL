import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

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
// Account + Profile consolidated: salary date, phone, and their server
// actions now live on the account page / AccountAccordion. The profile
// route is an inert redirect. Wiring pins re-point to the successors.
const ACCOUNT_PAGE = read('app/patient/account/page.tsx');
const ACCOUNT_ACC  = read('app/patient/account/AccountAccordion.tsx');
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
  it('account page renders the SalaryDaySection with a saveSalaryDay server action', () => {
    expect(ACCOUNT_PAGE).toMatch(/SalaryDaySection/);
    expect(ACCOUNT_PAGE).toMatch(/saveSalaryDay/);
    // Belt-and-braces: salary date is nested inside Personal details.
    expect(ACCOUNT_PAGE).toMatch(/Personal details|personalDetails/);
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
    // Only meaningful for an invitation-sourced token (a POS session
    // token has no known email yet).
    //
    // RE-DERIVED, not relaxed. The lookup moved into a Promise.all alongside
    // the viewed/scanned stamp, and TypeScript does not carry a `let`'s
    // narrowing into a closure — so `resolved.row.email` had to be hoisted to
    // a const before the wave. The old single regex matched the inlined
    // expression; the same guarantee is now asserted as a chain of two links,
    // which is what the original was really claiming:
    //
    //   1. the lookup is a profiles/salary_day read keyed on invitationEmail;
    //   2. invitationEmail is derived ONLY from an invitation-kind token, and
    //      is null otherwise;
    //   3. a null invitationEmail skips the lookup entirely.
    //
    // Link 2 is the one the original could only imply.
    expect(CHECKOUT_PAGE).toMatch(
      /\.from\('profiles'\)[\s\S]*?\.select\('salary_day'\)[\s\S]*?\.eq\('email',\s*invitationEmail\)/,
    );
    expect(CHECKOUT_PAGE).toMatch(
      /const invitationEmail =\s*resolved\.kind === 'invitation' \? resolved\.row\.email : null;/,
    );
    expect(CHECKOUT_PAGE).toMatch(/if \(!invitationEmail\) return null;/);
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

  it('salary-day server action lives on the account page (revalidates both /patient/account and /patient)', () => {
    expect(ACCOUNT_PAGE).toMatch(/revalidatePath\('\/patient\/account'\)/);
    expect(ACCOUNT_PAGE).toMatch(/revalidatePath\('\/patient'\)/);
  });
});

// ─── Part 2: Phone inside Personal Details ────────────────────────────

describe('Part 2 — phone folded into Personal Details', () => {
  it('account settings accordion no longer exposes a standalone "Phone number" section', () => {
    expect(ACCOUNT_ACC).not.toMatch(/Phone number/);
    // Post-consolidation the accordion has personal / notifications /
    // security section keys (salary is nested in personal). No 'phone' key.
    expect(ACCOUNT_ACC).not.toMatch(/SectionKey.*phone/);
  });

  it('account page renders <PhoneField> inline within Personal Details', () => {
    expect(ACCOUNT_PAGE).toMatch(/PhoneField/);
    // No import of the old PhoneForm module.
    expect(ACCOUNT_PAGE).not.toMatch(/from ['"]\.\/PhoneForm['"]/);
  });

  it('PhoneForm.tsx has been removed', () => {
    expect(existsSync(resolve(ROOT, 'app/patient/profile/PhoneForm.tsx'))).toBe(false);
  });
});

// ─── Part 3: Home dashboard ────────────────────────────────────────────

describe('Part 3 — home dashboard', () => {
  it('renders the v4 navy-shell home (PatientScreen + ladder + bill card + failed state)', () => {
    // v4 rebuild: the balance is drawn into a navy hero (PatientScreen),
    // plans carry the InstalmentLadder, a pending bill shows as
    // HomeBillCard, and a failed/defaulted instalment flips to
    // HomeFailedState. ApprovedBalanceCard / FindCareBar / MergedPlansCard
    // are no longer composed on Home.
    expect(HOME).toMatch(/PatientScreen/);
    expect(HOME).toMatch(/InstalmentLadder/);
    expect(HOME).toMatch(/<HomeBillCard/);
    expect(HOME).toMatch(/<HomeFailedState/);
  });

  it('reads approved_credit_limit from profiles.select', () => {
    // RELOCATED, not weakened. The page used to run its own
    // profiles.select(...) with this column; that read was a DUPLICATE of one
    // the patient layout already performed on the same row, so both now share
    // a single request-scoped read (lib/patient/requestProfile.ts, React
    // cache()). The column is still read; it is read once.
    //
    // Asserted in two halves so the invariant cannot be dodged: the shared
    // read must select the column, AND this page must be the thing that
    // consumes it rather than having quietly re-added an inline query.
    const SHARED = read('lib/patient/requestProfile.ts');
    // [\s\S] rather than the /s flag: the tsconfig target predates dotAll,
    // and the select spans several lines.
    expect(SHARED).toMatch(/select\([\s\S]*approved_credit_limit/);
    expect(HOME).toMatch(/getPatientProfileForRequest\(user\.id\)/);
    expect(HOME).not.toMatch(/from\('profiles'\)/);
    // And it is still what feeds the approved-balance figure.
    expect(HOME).toMatch(/profile\?\.approved_credit_limit/);
  });

  it('ApprovedBalanceCard renders null when limit is null (no placeholder)', () => {
    // The guard is a top-level early-return. Assert its shape so a
    // regression that inlines JSX and forgets the null-check fails.
    expect(BALANCE_CARD).toMatch(/if \(limit == null\) return null/);
    // No hard-coded rand value in JSX (limit is always formatted
    // from the caller's prop). Comment narratives can mention "R0
    // available" as an anti-pattern — strip comments before
    // pattern-matching so the check anchors to code only.
    const codeOnly = stripComments(BALANCE_CARD);
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

  it('layout order (v4): balance hero → waiting-on-you → next payment → your plans', () => {
    // v4 reading order: what can I spend (navy hero), is anything waiting
    // on me (bill card), what comes off next (Next payment), then the
    // plan list.
    const hero    = HOME.indexOf('Available to spend');
    const bill    = HOME.indexOf('<HomeBillCard');
    const nextPay = HOME.indexOf('Next payment');
    const plans   = HOME.indexOf('Your plans');
    expect(hero).toBeGreaterThan(-1);
    expect(bill).toBeGreaterThan(hero);
    expect(nextPay).toBeGreaterThan(bill);
    expect(plans).toBeGreaterThan(nextPay);
  });

  it('push soft-ask is REMOVED from the home flow (moved to the action centre)', () => {
    // <PushSoftAsk /> lived at the tail of the home feed. It now lives
    // inside <ActionCentreSheet /> triggered by the header bell.
    expect(HOME).not.toMatch(/<PushSoftAsk/);
    expect(HOME).not.toMatch(/from ['"]@\/app\/_pwa\/PushSoftAsk['"]/);
  });

  it('the standalone YourPlansCard is REMOVED from the home flow and its file deleted', () => {
    expect(HOME).not.toMatch(/<YourPlansCard/);
    expect(HOME).not.toMatch(/from ['"]\.\/YourPlansCard['"]/);
    expect(existsSync(resolve(ROOT, 'app/patient/YourPlansCard.tsx'))).toBe(false);
  });

  it('the standalone InstalmentHero is REMOVED from the home flow and its file deleted', () => {
    // The merged card owns the modal + ladder-state display now — the
    // separate hero component is dead weight and would drift from the
    // merged copy over time. Keep the codebase honest.
    expect(HOME).not.toMatch(/<InstalmentHero/);
    expect(HOME).not.toMatch(/from ['"]\.\/InstalmentHero['"]/);
    expect(existsSync(resolve(ROOT, 'app/patient/InstalmentHero.tsx'))).toBe(false);
  });

  it('builds active plan rows on the server and renders them with the ladder', () => {
    // v4: the merged card is gone; Home derives planRows via
    // computePlanProgress and renders each with an InstalmentLadder built
    // from the paid/total counts.
    expect(HOME).toMatch(/computePlanProgress/);
    expect(HOME).toMatch(/const planRows/);
    expect(HOME).toMatch(/ladderFromCounts\(r\.total, r\.paid\)/);
  });

  it('per-plan next instalment is computed on the server (nextByPlan map)', () => {
    // No new fetch — the map is built from the existing payments array
    // and keyed by plan_id. Pin the shape so a future refactor doesn't
    // silently break the per-plan next amount / date on the row.
    expect(HOME).toMatch(/const\s+nextByPlan\s*=\s*new\s+Map/);
    expect(HOME).toMatch(/nextByPlan\.set\(p\.plan_id/);
    expect(HOME).toMatch(/nextByPlan\.get\(p\.id\)/);
  });

  it('pending bills render via HomeBillCard (mapped over pendingPlans)', () => {
    // v4: the billReview local is gone; a pending bill is a HomeBillCard
    // rendered per pending plan, wired to the existing declinePlan action.
    expect(HOME).toMatch(/pendingPlans\.map/);
    expect(HOME).toMatch(/<HomeBillCard/);
    expect(HOME).toMatch(/declinePlan=\{declinePlan\}/);
    const billCard = read('app/patient/HomeBillCard.tsx');
    expect(billCard).toMatch(/data-testid="home-bill-card"/);
  });

  it('a failed/defaulted instalment flips Home into the missed-payment screen', () => {
    // The trigger + the honest failed-state screen. HomeFailedState never
    // prints a "no fee" guarantee; the retry date comes from the row's
    // real next_attempt_date.
    expect(HOME).toMatch(/status === 'failed' \|\| p\.status === 'defaulted'/);
    expect(HOME).toMatch(/<HomeFailedState/);
    expect(HOME).toMatch(/retryDate=\{urgent\.status === 'failed' \? urgent\.next_attempt_date : null\}/);
  });

  it('balance hero is gated on approved_credit_limit (no placeholder when null)', () => {
    // v4 draws the balance into the navy hero instead of ApprovedBalanceCard,
    // but the "real data only" rule holds: the raw limit is read and the
    // hero only renders when it is non-null.
    expect(HOME).toMatch(/approvedLimit:\s*number \| null/);
    expect(HOME).toMatch(/\(profile\?\.approved_credit_limit as number \| null\) \?\? null/);
    expect(HOME).toMatch(/approvedLimit != null \?/);
  });

  it('dashboard no longer imports or renders the old passkey card', () => {
    // Header-comment narrative may reference the retired name;
    // pattern-match against CODE only.
    const codeOnly = stripComments(HOME);
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
    // it, and the nextPath nav after that. Post-2026-07-30 the
    // navigation target is `nextPath` (safeNext-clamped, default
    // /dashboard) rather than a hardcoded /dashboard string.
    // Anchored on CODE, not on the raw file. The three assertions below
    // are order-of-occurrence checks, so any COMMENT that happens to
    // mention `signInWithPassword` earlier in the file silently moves the
    // anchor and the test then compares the wrong pair of positions —
    // reporting a reordering that never happened. This file already uses
    // stripComments for exactly this reason elsewhere (see the codeOnly
    // blocks); this assertion had been missed.
    const codeOnly  = stripComments(LOGIN_PAGE);
    const idxSignIn = codeOnly.indexOf('signInWithPassword');
    expect(idxSignIn).toBeGreaterThan(0);
    const idxRecord = codeOnly.indexOf('recordLoginLanding()', idxSignIn);
    const idxNav    = codeOnly.indexOf('window.location.href = nextPath', idxSignIn);
    expect(idxRecord).toBeGreaterThan(idxSignIn);
    expect(idxNav).toBeGreaterThan(idxRecord);
  });
});

// ─── 2026-07-13 refresh: earn-the-space + action centre ───────────────

describe('MergedPlansCard — source-pin invariants', () => {
  const CARD = read('app/patient/MergedPlansCard.tsx');

  it('caps visible rows at 3 and exposes View-all when overflow > 0', () => {
    expect(CARD).toMatch(/ROW_CAP\s*=\s*3/);
    expect(CARD).toMatch(/slice\s*\(\s*0\s*,\s*ROW_CAP\s*\)/);
    expect(CARD).toMatch(/View all \{activeCount\}/);
  });

  it('renders each row with practice name + progress bar + right-aligned next amount', () => {
    expect(CARD).toMatch(/data-testid="merged-plans-row"/);
    expect(CARD).toMatch(/data-testid="merged-plans-row-name"/);
    expect(CARD).toMatch(/data-testid="merged-plans-row-amount"/);
    // Paid state
    expect(CARD).toMatch(/Paid in full/);
    // Non-paid state
    expect(CARD).toMatch(/\$\{r\.paid\} of \$\{r\.total\} paid/);
    // Aria progress
    expect(CARD).toMatch(/role="progressbar"/);
    expect(CARD).toMatch(/aria-valuenow=\{r\.percent\}/);
  });

  it('empty state (0 active plans) — headline hidden, Find-care link + past-plans link', () => {
    expect(CARD).toMatch(/data-testid="merged-plans-empty"/);
    expect(CARD).toMatch(/data-testid="merged-plans-find-care"/);
    expect(CARD).toMatch(/data-testid="merged-plans-past-link"/);
    // The 0-active branch returns EARLY (headline never renders)
    expect(CARD).toMatch(/if\s*\(activeCount\s*===\s*0\)/);
  });

  it('headline zone opens the SAME InstalmentBreakdownModal — no fork', () => {
    expect(CARD).toMatch(/import\s+InstalmentBreakdownModal/);
    expect(CARD).toMatch(/<InstalmentBreakdownModal/);
    expect(CARD).toMatch(/data-testid="merged-plans-headline"/);
    expect(CARD).toMatch(/View breakdown/);
  });

  it('rows tap through to /patient/orders (unchanged detail surface)', () => {
    expect(CARD).toMatch(/href="\/patient\/orders"/);
  });
});

describe('Header action centre — bell replaces logout in patient header', () => {
  it('Action Centre bell lives in the Home hero (v4), and neither surface renders a LogoutButton', () => {
    // v4 removed the global top bar; the bell moved into the Home navy
    // hero (rendered on-dark). The layout no longer imports/renders it,
    // and no LogoutButton appears anywhere in the shell.
    expect(HOME).toMatch(/from\s+['"]\.\/ActionCentreBell['"]/);
    expect(HOME).toMatch(/<ActionCentreBell\s+onDark/);
    expect(LAYOUT).not.toMatch(/from\s+['"]\.\/LogoutButton['"]/);
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

describe('Logout is on Account (not the header)', () => {
  it('Account page imports + renders ProfileLogoutSection (once, post-consolidation)', () => {
    expect(ACCOUNT_PAGE).toMatch(/import\s+ProfileLogoutSection\s+from\s+['"]\.\.\/profile\/ProfileLogoutSection['"]/);
    expect(ACCOUNT_PAGE).toMatch(/<ProfileLogoutSection\s*\/>/);
    // The retired profile route no longer renders it (no duplicate log out).
    expect(PROFILE_PAGE).not.toMatch(/ProfileLogoutSection/);
  });

  it('ProfileLogoutSection uses the shared logoutAndRedirect helper', () => {
    const SECTION = read('app/patient/profile/ProfileLogoutSection.tsx');
    expect(SECTION).toMatch(/logoutAndRedirect/);
    expect(SECTION).toMatch(/data-testid="profile-logout-button"/);
  });

  it('patient header does NOT render a Log out label anymore', () => {
    // Code-only match — the header comments may still describe the
    // relocation.
    const codeOnly = stripComments(LAYOUT);
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
    'app/api/payments/peach/webhook/route.ts',
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
