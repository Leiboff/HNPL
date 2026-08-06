import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── POPIA minimisation regression — patient physical address is gone ───
//
// Migration 0059 dropped six columns from `profiles`:
//   address_line1, address_line2, suburb, city, province, postal_code
//
// These tests pin that no code path references the dropped columns
// anywhere on the patient or admin surface, and that email/phone
// (which are load-bearing for auth/OTP/notifications) are NOT touched.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const MIG_0059          = read('supabase/migrations/0059_drop_patient_address.sql');
const PROFILE_PAGE      = read('app/patient/profile/page.tsx');
// Account + Profile consolidated onto ONE surface: the profile SELECT and
// updateProfile action moved into the account page; the settings accordion
// is now AccountAccordion. The POPIA "no address fields anywhere" invariant
// is re-pointed to those successors.
const ACCOUNT_PAGE      = read('app/patient/account/page.tsx');
const ACCOUNT_ACCORDION = read('app/patient/account/AccountAccordion.tsx');
// Post-0065 the standalone phone accordion is gone — phone is now
// an inline edit-toggle field inside Personal details, owned by
// PhoneField.tsx. This test still verifies the phone-only capture
// contract; just against the successor component.
const PHONE_FORM        = read('app/patient/profile/PhoneField.tsx');
const ADMIN_CUSTOMER    = read('app/admin/customers/[patientId]/page.tsx');

const DROPPED = [
  'address_line1',
  'address_line2',
  // 'suburb', 'city', 'province' — these names appear on the PRACTICE
  // schema too (practices.suburb, practices.city, practices.practice_province).
  // Asserting on those bare names would false-positive on practice code.
  // The two _line names + postal_code are unique to the patient context.
  'postal_code',
];

describe('Migration 0059 — drops the six patient-address columns idempotently', () => {
  it('declares DROP COLUMN IF EXISTS for every patient-address column', () => {
    for (const col of ['address_line1', 'address_line2', 'suburb', 'city', 'province', 'postal_code']) {
      const re = new RegExp(`ALTER TABLE profiles DROP COLUMN IF EXISTS ${col}\\b`);
      expect(MIG_0059).toMatch(re);
    }
  });

  it('does NOT drop email or phone (load-bearing for auth + OTP)', () => {
    expect(MIG_0059).not.toMatch(/DROP COLUMN[^;]*\bemail\b/);
    expect(MIG_0059).not.toMatch(/DROP COLUMN[^;]*\bphone\b/);
  });
});

describe('Patient account page — no longer reads or writes address fields', () => {
  it('the profile SELECT (now on the account page) does not include address columns', () => {
    for (const col of DROPPED) {
      expect(ACCOUNT_PAGE).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('the updateProfile server action accepts ONLY { phone } now', () => {
    // The action's parameter type narrowed to { phone: string | null }.
    expect(ACCOUNT_PAGE).toMatch(/data:\s*\{\s*phone:\s*string\s*\|\s*null\s*\}/);
  });

  it('email + phone are still selected (we did NOT collateral-damage them)', () => {
    expect(ACCOUNT_PAGE).toMatch(/\bemail\b/);
    expect(ACCOUNT_PAGE).toMatch(/\bphone\b/);
  });

  it('the retired profile route is an inert redirect that touches no address columns', () => {
    expect(PROFILE_PAGE).toContain("redirect('/patient/account')");
    for (const col of DROPPED) {
      expect(PROFILE_PAGE).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

describe('AccountAccordion — the "Contact & billing address" section is gone', () => {
  // Post-consolidation the settings accordion is AccountAccordion. There is
  // no standalone Phone or address section — phone folded into Personal
  // details. Only the "no address-fields ANYWHERE" invariant matters here.
  it('no "contactAddress" or "billing address" copy remains in the accordion', () => {
    expect(ACCOUNT_ACCORDION).not.toMatch(/contactAddress/);
    expect(ACCOUNT_ACCORDION).not.toMatch(/billing address/i);
  });

  it('accordion no longer has a standalone "Phone number" section title', () => {
    // Phone is inline within Personal details (PhoneField). The
    // standalone accordion header is gone.
    expect(ACCOUNT_ACCORDION).not.toMatch(/title="Phone number"/);
  });
});

describe('PhoneField — phone-only editor (successor to AddressForm + PhoneForm)', () => {
  it('captures phone only (no address fields)', () => {
    // PhoneField's update payload is a single `{ phone: string | null }`
    // — this regex pins the shape without depending on a specific
    // type alias name.
    expect(PHONE_FORM).toMatch(/updateProfile.*\{\s*phone:\s*string\s*\|\s*null\s*\}/);
    for (const col of DROPPED) {
      expect(PHONE_FORM).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('the AddressForm.tsx file has been removed', () => {
    expect(existsSync(resolve(ROOT, 'app/patient/profile/AddressForm.tsx'))).toBe(false);
  });
});

describe('Admin customer detail page — does not display patient address', () => {
  it('does not select the dropped columns', () => {
    for (const col of DROPPED) {
      expect(ADMIN_CUSTOMER).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('the "Contact & address" section title is gone — "Contact" only', () => {
    expect(ADMIN_CUSTOMER).not.toMatch(/Contact & address/);
  });

  it('still shows email + phone (we kept the load-bearing fields)', () => {
    expect(ADMIN_CUSTOMER).toMatch(/Field label="Email"/);
    expect(ADMIN_CUSTOMER).toMatch(/Field label="Phone"/);
  });
});
