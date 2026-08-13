import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── A roster-only practitioner is BILLABLE end to end ────────────────────
//
// 0094 made plans point at a practice_members row instead of an auth user. The
// migration and its RLS are covered against real Postgres in
// supabase/migrations/0094_plans_provider_member.rls.test.ts. What THIS file
// pins is the application half — the places where a roster practitioner could
// still be silently excluded even with the column repointed:
//
//   1. the picker must not filter them out (the original bug was structural:
//      it selected user_id and joined profiles, so a login-less row produced a
//      blank option with an empty value)
//   2. createBill must not require a user_id to accept them
//   3. patient_invitations.provider_id must not be handed a membership id —
//      it references profiles(id) and would break the FK
//
// Source-level because each is a property of the QUERY, and a query that
// quietly drops a class of row is exactly what a rendering test misses.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** Comments stripped: these files discuss the very filters they must not use. */
const codeOf = (src: string) => stripComments(src);

const PICKER   = read('app/practice/bills/new/page.tsx');
const ACTIONS  = read('app/practice/bills/new/actions.ts');
const POS      = read('app/practice/pos/actions.ts');
const IDENTITY = read('lib/practice/providerIdentity.ts');

describe('the bill picker offers roster-only practitioners', () => {
  it.each([
    ['desktop bill form', PICKER],
    ['till / POS',        POS],
  ])('%s selects the membership id and does not require a login', (_name, src) => {
    const code = codeOf(src);

    // The provider query must be membership-keyed…
    expect(code).toMatch(/\.eq\('role', 'provider'\)/);
    expect(code).toMatch(/\.eq\('active', true\)/);

    // …and must NOT exclude login-less rows. Either of these filters would
    // reintroduce the exact gap 0094 closes.
    expect(code).not.toMatch(/\.not\('user_id', 'is', null\)/);
    expect(code).not.toMatch(/\.is\('user_id', null\)/);

    // Names resolve through the shared resolver rather than a local
    // profiles-only read, which is what silently blanked roster rows.
    expect(code).toMatch(/providerMemberName/);
  });

  it('the option value is the membership id, never the auth user id', () => {
    // A picker whose option value was user_id would submit an empty string for
    // a roster practitioner — the failure mode being prevented.
    const code = codeOf(PICKER);
    expect(code).toMatch(/memberId:\s*m\.id/);
    expect(code).not.toMatch(/userId:\s*m\.user_id/);
  });
});

describe('createBill accepts a practitioner with no login', () => {
  const code = codeOf(ACTIONS);

  it('validates the membership by id + practice, not by user_id', () => {
    expect(code).toMatch(/\.eq\('id', providerMemberId\)/);
    expect(code).toMatch(/\.eq\('practice_id', practiceId\)/);
    // The old form keyed the lookup on the auth user, which a roster
    // practitioner does not have.
    expect(code).not.toMatch(/\.eq\('user_id', providerId\)/);
  });

  it('does not reject the practitioner for having a null user_id', () => {
    // The guard must be on the ROW existing, not on it having a login.
    expect(code).toMatch(/if \(!providerMember\) return/);
    expect(code).not.toMatch(/!providerMember\.user_id/);
  });

  it('writes provider_member_id onto the plan, and not the deprecated column', () => {
    expect(code).toMatch(/provider_member_id:\s*providerMemberId/);
    expect(code).not.toMatch(/provider_id:\s*providerMemberId/);
  });

  it('feeds patient_invitations.provider_id the USER id, never the membership id', () => {
    // patient_invitations.provider_id references profiles(id) (0045 set it to
    // CASCADE). Handing it a practice_members id would violate the FK for a
    // login-having provider and be meaningless for a roster one.
    expect(code).toMatch(/provider_id:\s*providerMember\.user_id \?\? null/);
  });

  it.each([['desktop', ACTIONS], ['till', POS]])(
    '%s selects user_id on the membership so the invitation/payout leg can resolve it',
    (_n, src) => {
      expect(codeOf(src)).toMatch(/\.select\('id, user_id'\)/);
    });
});

describe('the name resolver is the single place the two name homes are reconciled', () => {
  it('handles both homes and is used by every provider-name surface', () => {
    const code = codeOf(IDENTITY);
    expect(code).toMatch(/provider_first_name/);
    expect(code).toMatch(/profiles/);

    // Every surface that shows a practitioner name goes through it, rather
    // than re-implementing the fallback and getting it wrong once.
    for (const p of [
      'app/practice/bills/new/page.tsx',
      'app/practice/pos/actions.ts',
      'app/brand/revenue/page.tsx',
      'app/brand/page.tsx',
      'app/practice/billHelpers.ts',
    ]) {
      expect(codeOf(read(p)), `${p} must resolve names via providerIdentity`)
        .toMatch(/providerMemberName/);
    }
  });

  it('no surface still joins profiles through the deprecated plans FK', () => {
    // plans_provider_id_fkey embeds would resolve to nothing for a roster
    // practitioner and break outright once the column is dropped.
    for (const p of [
      'app/practice/page.tsx',
      'app/patient/orders/page.tsx',
      'app/brand/revenue/page.tsx',
      'app/brand/page.tsx',
      'app/provider/page.tsx',
    ]) {
      expect(codeOf(read(p)), `${p} must not embed via plans_provider_id_fkey`)
        .not.toMatch(/plans_provider_id_fkey/);
    }
  });
});
