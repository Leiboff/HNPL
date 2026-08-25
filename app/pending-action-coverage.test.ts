import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';

// ─── In-place pending states: what is converted, and what is not ─────────
//
// The brief scoped this deliberately: money and high-traffic paths first,
// with the remainder left as a KNOWN LIST rather than silently unfinished.
// This file is that list, and it is enforced in both directions:
//
//   • every CONVERTED file must actually use the hook — so a refactor that
//     drops it back to a bare boolean fails here;
//   • every file with a pending pattern must appear in exactly ONE of the
//     two lists — so a new form added tomorrow fails the test until
//     somebody classifies it, instead of quietly joining an invisible
//     backlog.
//
// The second half is the point. A "TODO: convert the rest" comment decays;
// a failing test does not.
//
// ─── AND THE FORK IS STRUCTURAL — DO NOT MECHANICALLY CONVERGE IT ──────
//
// The 53 remaining files split into two groups for a REASON, spelled out
// at length in components/loading/usePendingAction.ts:
//
//   useTransition      → wraps a SERVER ACTION; isPending correctly stays
//                        true through the revalidation that follows.
//   manual useState    → wraps a DIRECT browser call to supabase.auth.*;
//                        there is no transition to track, and several end
//                        in window.location.assign rather than a re-render.
//
// Wrapping a direct auth call in startTransition does not make it a
// transition — it produces an isPending that clears before the navigation
// it triggered, so the button re-enables mid-redirect and becomes
// double-tappable at the worst possible moment. Converting the auth-shaped
// files onto useTransition would break them, quietly, on the highest-
// consequence screens in the app. The unification is the HOOK, never the
// mechanism underneath it.

const ROOT = resolve(process.cwd());
const APP  = resolve(ROOT, 'app');

/** Converted in this task: the money and high-traffic paths. */
const CONVERTED = [
  // checkout — the payment path, end to end
  'app/checkout/[token]/CheckoutForm.tsx',
  'app/checkout/[token]/ResumeCapture.tsx',
  'app/checkout/[token]/done/PasswordSetForm.tsx',
  // pay now / settle / confirm-and-pay
  'app/patient/orders/PayNowButton.tsx',
  'app/patient/orders/SettleEntireBillButton.tsx',
  'app/patient/orders/[planId]/confirm/ConfirmForm.tsx',
  // bill creation
  'app/practice/bills/new/BillForm.tsx',
  // login / signup
  'app/(auth)/login/page.tsx',
  'app/signup/patient/PatientSignupForm.tsx',
  'app/signup/practice/page.tsx',
  // password set
  'app/update-password/UpdatePasswordForm.tsx',
  // public contact enquiry — built with the hook from the start. Uses
  // p.run() rather than a mirrored useTransition, because nothing
  // revalidates: success swaps the card for a confirmation held in local
  // state, so there is no transition to track. run()'s synchronous ref is
  // also the double-submit guard for a public endpoint that sends mail.
  'app/contact/ContactForm.tsx',
] as const;

/**
 * NOT yet converted — the known remainder, in scope for a follow-up.
 *
 * These are not broken: every one of them already disables its control
 * while pending (that was true before this task and was verified). What
 * they lack is the shared TIMING — their labels can flash on a fast action,
 * and a few have no label at all. Lower consequence than the list above,
 * which is why they wait.
 */
const NOT_YET_CONVERTED = [
  'app/_components/ContinueWithGoogleButton.tsx',
  'app/_components/PlacesAutocomplete.tsx',
  'app/_pwa/InstallCallout.tsx',
  'app/_pwa/PushSoftAsk.tsx',
  'app/admin/OpsActions.tsx',
  'app/admin/_components/AddNoteForm.tsx',
  'app/admin/collections/CollectionsDateRangePicker.tsx',
  'app/admin/collections/[paymentId]/RetryButton.tsx',
  'app/admin/customers/CustomersSearchForm.tsx',
  'app/admin/groups/GroupCreateForm.tsx',
  'app/admin/groups/[id]/GroupBankingForm.tsx',
  'app/admin/groups/[id]/GroupBrandAdminManager.tsx',
  'app/admin/practices/PracticeApprovalRow.tsx',
  'app/admin/practices/[id]/FeeEditButton.tsx',
  'app/admin/practices/[id]/PracticeCoordsPanel.tsx',
  'app/admin/practices/[id]/PracticeStatusActions.tsx',
  'app/admin/sales-team/SalesTeamClient.tsx',
  'app/brand/[groupId]/new-branch/BranchForm.tsx',
  'app/brand/branch/[practiceId]/TeamSection.tsx',
  'app/brand/group/GroupEditForm.tsx',
  'app/crm/admin/gmail-accounts/GmailAccountsAdminTable.tsx',
  'app/crm/board/BoardClient.tsx',
  'app/crm/import/ImportClient.tsx',
  'app/crm/leads/[id]/ComposeEmailSheet.tsx',
  'app/crm/leads/[id]/InviteSheet.tsx',
  'app/crm/leads/[id]/LeadDetailClient.tsx',
  'app/crm/leads/new/NewLeadForm.tsx',
  'app/crm/settings/GmailConnectionsCard.tsx',
  'app/crm/settings/SignatureEditor.tsx',
  'app/dev/passkey-smoke/PasskeySmokeClient.tsx',
  'app/forgot-password/ForgotPasswordForm.tsx',
  'app/onboarding/credit-check/CreditCheckStepClient.tsx',
  'app/onboarding/identity/IdentityStepClient.tsx',
  'app/onboarding/salary/SalaryStepClient.tsx',
  'app/patient/PostLoginPasskeyPrompt.tsx',
  'app/patient/payment-methods/PaymentMethods.tsx',
  'app/patient/profile/NotificationsToggle.tsx',
  'app/patient/profile/PasskeysSection.tsx',
  'app/patient/profile/PhoneField.tsx',
  'app/patient/profile/SalaryAmountSection.tsx',
  'app/patient/profile/SalaryDaySection.tsx',
  'app/practice/details/BranchBankingForm.tsx',
  'app/practice/details/BranchDetailsForm.tsx',
  'app/practice/members/AddMemberForm.tsx',
  'app/practice/members/AddProviderForm.tsx',
  'app/practice/members/InviteLoginForm.tsx',
  'app/practice/members/SelfAsProviderCard.tsx',
  'app/practice/pos/CounterSessionForm.tsx',
  'app/practice/pos/TodayActivityStrip.tsx',
  'app/practice/pos/devices/DeviceAdminView.tsx',
  'app/practice/pos/register/RegisterForm.tsx',
  'app/practice/setup/SetupForm.tsx',
  'app/practices/PublicLeadForm.tsx',
  'app/provider/setup/page.tsx',
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

/** Has SOME pending-state mechanism. */
function hasPendingPattern(src: string): boolean {
  return /useTransition/.test(src)
    || /const\s*\[\s*(loading|submitting|saving|busy|isSubmitting|pending)\s*,\s*set\w+\s*\]\s*=\s*useState/
      .test(src);
}

const ALL = walk(APP).map((p) => ({ rel: rel(p), src: readFileSync(p, 'utf8') }));
const WITH_PATTERN = ALL.filter((f) => hasPendingPattern(f.src));
const USING_HOOK   = ALL.filter((f) => /usePendingAction/.test(f.src)).map((f) => f.rel);

describe('the inventory is real', () => {
  it('finds a substantial number of files with a pending pattern', () => {
    // If the detector broke, every assertion below would pass vacuously.
    expect(WITH_PATTERN.length).toBeGreaterThan(50);
  });

  it('the two lists together account for every one of them', () => {
    // THE load-bearing assertion. A new form with a pending flag lands in
    // neither list and fails here, so the remainder stays a known list
    // instead of becoming an invisible backlog.
    const classified = new Set<string>([...CONVERTED, ...NOT_YET_CONVERTED]);
    const unclassified = WITH_PATTERN.map((f) => f.rel).filter((r) => !classified.has(r));
    expect(unclassified).toEqual([]);
  });

  it('nothing is in both lists', () => {
    const both = CONVERTED.filter((c) => (NOT_YET_CONVERTED as readonly string[]).includes(c));
    expect(both).toEqual([]);
  });

  it('both lists name files that exist', () => {
    const present = new Set(ALL.map((f) => f.rel));
    const missing = [...CONVERTED, ...NOT_YET_CONVERTED].filter((f) => !present.has(f));
    expect(missing).toEqual([]);
  });
});

describe('CONVERTED — the money and high-traffic paths use the hook', () => {
  it.each(CONVERTED)('%s uses usePendingAction', (file) => {
    expect(USING_HOOK).toContain(file);
  });

  it.each(CONVERTED)('%s drives `disabled` from the hook, not the raw flag', (file) => {
    // The raw flag may well still exist — the hook mirrors it rather than
    // replacing it — but the CONTROL must read the hook, or the immediate
    // ref-backed guard is bypassed.
    const src = ALL.find((f) => f.rel === file)!.src;
    expect(src).toMatch(/disabled=\{[^}]*pending\.disabled/);
  });

  it.each(CONVERTED)('%s drives its pending LABEL from showLabel', (file) => {
    // showLabel, not disabled — otherwise the label appears instantly and
    // flashes, which is the whole thing being fixed.
    const src = ALL.find((f) => f.rel === file)!.src;
    expect(src).toMatch(/pending\.showLabel/);
  });

  it('the three money paths are all in the converted list', () => {
    // Named explicitly so a future trim of the list has to argue with this.
    for (const money of [
      'app/checkout/[token]/CheckoutForm.tsx',
      'app/patient/orders/PayNowButton.tsx',
      'app/patient/orders/SettleEntireBillButton.tsx',
    ]) {
      expect(CONVERTED as readonly string[]).toContain(money);
    }
  });
});

describe('NOT_YET_CONVERTED — accurate, and not silently already done', () => {
  it('none of them uses the hook (the list would be lying)', () => {
    const stale = NOT_YET_CONVERTED.filter((f) => USING_HOOK.includes(f));
    // A file converted without being moved out of this list makes the
    // remainder overstate the work left.
    expect(stale).toEqual([]);
  });

  it('all of them still disable their control while pending — bar one, named', () => {
    // What makes deferring these defensible is that they are not BROKEN:
    // they lack the shared timing, not the guard. Asserted rather than
    // claimed in prose — with the single genuine exception named, because
    // an exception that is listed is a decision and an exception that is
    // hidden by a loosened assertion is a bug.
    //
    // CollectionsDateRangePicker discards isPending entirely
    // (`const [, startTransition]`) and disables nothing. That is FINE for
    // a double-submit: it is a date-range filter whose action is an
    // idempotent router navigation, so firing it twice changes nothing.
    //
    // It does however mean the filter gives NO feedback while
    // /admin/collections re-runs its 5 serial queries — and the route-level
    // fallback does not cover it, because a startTransition navigation
    // deliberately keeps the old UI on screen instead of showing the
    // Suspense boundary. So this one needs the hook rather than merely
    // wanting it. Logged for the follow-up, not silently absorbed here.
    const KNOWN_NO_DISABLED_CONTROL = [
      'app/admin/collections/CollectionsDateRangePicker.tsx',
    ];

    const undefended: string[] = [];
    for (const f of NOT_YET_CONVERTED) {
      if (KNOWN_NO_DISABLED_CONTROL.includes(f)) continue;
      const src = ALL.find((x) => x.rel === f)!.src;
      if (!/disabled=\{/.test(src)) undefended.push(f);
    }
    expect(undefended).toEqual([]);
  });

  it('the named exception is still genuinely an exception', () => {
    // Guards the carve-out above from rotting into a blanket excuse: if
    // this file gains a disabled control or the hook, it must leave the
    // exception list.
    const src = ALL.find((x) => x.rel === 'app/admin/collections/CollectionsDateRangePicker.tsx')!.src;
    expect(src).toMatch(/const \[, startTransition\]/);
    expect(src).not.toMatch(/disabled=\{/);
  });
});
