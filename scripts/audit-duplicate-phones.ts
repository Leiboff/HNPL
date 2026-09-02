#!/usr/bin/env tsx
//
// ─── What still has to be resolved before phone can be a unique index ─────
//
//   pnpm audit:duplicate-phones
//
// Exit 0 = no duplicate verified numbers; the index in 0139's header can be
//          created as-is.
// Exit 1 = duplicates remain. Exit 2 = could not check.
//
// WHY THIS EXISTS
//
// Migration 0139 guards every NEW verification, which is the part that had
// to ship immediately. What it cannot do is remove the duplicates that were
// already there — at the time it was written, six numbers, one of them on
// fifty accounts with forty-one verified, accumulated over three months
// because nothing in the system could notice.
//
// Those rows are somebody's data and somebody's decision, not a migration's.
// This is the list, so the decision can be made from facts rather than from
// a count. When it comes back empty, replace the trigger with the unique
// index 0139's header carries and the guarantee becomes structural.
//
// SAFETY
//
// Read-only. Never prints a full phone number — the last four digits are
// enough to recognise your own test number and not enough to be a contact
// list. Never writes.

import { createClient } from '@supabase/supabase-js';

const OK = 0, DUPES = 1, CANNOT_CHECK = 2;

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

/** Mirrors lib/validation/phone.ts and hnpl_normalise_phone_za (0139). */
function normalise(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\-()]/g, '');
  let local9: string | null = null;
  if      (/^\+27[0-9]{9}$/.test(cleaned)) local9 = cleaned.slice(3);
  else if (/^27[0-9]{9}$/.test(cleaned))   local9 = cleaned.slice(2);
  else if (/^0[0-9]{9}$/.test(cleaned))    local9 = cleaned.slice(1);
  else return null;
  return '678'.includes(local9[0]) ? `+27${local9}` : null;
}

type Row = {
  id: string; role: string | null; email: string | null;
  phone: string | null; phone_verified_at: string | null;
  onboarding_completed: boolean | null; approved_credit_limit: number | null;
  created_at: string;
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail(CANNOT_CHECK, 'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const svc = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await svc
    .from('profiles')
    .select('id, role, email, phone, phone_verified_at, onboarding_completed, approved_credit_limit, created_at')
    .not('phone', 'is', null)
    .order('created_at', { ascending: true });
  if (error) fail(CANNOT_CHECK, `could not read profiles: ${error.message}`);

  const rows = (data ?? []) as Row[];
  const groups = new Map<string, Row[]>();
  let unnormalisable = 0;

  for (const r of rows) {
    const key = normalise(r.phone);
    if (!key) { unnormalisable += 1; continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  // Only VERIFIED PATIENT rows can collide under 0139's rule — an
  // unverified number is not a claim, and a practice admin sharing with a
  // patient is one person with two legitimate roles (0097's precedent).
  const blocking = [...groups.entries()]
    .map(([key, rs]) => ({
      key,
      verifiedPatients: rs.filter((r) => r.role === 'patient' && r.phone_verified_at),
      all: rs,
    }))
    .filter((g) => g.verifiedPatients.length > 1)
    .sort((a, b) => b.verifiedPatients.length - a.verifiedPatients.length);

  console.log(`profiles with a phone:        ${rows.length}`);
  console.log(`could not be normalised:      ${unnormalisable}`);
  console.log(`distinct numbers:             ${groups.size}`);
  console.log(`numbers blocking the index:   ${blocking.length}\n`);

  for (const g of blocking) {
    const withCredit = g.verifiedPatients.filter((r) => r.approved_credit_limit != null).length;
    console.log(`…${g.key.slice(-4)}  ${g.verifiedPatients.length} verified patient accounts`
      + `  (${g.all.length} rows in total, ${withCredit} with a credit limit)`);
    for (const r of g.verifiedPatients) {
      // The first account is the one the index would keep; every later one
      // has to be resolved. Printed in creation order so that is obvious.
      console.log(`   ${r.created_at.slice(0, 10)}  ${r.id}  ${r.email ?? '(no email)'}`
        + (r.approved_credit_limit != null ? `  CREDIT R${r.approved_credit_limit}` : ''));
    }
    console.log('');
  }

  if (blocking.length === 0) {
    console.log('No duplicate verified patient numbers. The unique index in the header of\n'
      + 'supabase/migrations/0139_unique_verified_phone.sql can now be created, and the\n'
      + 'trigger it stands in for can be retired.');
    process.exit(OK);
  }

  console.log('To resolve one: clear phone_verified_at on the accounts that should not keep\n'
    + 'the number. That is the same operation the recycled-number remedy uses, it is\n'
    + 'always permitted by the 0139 trigger, and it does not delete anybody\'s account.\n'
    + 'An account carrying a credit limit is NOT a routine clear — check it first.');
  process.exit(DUPES);
}

main().catch((err) => fail(CANNOT_CHECK, err instanceof Error ? err.message : String(err)));
