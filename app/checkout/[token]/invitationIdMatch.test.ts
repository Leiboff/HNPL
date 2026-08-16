import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'crypto';
import { stripComments } from '@/lib/testing/stripComments';
import { encryptId, decryptId } from '@/lib/idEncryption';
import { VALID_SA_IDS } from '@/lib/testing/saIdFixtures';

// ─── The email path enforces the customer key too ────────────────────────
//
// Bills gained a mandatory SA ID, but only one branch enforced it. The QR
// path decrypts the session's stored ID at checkout and ignores whatever
// the client sent; the EMAIL path validated the practice's ID, checked it
// for conflicts, and then DISCARDED it — the patient typed their own at
// checkout with nothing comparing the two. A practice could bill under one
// ID and the patient claim under another and nothing would notice.
//
// Migration 0098 puts the practice's encrypted ID on patient_invitations,
// and initiateCheckout compares it before anything is created or bound.

const ROOT    = resolve(process.cwd());
const read    = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));
const readSql = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'), { sql: true });

const MIG_NAME = '0098_invitation_sa_id_and_completion_window.sql';
const MIG      = readSql(`supabase/migrations/${MIG_NAME}`);
const ACTIONS  = read('app/checkout/[token]/actions.ts');
const BILLS    = read('app/practice/bills/new/actions.ts');
const POS      = read('app/practice/pos/actions.ts');
const PAGE     = read('app/checkout/[token]/page.tsx');

beforeAll(() => {
  process.env.SA_ID_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

describe('the migration', () => {
  it('is 0098, and nothing else claims that version', () => {
    const files = readdirSync(resolve(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    expect(files.filter((f) => f.startsWith('0098'))).toEqual([MIG_NAME]);
  });

  it('adds the encrypted ID to patient_invitations, NULLABLE', () => {
    expect(MIG).toMatch(/ALTER TABLE patient_invitations\s+ADD COLUMN IF NOT EXISTS sa_id_number TEXT;/);
    // Rows issued before this have no ID and nothing to backfill from, so
    // NOT NULL is not merely inconvenient — it is unsatisfiable.
    expect(MIG).not.toMatch(/sa_id_number TEXT NOT NULL/);
    expect(MIG).not.toMatch(/SET NOT NULL/);
  });

  it('adds NO lookup hash — there is no equality search and no unique index to serve', () => {
    // profiles.sa_id_lookup_hash exists for 0097 and for findPatientBySaId.
    // An invitation is found by TOKEN, so the ID is only ever compared, not
    // searched. A second store of ID-derived material with no consumer
    // reads as load-bearing to whoever finds it next.
    expect(MIG).not.toMatch(/sa_id_lookup_hash/);
    expect(MIG).not.toMatch(/hashIdForLookup/);
  });

  it('teaches get_invitation_by_token to return it, still encrypted', () => {
    expect(MIG).toMatch(/CREATE OR REPLACE FUNCTION get_invitation_by_token/);
    expect(MIG).toMatch(/pi\.sa_id_number/);
    expect(MIG).toMatch(/GRANT EXECUTE ON FUNCTION get_invitation_by_token\(TEXT\) TO anon, authenticated;/);
  });

  it('touches no plan, no account and no RLS predicate', () => {
    expect(MIG).not.toMatch(/DELETE FROM/i);
    expect(MIG).not.toMatch(/UPDATE plans/i);
    expect(MIG).not.toMatch(/CREATE POLICY|DROP POLICY/i);
    expect(MIG).not.toMatch(/ALTER TABLE profiles/i);
  });
});

describe('both surfaces put the practice-typed ID on the invitation', () => {
  it('the dashboard writes it', () => {
    const invite = BILLS.slice(BILLS.indexOf("from('patient_invitations').insert("));
    expect(invite).toMatch(/sa_id_number: identity\.encryptedSaId/);
  });

  it('the till writes it too — the email path is not a second-class citizen', () => {
    const invite = POS.slice(POS.indexOf("from('patient_invitations').insert("));
    expect(invite).toMatch(/sa_id_number: identity\.encryptedSaId/);
  });

  it('what is stored is CIPHERTEXT, never the typed digits', () => {
    // encryptedSaId is encryptId's output by construction; asserted here on
    // the real function so "encrypted" is a property, not a variable name.
    const plain = VALID_SA_IDS[0];
    const stored = encryptId(plain);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(plain);
    expect(decryptId(stored)).toBe(plain);
  });
});

describe('the comparison, and where it sits', () => {
  it('runs on the invitation branch, decrypting the BILL side', () => {
    expect(ACTIONS).toMatch(/decryptId\(resolved\.saIdNumber\)/);
    expect(ACTIONS).toMatch(/billSaId !== input\.saIdNumber\.trim\(\)/);
  });

  it('compares PLAINTEXT — two encryptions of one ID differ, so ciphertexts never match', () => {
    const plain = VALID_SA_IDS[0];
    expect(encryptId(plain)).not.toBe(encryptId(plain));
    expect(decryptId(encryptId(plain))).toBe(decryptId(encryptId(plain)));
    // And the source must not have taken the shortcut.
    expect(ACTIONS).not.toMatch(/resolved\.saIdNumber === input\.saIdNumber/);
  });

  it('fails CLOSED on an unreadable stored value', () => {
    // A key rotation or a corrupt row must refuse, never fall through to
    // "no comparison possible, carry on".
    const block = ACTIONS.slice(ACTIONS.indexOf('decryptId(resolved.saIdNumber)'));
    expect(block.slice(0, 400)).toMatch(/catch[\s\S]{0,200}return \{ ok: false/);
  });

  it('happens BEFORE the plan fetch, the discriminator and account creation', () => {
    const compare = ACTIONS.indexOf('billSaId !== input.saIdNumber.trim()');
    const planFetch = ACTIONS.indexOf("from('plans')", compare - 20000);
    const createUser = ACTIONS.indexOf('auth.admin.createUser');
    const bind = ACTIONS.indexOf('update({ patient_id: userId })');
    expect(compare).toBeGreaterThan(0);
    expect(createUser).toBeGreaterThan(compare);
    expect(bind).toBeGreaterThan(compare);
    expect(planFetch).toBeGreaterThan(compare);
  });

  it('skips the comparison only when the invitation genuinely has no ID', () => {
    // Legacy rows. The guard is on the stored value being present, NOT on
    // some flag that could drift.
    expect(ACTIONS).toMatch(/if \(resolved\.saIdNumber\) \{/);
  });

  it('the refusal names no other value and offers two real routes', () => {
    const msg = ACTIONS.slice(ACTIONS.indexOf('const BILL_ID_MISMATCH_MESSAGE'), ACTIONS.indexOf('export type InitiateCheckoutInput'));
    expect(msg).not.toMatch(/\$\{/);
    expect(msg).toMatch(/Check the ID number on/i);
    expect(msg).toMatch(/ask the practice to re-issue/i);
  });

  it('the QR path is untouched — it still ignores the client value entirely', () => {
    expect(ACTIONS).toMatch(/saIdPlain = decryptId\(resolved\.saIdNumber\)/);
  });
});

describe('the claim is no longer session-only', () => {
  it('runs for ANY unbound plan whose token carries an ID', () => {
    expect(PAGE).toMatch(/if \(sessionUser && planPatientId === null && tokenSaIdEncrypted\)/);
    expect(PAGE).not.toMatch(/resolved\.kind === 'session' && planPatientId === null/);
  });

  it('feeds the claim the token\'s stored ID whichever kind it is', () => {
    expect(PAGE).toMatch(/const tokenSaIdEncrypted: string \| null = resolved\.row\.sa_id_number \?\? null;/);
    expect(PAGE).toMatch(/sessionSaIdEncrypted: tokenSaIdEncrypted/);
  });

  it('still proves identity by SA ID, not by the existence of a session', () => {
    // The claim helper itself is untouched by this change; re-asserted
    // because widening WHO may call it must not widen WHAT it accepts.
    const CLAIM = read('lib/checkout/claimSessionPlan.ts');
    expect(CLAIM).toMatch(/sessionId !== profileId/);
    expect(CLAIM).toMatch(/\.is\('patient_id', null\)/);
  });

  it('passes whether the token carried an ID into the copy mapper', () => {
    expect(PAGE).toMatch(/tokenSaIdEncrypted !== null/);
  });
});
