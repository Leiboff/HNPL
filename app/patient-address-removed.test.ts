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
// Account + Profile consolidated onto ONE surface: the profile SELECT moved
// into the account page, and the settings component is now AccountSettings
// (it replaced AccountAccordion when the account page was reworked into a
// grouped hierarchy). The POPIA "no address fields anywhere" invariant is
// re-pointed to those successors.
//
// This file stopped COLLECTING when AccountAccordion.tsx was deleted — the
// read below is module-level, so the whole file threw before a single test
// ran, and the POPIA invariant silently stopped executing rather than
// failing. app/test-path-integrity.test.ts now makes that class of breakage
// a visible test failure instead of a collection error.
const ACCOUNT_PAGE      = read('app/patient/account/page.tsx');
const ACCOUNT_SETTINGS  = read('app/patient/account/AccountSettings.tsx');
// Post-0065 the standalone phone accordion is gone — phone is now
// an inline edit-toggle field inside Personal details, owned by
// PhoneField.tsx. This test still verifies the phone-only capture
// contract; just against the successor component.
const PHONE_FORM        = read('app/patient/profile/PhoneField.tsx');
// The phone SAVE path after the OTP-re-verification rework. The POPIA
// invariant follows the write, so it follows this file now.
const PHONE_ACTIONS     = read('app/patient/account/phoneChangeActions.ts');
const ADMIN_CUSTOMER    = read('app/admin/customers/[patientId]/page.tsx');
// The PUBLIC contact form. It sits outside the patient surface, which is
// exactly why it was unguarded: app/contact/ was not on this file's list, so
// an address input added there would have collected patient addresses with no
// test objecting. This invariant has already gone silently absent once (the
// whole file stopped collecting when a component it read was deleted), so the
// lesson is to widen the list rather than to assume a surface is safe because
// it is new.
const CONTACT_FORM      = read('app/contact/ContactForm.tsx');
const CONTACT_ACTION    = read('app/contact/contactAction.ts');
// The referral surface (0145). Added here for the reason the paragraph above
// gives about /contact — "widen the list rather than assume a surface is safe
// because it is new". This one collects details about a PRACTICE and about a
// person who is not even a customer, so it is exactly the shape that would
// grow an address field without anybody objecting. It is allowed a suburb
// (practices carry one; patients do not), which is why the DROPPED list's
// exclusion of the bare suburb/city/province names matters here too.
const REFER_FORM        = read('app/patient/refer/ReferForm.tsx');
const REFER_ACTIONS     = read('app/patient/refer/actions.ts');

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

  it('the phone save path takes a phone and NOTHING address-shaped', () => {
    // RE-DERIVED. This pinned `data: { phone: string | null }` on an inline
    // `updateProfile` action that no longer exists: a phone edit now requires
    // OTP re-verification, so the save path moved to
    // app/patient/account/phoneChangeActions.ts and the old action was
    // deleted outright. Re-pointing the literal would have been meaningless,
    // because the type it described is gone.
    //
    // The POPIA invariant is the point, and it is now asserted against the
    // SUCCESSOR — which this file did not cover at all before:
    expect(ACCOUNT_PAGE).not.toMatch(/async function updateProfile/);
    // The staging write takes exactly one column, and it is not an address.
    expect(PHONE_ACTIONS).toMatch(/\.update\(\{ phone_pending: normalized \}\)/);
    // The promotion writes phone + its verification stamp, nothing else.
    expect(PHONE_ACTIONS).toMatch(/phone_verified_at:/);
    for (const col of DROPPED) {
      expect(PHONE_ACTIONS).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
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

describe('AccountSettings — the "Contact & billing address" section is gone', () => {
  // Post-rework the settings component is AccountSettings. There is
  // no standalone Phone or address section — phone folded into Personal
  // details. Only the "no address-fields ANYWHERE" invariant matters here.
  it('no "contactAddress" or "billing address" copy remains in the accordion', () => {
    expect(ACCOUNT_SETTINGS).not.toMatch(/contactAddress/);
    expect(ACCOUNT_SETTINGS).not.toMatch(/billing address/i);
  });

  it('accordion no longer has a standalone "Phone number" section title', () => {
    // Phone is inline within Personal details (PhoneField). The
    // standalone accordion header is gone.
    expect(ACCOUNT_SETTINGS).not.toMatch(/title="Phone number"/);
  });
});

describe('Referral surface — collects no address, for a patient or for anyone else', () => {
  it('the form has no address input', () => {
    for (const col of DROPPED) {
      expect(REFER_FORM).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(REFER_FORM).not.toMatch(/street|postal code|post code/i);
  });

  it('the actions write no address column', () => {
    for (const col of DROPPED) {
      expect(REFER_ACTIONS).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('and the referrals table itself has no address column', () => {
    const migration = read('supabase/migrations/0145_referrals_foundation.sql');
    for (const col of DROPPED) {
      expect(migration).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

describe('PhoneField — phone-only editor (successor to AddressForm + PhoneForm)', () => {
  it('captures phone only (no address fields)', () => {
    // RE-DERIVED. PhoneField no longer receives an `updateProfile` prop: it
    // takes the four phone-change actions (start / requestOtp / verify /
    // cancel), because a number change must be OTP-verified before it
    // becomes the account's number. The payload-shape assertion therefore
    // belongs on the actions module, and has moved to the test above.
    //
    // What this test protects is unchanged and still worth pinning: the
    // phone editor captures a PHONE, and nothing address-shaped.
    expect(PHONE_FORM).toMatch(/startPhoneChange/);
    expect(PHONE_FORM).not.toMatch(/updateProfile/);
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

// ─── The public contact form collects no address ──────────────────────
//
// Reuses this file's own `read` + DROPPED mechanism rather than a fresh
// regex — lib/validation/regression.test.ts bans new validator regexes
// outside lib/validation/, and more practically a second mechanism here would
// be a second thing to keep in step with migration 0059.
//
// NOTE what is NOT in scope: the page renders OUR OWN office address (19 Cross
// Road) as published contact detail. That is a business fact on a marketing
// page, not personal information about a patient, and POPIA minimisation has
// nothing to say about it. What must never appear is an INPUT that collects
// somebody else's address.
describe('the public contact form collects no address', () => {
  it('references none of the dropped patient-address columns', () => {
    for (const col of DROPPED) {
      expect(CONTACT_FORM).not.toMatch(new RegExp(`\\b${col}\\b`));
      expect(CONTACT_ACTION).not.toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it('has no address-shaped INPUT, textarea or select', () => {
    // Field NAMES, not prose: the comment above deliberately discusses
    // addresses, and the page legitimately renders our own. Only a form
    // control that captures one is a violation.
    const CONTROL_NAMES = /(?:name|id)=["'](?:[a-z_]*(?:address|suburb|postal|postcode|zip|street|province|city|line1|line2)[a-z_]*)["']/i;
    expect(CONTACT_FORM).not.toMatch(CONTROL_NAMES);
  });

  it('the action accepts no address-shaped field in its input type', () => {
    // The server contract is the other half: a field the form does not render
    // but the action would accept is still a collection surface.
    const input = CONTACT_ACTION.slice(
      CONTACT_ACTION.indexOf('export type ContactEnquiryFormInput'),
      CONTACT_ACTION.indexOf('export type ContactEnquiryResult'),
    );
    expect(input.length).toBeGreaterThan(0);
    for (const word of ['address', 'suburb', 'postal', 'postcode', 'zip', 'street', 'province', 'city', 'line1', 'line2']) {
      expect(input.toLowerCase()).not.toContain(word);
    }
  });

  it('the field list is exactly the five it should be, plus the honeypot', () => {
    // A whitelist, so a NEW field of any kind has to be considered here
    // rather than only address-shaped ones being caught.
    // The character class must admit DIGITS and hyphens. The first draft used
    // [a-z_]+, which did not capture `address_line1` AT ALL — so a field named
    // with a digit slipped past the whitelist silently. Found by
    // mutation-testing this guard rather than by reading it.
    const names = [...CONTACT_FORM.matchAll(/\bname="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(
      ['email', 'kind', 'message', 'name', 'phone', 'website'],
    );
  });
});
