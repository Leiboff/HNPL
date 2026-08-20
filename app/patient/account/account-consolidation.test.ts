import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Account consolidation — one settings surface, no duplicates ────────
//
// Source-text pins proving Account and Profile stay folded into a single
// canonical surface rooted at /patient/account, updated for the
// accordion→screens conversion (2026-08-20):
//   • /patient/profile is still an inert redirect to /patient/account.
//   • Each former accordion section now lives on exactly ONE dedicated
//     route under /patient/account/*, not duplicated across pages.
//   • Salary date AND salary amount live in Personal details now — not as
//     their own section — per direct product decision reversing the
//     earlier "salary date is its own section" call.
//   • No in-app "rows to another page" remain (no href to /patient/profile).
//   • Former inbound deep links (verify-phone, plan confirm) land on the
//     Personal details route directly, since there is only one destination
//     for "go edit your phone/salary" now — no `?section=` disambiguation
//     needed.

function read(p: string): string {
  return readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
}

const ACCOUNT      = read('app/patient/account/page.tsx');
const PERSONAL     = read('app/patient/account/personal/page.tsx');
const PAY          = read('app/patient/account/pay/page.tsx');
const PROFILE      = read('app/patient/profile/page.tsx');
const VERIFY_PHONE = read('app/(auth)/verify-phone/page.tsx');
const CONFIRM      = read('app/patient/orders/[planId]/confirm/page.tsx');
const SETTINGS     = read('app/patient/account/AccountSettings.tsx');

describe('account consolidation — canonical route + redirect', () => {
  it('the profile route is an inert redirect to /patient/account', () => {
    expect(PROFILE).toContain("redirect('/patient/account')");
    // Inert: no data fetch, no editor UI left behind.
    expect(PROFILE).not.toContain('createClient');
    expect(PROFILE).not.toContain('AccordionSection');
    expect(PROFILE).not.toContain('AccountSettings');
    expect(PROFILE).not.toContain('SalaryDaySection');
  });

  it('the dead ProfileAccordion component is gone', () => {
    expect(existsSync(resolve(process.cwd(), 'app/patient/profile/ProfileAccordion.tsx'))).toBe(false);
  });

  it('the accordion is gone from the settings surface — AccountSettings renders links, not disclosure buttons', () => {
    // Comments stripped: the migration note in this file's own prose
    // discusses "AccordionSection" by name, which would otherwise satisfy
    // a substring check that is supposed to be pinning CODE, not prose.
    const code = stripComments(SETTINGS);
    expect(code).not.toContain('AccordionSection');
    expect(code).not.toContain('aria-expanded');
    expect(code).not.toContain('useState');
  });
});

describe('account consolidation — salary date and salary amount live in Personal details', () => {
  it('Personal details renders both salary fields, not the account index', () => {
    expect(PERSONAL).toMatch(/import\s+SalaryDaySection\s+from/);
    expect(PERSONAL).toMatch(/import\s+SalaryAmountSection\s+from/);
    expect(PERSONAL).toContain('<SalaryDaySection');
    expect(PERSONAL).toContain('<SalaryAmountSection');

    // Not left behind on the index — that page no longer builds section
    // bodies at all, salary included.
    expect(ACCOUNT).not.toContain('<SalaryDaySection');
    expect(ACCOUNT).not.toContain('<SalaryAmountSection');
  });

  it('salary date has exactly ONE home — Personal details, not a sibling section', () => {
    expect(PERSONAL.match(/<SalaryDaySection/g)!).toHaveLength(1);
    // No separate route for it.
    expect(existsSync(resolve(process.cwd(), 'app/patient/account/salary'))).toBe(false);
  });

  it('renders phone + identity fields alongside salary in the same screen', () => {
    expect(PERSONAL).toMatch(/import\s+PhoneField\s+from/);
    expect(PERSONAL).toContain('<PhoneField');
    expect(PERSONAL).toContain('SA ID number');
  });
});

describe('account consolidation — every former section has exactly one screen', () => {
  it('Notifications, Passkeys, and Log out each render on their own route, not the index', () => {
    expect(read('app/patient/account/notifications/page.tsx')).toContain('<NotificationsToggle');
    expect(read('app/patient/account/passkeys/page.tsx')).toContain('<PasskeysSection');
    expect(read('app/patient/account/signout/page.tsx')).toContain('<ProfileLogoutSection');

    expect(ACCOUNT).not.toContain('<NotificationsToggle');
    expect(ACCOUNT).not.toContain('<PasskeysSection');
    expect(ACCOUNT).not.toContain('<ProfileLogoutSection');
  });

  it('Payment cards renders on its own route, and PROFILE (retired) still holds none of it', () => {
    expect(PAY).toContain('<PaymentMethods');
    expect(PROFILE).not.toContain('PaymentMethods');
  });
});

describe('account consolidation — no rows-to-another-page, renamed Payday', () => {
  it('the account index has no in-app link/row back to /patient/profile', () => {
    // A comment may reference the retired route; what must be gone is any
    // actual navigation to it (href/Link).
    expect(ACCOUNT).not.toMatch(/href=\{?['"`]\/patient\/profile/);
  });

  it('"Payday" is gone everywhere on the settings surface (it is "Salary date")', () => {
    for (const src of [ACCOUNT, PERSONAL, SETTINGS]) {
      expect(src).not.toContain('Payday');
      expect(src).not.toContain('title="Payday"');
    }
  });
});

describe('account consolidation — former inbound links land on Personal details', () => {
  it('verify-phone points straight at Personal details', () => {
    expect(VERIFY_PHONE).toContain('/patient/account/personal');
    expect(VERIFY_PHONE).not.toContain('href="/patient/profile"');
    expect(VERIFY_PHONE).not.toContain('?section=');
  });

  it('the confirm "set salary date" CTA also points straight at Personal details', () => {
    // Both CTAs converge on the same route now: salary date/amount and
    // phone are all on the one Personal details screen, so there is
    // nothing left for a `?section=` query param to disambiguate.
    expect(CONFIRM).toContain('/patient/account/personal');
    expect(CONFIRM).not.toContain('?section=');
    expect(CONFIRM).not.toContain('href="/patient/profile"');
  });

  it('AccountSettings actually routes its Personal details row to that same URL', () => {
    expect(SETTINGS).toMatch(/href=["']\/patient\/account\/personal["']/);
  });
});
