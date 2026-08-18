import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Account consolidation — one page, one pattern, no duplicates ───────
//
// Source-text pins proving Account and Profile folded into a single
// canonical surface (/patient/account):
//   • /patient/profile is an inert redirect to /patient/account (no 404).
//   • Salary date, phone, notifications, security all render on the account
//     page via the existing P1/leaf components (moved, not reimplemented).
//   • Each duplicated control (Log out, Notifications, Security) exists on
//     the account page and NOT on the retired profile route.
//   • No in-app "rows to another page" remain (no href to /patient/profile
//     from the account page); "Payday" was renamed to "Salary date".
//   • Former inbound links land on the canonical page.

function read(p: string): string {
  return readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
}

const ACCOUNT      = read('app/patient/account/page.tsx');
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
});

describe('account consolidation — everything on the one page', () => {
  it('renders phone + salary date via the P1 inline-edit components', () => {
    expect(ACCOUNT).toMatch(/import\s+PhoneField\s+from\s+['"]\.\.\/profile\/PhoneField['"]/);
    expect(ACCOUNT).toMatch(/import\s+SalaryDaySection\s+from\s+['"]\.\.\/profile\/SalaryDaySection['"]/);
    expect(ACCOUNT).toContain('<PhoneField');
    expect(ACCOUNT).toContain('<SalaryDaySection');
  });

  it('salary date has exactly ONE home on the page — now its own section', () => {
    // RE-DERIVED, not relaxed. This pin was written when salary date was a
    // field nested inside Personal details, and it asserted that nesting
    // literally. The hierarchy rework promoted salary date to its own
    // section, so the literal cannot hold.
    //
    // What the pin was really protecting is the consolidation guarantee:
    // salary date exists in exactly ONE place on this page, not two. That is
    // unchanged and is what is asserted now — plus the thing the original
    // could not say, namely that it is NOT also still inside Personal
    // details. A half-finished move that left it in both places would fail
    // here, where the old pin would have passed.
    expect(ACCOUNT.match(/<SalaryDaySection/g)!).toHaveLength(1);

    const personalStart = ACCOUNT.indexOf('const personalDetails =');
    const personalEnd   = ACCOUNT.indexOf('const salaryDate =');
    expect(personalStart).toBeGreaterThan(-1);
    expect(personalEnd).toBeGreaterThan(personalStart);
    const personalBody = ACCOUNT.slice(personalStart, personalEnd);

    // Identity fields and the one editable field stay in Personal details…
    expect(personalBody).toContain('<PhoneField');
    expect(personalBody).toContain('SA ID number');
    // …and salary date is no longer among them.
    expect(personalBody).not.toContain('<SalaryDaySection');

    // It is wired as its own section, by name.
    expect(ACCOUNT).toMatch(/salaryDate=\{salaryDate\}/);
  });

  it('Notifications, Security, and Log out each render on the account page', () => {
    expect(ACCOUNT).toContain('<NotificationsToggle');
    expect(ACCOUNT).toContain('<PasskeysSection');
    expect(ACCOUNT).toContain('<ProfileLogoutSection');
  });

  it('Log out renders exactly once and NOT on the retired profile route', () => {
    expect(ACCOUNT.match(/<ProfileLogoutSection/g)!).toHaveLength(1);
    expect(PROFILE).not.toContain('ProfileLogoutSection');
  });
});

describe('account consolidation — no rows-to-another-page, renamed Payday', () => {
  it('the account page has no in-app link/row back to /patient/profile', () => {
    // A comment may reference the retired route; what must be gone is any
    // actual navigation to it (href/Link) and the old settings rows.
    expect(ACCOUNT).not.toMatch(/href=\{?['"`]\/patient\/profile/);
    expect(ACCOUNT).not.toContain('<SettingRow');
  });

  it('"Payday" is gone from the account page (it is "Salary date" everywhere)', () => {
    expect(ACCOUNT).not.toContain('Payday');
    expect(ACCOUNT).not.toContain('title="Payday"');
  });
});

describe('account consolidation — former inbound links land on canonical', () => {
  it('verify-phone points at /patient/account', () => {
    expect(VERIFY_PHONE).toContain('/patient/account');
    expect(VERIFY_PHONE).not.toContain('href="/patient/profile"');
  });

  it('the confirm "set salary date" CTA points at the section that HOLDS salary date', () => {
    // RE-DERIVED for the same move. The CTA is reached when a plan cannot be
    // confirmed because no salary date is set, so it has to land on salary
    // date. It used to deep-link `?section=personal` because that was where
    // the field was nested; now that salary date is its own section, the same
    // intent is `?section=salary`.
    //
    // Asserted as a PAIR so the link and the structure cannot drift apart:
    // the CTA names a section key, and AccountSettings must actually route
    // that key to the salary section.
    expect(CONFIRM).toContain('/patient/account?section=salary');
    expect(CONFIRM).not.toContain('?section=personal');
    expect(CONFIRM).not.toContain('href="/patient/profile"');
    expect(SETTINGS).toMatch(/section\('salary',\s*'Salary date'/);
  });

  it('the verify-phone CTA still points at Personal details, where phone lives', () => {
    // The mirror case, and the reason the two links must be checked
    // separately: phone did NOT move, so this one must NOT have been swept
    // along with the salary change.
    expect(VERIFY_PHONE).toContain('/patient/account?section=personal');
    expect(SETTINGS).toMatch(/section\('personal',\s*'Personal details'/);
  });
});
