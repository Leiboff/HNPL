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

describe('account consolidation — canonical route + redirect', () => {
  it('the profile route is an inert redirect to /patient/account', () => {
    expect(PROFILE).toContain("redirect('/patient/account')");
    // Inert: no data fetch, no editor UI left behind.
    expect(PROFILE).not.toContain('createClient');
    expect(PROFILE).not.toContain('AccordionSection');
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

  it('salary date is nested inside the Personal details body (not its own section)', () => {
    // Both the locked-field grid and the salary section live in the same
    // `personalDetails` node handed to the accordion.
    const start = ACCOUNT.indexOf('const personalDetails =');
    const end   = ACCOUNT.indexOf('const howYouPay =');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = ACCOUNT.slice(start, end);
    expect(body).toContain('<SalaryDaySection');
    expect(body).toContain('<PhoneField');
    expect(body).toContain('SA ID number');
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

  it('"Payday" is gone from the account page (renamed to Salary date via the nested section)', () => {
    expect(ACCOUNT).not.toContain('Payday');
    expect(ACCOUNT).not.toContain('title="Payday"');
  });
});

describe('account consolidation — former inbound links land on canonical', () => {
  it('verify-phone points at /patient/account', () => {
    expect(VERIFY_PHONE).toContain('/patient/account');
    expect(VERIFY_PHONE).not.toContain('href="/patient/profile"');
  });

  it('the confirm "set salary date" CTA points at /patient/account', () => {
    expect(CONFIRM).toContain('/patient/account?section=personal');
    expect(CONFIRM).not.toContain('href="/patient/profile"');
  });
});
