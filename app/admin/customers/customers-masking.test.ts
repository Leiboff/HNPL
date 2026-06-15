import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Customer record — sensitive-data masking regression ────────────────────
//
// The /admin/customers/[patientId] page renders an SA ID number and
// payment cards. Both are sensitive and MUST be masked in the UI — the
// full plaintext SA ID and full card number must never reach the page.
//
// Source-text regression: assert that the page imports the masking
// helpers and that it never selects a column that would inject raw
// PAN data (we only ever select last_four, never a full pan/number
// field). This catches future refactors that might accidentally swap
// `last_four` for `pan` or render the decrypted SA ID directly.

const ROOT  = resolve(process.cwd());
const detail = readFileSync(resolve(ROOT, 'app/admin/customers/[patientId]/page.tsx'), 'utf8');
const list   = readFileSync(resolve(ROOT, 'app/admin/customers/page.tsx'),             'utf8');

describe('customer detail page — SA ID masking', () => {
  it('imports the SA ID display helpers', () => {
    expect(detail).toMatch(/from\s+['"]@\/lib\/idEncryption['"]/);
    expect(detail).toMatch(/decryptIdForDisplay/);
    expect(detail).toMatch(/from\s+['"]@\/lib\/saIdMask['"]/);
    expect(detail).toMatch(/maskSaId/);
  });

  it('runs the SA ID through maskSaId before rendering', () => {
    // Locate the assignment that produces what gets rendered.
    expect(detail).toMatch(/maskSaId\(\s*saIdPlain\s*\)/);
    // And the rendered token uses the masked value, not the plaintext.
    expect(detail).toMatch(/\{saIdShown[^}]*\}/);
  });
});

describe('customer detail page — card masking', () => {
  it('selects only last_four from payment_methods (no full PAN column)', () => {
    expect(detail).toMatch(/\.from\(\s*['"]payment_methods['"]\s*\)/);
    // The column list does include last_four
    expect(detail).toMatch(/last_four/);
    // …and does NOT include any field that would store the full PAN.
    // Belt-and-braces — these fields don't even exist in the schema but a
    // future migration shouldn't be able to leak one through this page.
    expect(detail).not.toMatch(/\bpan\b/);
    expect(detail).not.toMatch(/card_number/);
    expect(detail).not.toMatch(/full_card/);
  });

  it("displays cards as `brand · •••• last_four`", () => {
    // Bullet characters used for masking (the actual rendered token).
    expect(detail).toMatch(/••••/);
    expect(detail).toMatch(/\{c\.last_four\}/);
  });
});

describe('customer list — does not select sensitive identifier columns', () => {
  it('never selects sa_id_number on the list page', () => {
    // The list page only needs identity/contact fields — never the ID.
    expect(list).not.toMatch(/sa_id_number/);
  });

  it('never selects payment_methods on the list page', () => {
    // Cards are sensitive enough that we deliberately don't surface
    // them in the patient list — only inside the detail page.
    expect(list).not.toMatch(/payment_methods/);
  });
});
