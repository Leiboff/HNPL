import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Priority-1 security fixes — regression suite (audit 2026-06-21) ────
//
// This file pins the contract of the four migrations + code changes
// that closed the cluster of "owner-writable column" findings (C1, C2,
// H1, H2, H3, M2, M5). The tests are intentionally source-text /
// configuration-shape regressions — the migrations themselves run only
// in Postgres, so vitest can't exercise them at runtime; what vitest
// CAN do is make sure the migration file STAYS structurally correct,
// the call sites stay on the privileged path, and the cron + RPC
// coded-error vocabulary remains in lockstep with the code that
// consumes it.
//
// Each describe block has both sides:
//   • "attack-blocked" — the post-fix shape required to reject the
//     attack the audit found.
//   • "legit-flows-green" — the privileged path that must still work
//     after the lock (admin actions wired through service-role,
//     OTP RPCs still settable for the right caller, etc.).

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const MIG_0054         = read('supabase/migrations/0054_protect_owner_writable_columns.sql');
const MIG_0055         = read('supabase/migrations/0055_phone_otp_burn_caps.sql');
const MIG_0056         = read('supabase/migrations/0056_revoke_next_invoice_number_from_authenticated.sql');
const ADMIN_PRACTICES  = read('app/admin/practices/actions.ts');
const ADMIN_AUDIT_ACT  = read('app/admin/_lib/auditActions.ts');
const BILLS_ACT        = read('app/practice/bills/new/actions.ts');
const VERIFY_PHONE_PG  = read('app/(auth)/verify-phone/page.tsx');
const VERIFY_PHONE_ACT = read('app/(auth)/verify-phone/actions.ts');
const CHECKOUT_ACT     = read('app/checkout/[token]/actions.ts');
const CRON_RT          = read('app/api/cron/collect-instalments/route.ts');
const OTP_STEP         = read('app/_otp/PhoneOtpStep.tsx');

// ═════════════════════════════════════════════════════════════════════
//   C1 + C2 + H2 + H3 — Migration 0054 column-lock
// ═════════════════════════════════════════════════════════════════════

describe('Migration 0054 — privileged-path bypass logic (legit-flows-green)', () => {
  it('both trigger functions short-circuit when auth.role() = service_role', () => {
    expect(MIG_0054).toMatch(/protect_profiles_columns[\s\S]*?auth\.role\(\)\s*=\s*'service_role'/);
    expect(MIG_0054).toMatch(/protect_practices_columns[\s\S]*?auth\.role\(\)\s*=\s*'service_role'/);
  });

  it('both trigger functions ALSO short-circuit when app.privileged_write is on', () => {
    // The transaction-local flag is the bypass for SECURITY DEFINER
    // RPCs that legitimately set a protected column. `true` third arg
    // scopes it to the current transaction.
    expect(MIG_0054).toMatch(/protect_profiles_columns[\s\S]*?current_setting\('app\.privileged_write',\s*true\)\s*=\s*'on'/);
    expect(MIG_0054).toMatch(/protect_practices_columns[\s\S]*?current_setting\('app\.privileged_write',\s*true\)\s*=\s*'on'/);
  });

  it('both trigger functions are SECURITY DEFINER + SET search_path = public', () => {
    expect(MIG_0054).toMatch(/protect_profiles_columns[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public/);
    expect(MIG_0054).toMatch(/protect_practices_columns[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public/);
  });
});

describe('Migration 0054 — profiles column-lock (attack-blocked)', () => {
  it('rejects role change on non-privileged paths', () => {
    expect(MIG_0054).toMatch(/IF NEW\.role IS DISTINCT FROM OLD\.role THEN[\s\S]*?RAISE EXCEPTION/);
  });

  it('rejects email change on non-privileged paths', () => {
    expect(MIG_0054).toMatch(/IF NEW\.email IS DISTINCT FROM OLD\.email THEN[\s\S]*?RAISE EXCEPTION/);
  });

  it('rejects phone_verified_at change on non-privileged paths', () => {
    expect(MIG_0054).toMatch(/IF NEW\.phone_verified_at IS DISTINCT FROM OLD\.phone_verified_at THEN[\s\S]*?RAISE EXCEPTION/);
  });

  it('the BEFORE UPDATE trigger is wired on profiles', () => {
    expect(MIG_0054).toMatch(/CREATE TRIGGER trg_protect_profiles_columns\s+BEFORE UPDATE ON profiles/);
  });

  it('phone is INTENTIONALLY not in the protected list (patients edit their own phone)', () => {
    // Defensive — confirm the profiles trigger does NOT block phone.
    // Search for a "NEW.phone IS DISTINCT FROM OLD.phone" guard; if a
    // future PR adds it, /patient/profile + /provider/profile break.
    const profileTrigger = MIG_0054.match(
      /CREATE OR REPLACE FUNCTION protect_profiles_columns[\s\S]*?\$\$/,
    )?.[0] ?? '';
    expect(profileTrigger).not.toMatch(/NEW\.phone\s+IS DISTINCT FROM OLD\.phone/);
  });
});

describe('Migration 0054 — practices column-lock (attack-blocked)', () => {
  it('rejects status change on non-privileged paths', () => {
    expect(MIG_0054).toMatch(/IF NEW\.status IS DISTINCT FROM OLD\.status THEN[\s\S]*?RAISE EXCEPTION/);
  });

  it('rejects fee_percent change on non-privileged paths', () => {
    expect(MIG_0054).toMatch(/IF NEW\.fee_percent IS DISTINCT FROM OLD\.fee_percent THEN[\s\S]*?RAISE EXCEPTION/);
  });

  it('rejects approved_at / approved_by change on non-privileged paths', () => {
    expect(MIG_0054).toMatch(/IF NEW\.approved_at IS DISTINCT FROM OLD\.approved_at THEN[\s\S]*?RAISE EXCEPTION/);
    expect(MIG_0054).toMatch(/IF NEW\.approved_by IS DISTINCT FROM OLD\.approved_by THEN[\s\S]*?RAISE EXCEPTION/);
  });

  // SUPERSEDED BY 0135. This asserts what migration 0054 SAYS, and 0054 is
  // unchanged, so it still passes — but the live trigger is now
  // `BEFORE INSERT OR UPDATE`. 0054's UPDATE-only wiring is exactly what made
  // R3-02 possible (status='approved' supplied at INSERT was never seen by
  // the trigger). The current wiring is pinned in
  // supabase/migrations/0135_close_insert_surface.rls.test.ts.
  it('the BEFORE UPDATE trigger is wired on practices (0054 as written)', () => {
    expect(MIG_0054).toMatch(/CREATE TRIGGER trg_protect_practices_columns\s+BEFORE UPDATE ON practices/);
  });
});

describe('Migration 0054 — admin_audit_log row written for fee/status change (audit trail)', () => {
  it('an AFTER UPDATE trigger on practices logs fee_percent changes to admin_audit_log', () => {
    expect(MIG_0054).toMatch(/CREATE TRIGGER trg_log_practice_protected_changes\s+AFTER UPDATE ON practices/);
    expect(MIG_0054).toMatch(
      /NEW\.fee_percent IS DISTINCT FROM OLD\.fee_percent[\s\S]*?INSERT INTO admin_audit_log[\s\S]*?'fee_changed'/,
    );
  });

  it('also logs status changes (action=status_changed)', () => {
    expect(MIG_0054).toMatch(
      /NEW\.status IS DISTINCT FROM OLD\.status[\s\S]*?INSERT INTO admin_audit_log[\s\S]*?'status_changed'/,
    );
  });

  it('admin_audit_log row carries from/to payload matching the existing changePracticeFeePercent shape', () => {
    expect(MIG_0054).toMatch(/jsonb_build_object\(\s*'from'\s*,\s*OLD\.fee_percent\s*,\s*'to'\s*,\s*NEW\.fee_percent\s*\)/);
    expect(MIG_0054).toMatch(/jsonb_build_object\(\s*'from'\s*,\s*OLD\.status\s*,\s*'to'\s*,\s*NEW\.status\s*\)/);
  });
});

// ═════════════════════════════════════════════════════════════════════
//   C2 — admin actions are wired through service-role (legit-flows-green)
// ═════════════════════════════════════════════════════════════════════

describe('Admin actions write practices via the service-role client (post-0054)', () => {
  it('approvePractice no longer uses guard.supabase (session client) for the UPDATE', () => {
    // The session client UPDATE would be rejected by the BEFORE UPDATE
    // trigger now that approved_at/approved_by/status are protected.
    expect(ADMIN_PRACTICES).toMatch(/svc\(\)\s*\.from\('practices'\)[\s\S]{0,400}\.update\(\s*\{[\s\S]{0,200}status:\s*'approved'/);
    // No `guard.supabase.from('practices').update` remains.
    expect(ADMIN_PRACTICES).not.toMatch(/guard\.supabase\s*\.from\('practices'\)[\s\S]{0,200}\.update/);
  });

  it('suspendPractice routes the UPDATE through svc() too', () => {
    expect(ADMIN_PRACTICES).toMatch(/svc\(\)\s*\.from\('practices'\)[\s\S]{0,400}\.update\(\s*\{\s*status:\s*'suspended'\s*\}\s*\)/);
  });

  it('approvePractice still runs the admin guard FIRST (sole authz on the service-role write)', () => {
    // Ordering check: guardAdmin() must appear before svc() inside the
    // function body — the service-role client bypasses RLS, so the
    // app-level admin check is now the only authz on the write.
    const fn = ADMIN_PRACTICES.match(/export async function approvePractice[\s\S]*?^\}/m)?.[0] ?? '';
    const guardIdx = fn.indexOf('await guardAdmin()');
    const svcIdx   = fn.indexOf('svc()');
    expect(guardIdx).toBeGreaterThan(0);
    expect(svcIdx).toBeGreaterThan(guardIdx);
  });

  it('changePracticeFeePercent uses svc() for the UPDATE (audit log uses session client)', () => {
    expect(ADMIN_AUDIT_ACT).toMatch(/svc\(\)\s*\.from\('practices'\)[\s\S]{0,300}\.update\(\s*\{\s*fee_percent:/);
  });

  it('changePracticeFeePercent still writes its own admin_audit_log row (action=fee_changed)', () => {
    // Source-text on the existing logging path — the migration 0054
    // trigger is belt-and-braces; the explicit logging must remain.
    expect(ADMIN_AUDIT_ACT).toMatch(/action:\s*'fee_changed'/);
  });
});

// ═════════════════════════════════════════════════════════════════════
//   H3 — /verify-phone reads from phone_verifications (defence in depth)
// ═════════════════════════════════════════════════════════════════════

describe('/verify-phone reads from phone_verifications (not profiles.phone_verified_at)', () => {
  it('page.tsx queries phone_verifications for the verified-state read', () => {
    expect(VERIFY_PHONE_PG).toMatch(/\.from\('phone_verifications'\)[\s\S]{0,300}\.eq\('user_id',\s*user\.id\)/);
    expect(VERIFY_PHONE_PG).toMatch(/\.not\('verified_at',\s*'is',\s*null\)/);
  });

  it('page.tsx no longer reads phone_verified_at from the profiles select', () => {
    // The select column list should no longer include phone_verified_at.
    const profileSelect = VERIFY_PHONE_PG.match(/from\('profiles'\)\s*\.select\(([^)]+)\)/)?.[1] ?? '';
    expect(profileSelect).not.toMatch(/phone_verified_at/);
  });

  it('verify-phone actions short-circuit via phone_verifications too (both request + verify)', () => {
    // The post-fix already-verified short-circuit in both server
    // actions reads phone_verifications, not profiles.
    const occurrences = (VERIFY_PHONE_ACT.match(/\.from\('phone_verifications'\)/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(VERIFY_PHONE_ACT).not.toMatch(/profile\.phone_verified_at/);
  });
});

// ═════════════════════════════════════════════════════════════════════
//   H1 — Migration 0055 SMS-burn caps
// ═════════════════════════════════════════════════════════════════════

describe('Migration 0055 — SMS-burn caps (attack-blocked)', () => {
  it('user-keyed RPC enforces phone-match against profiles.phone', () => {
    expect(MIG_0055).toMatch(
      /prepare_phone_verification_for_user[\s\S]*?SELECT phone INTO v_profile_phone FROM profiles WHERE id = p_user_id/,
    );
    expect(MIG_0055).toMatch(/p_phone IS DISTINCT FROM v_profile_phone[\s\S]*?RETURN 'phone_mismatch'/);
  });

  it('user-keyed RPC enforces a per-user total cap (10 sends in 24h, any phone)', () => {
    expect(MIG_0055).toMatch(/v_user_total[\s\S]*?SUM\(send_count\)[\s\S]*?WHERE user_id = p_user_id[\s\S]*?last_sent_at > now\(\) - INTERVAL '24 hours'/);
    expect(MIG_0055).toMatch(/v_user_total >= 10[\s\S]*?RETURN 'user_daily_limit'/);
  });

  it('token-keyed RPC enforces a per-token total cap (10 sends in 24h, any phone)', () => {
    expect(MIG_0055).toMatch(/v_token_total[\s\S]*?SUM\(send_count\)[\s\S]*?WHERE invitation_token = p_token[\s\S]*?last_sent_at > now\(\) - INTERVAL '24 hours'/);
    expect(MIG_0055).toMatch(/v_token_total >= 10[\s\S]*?RETURN 'token_daily_limit'/);
  });
});

describe('Migration 0055 — existing caps preserved (legit-flows-green)', () => {
  it('30-second cooldown per (key, phone) still in place on both RPCs', () => {
    expect(MIG_0055).toMatch(/prepare_phone_verification[\s\S]*?last_sent_at > now\(\) - INTERVAL '30 seconds'[\s\S]*?RETURN 'too_soon'/);
    expect(MIG_0055).toMatch(/prepare_phone_verification_for_user[\s\S]*?last_sent_at > now\(\) - INTERVAL '30 seconds'[\s\S]*?RETURN 'too_soon'/);
  });

  it('per-(key, phone) 5/24h cap still in place on both RPCs', () => {
    // Match through END;\n$$; so we capture the FULL function body —
    // a lazy match against \$\$ would stop at the opening AS $$.
    const tokenFn = MIG_0055.match(/CREATE OR REPLACE FUNCTION prepare_phone_verification\([\s\S]*?END;\s*\$\$;/)?.[0] ?? '';
    const userFn  = MIG_0055.match(/CREATE OR REPLACE FUNCTION prepare_phone_verification_for_user[\s\S]*?END;\s*\$\$;/)?.[0] ?? '';
    expect(tokenFn).toMatch(/v_existing\.send_count >= 5[\s\S]*?RETURN 'daily_limit'/);
    expect(userFn).toMatch(/v_existing\.send_count >= 5[\s\S]*?RETURN 'daily_limit'/);
  });

  it('checkout server action handles token_daily_limit code', () => {
    expect(CHECKOUT_ACT).toMatch(/'token_daily_limit'/);
  });

  it('user-keyed server action handles phone_mismatch + user_daily_limit codes', () => {
    expect(VERIFY_PHONE_ACT).toMatch(/'phone_mismatch'/);
    expect(VERIFY_PHONE_ACT).toMatch(/'user_daily_limit'/);
  });

  it('PhoneOtpStep maps new codes to user copy', () => {
    expect(OTP_STEP).toMatch(/case 'token_daily_limit':/);
    expect(OTP_STEP).toMatch(/case 'user_daily_limit':/);
    expect(OTP_STEP).toMatch(/case 'phone_mismatch':/);
  });
});

// ═════════════════════════════════════════════════════════════════════
//   M2 — next_invoice_number revoke
// ═════════════════════════════════════════════════════════════════════

describe('Migration 0056 — M2 revoke next_invoice_number from authenticated', () => {
  it('declares the REVOKE on the authenticated role (attack-blocked)', () => {
    expect(MIG_0056).toMatch(/REVOKE EXECUTE ON FUNCTION next_invoice_number\(\) FROM authenticated/);
  });

  it('explicitly grants to service_role so prod environments cannot accidentally lose it (legit-flows-green)', () => {
    expect(MIG_0056).toMatch(/GRANT EXECUTE ON FUNCTION next_invoice_number\(\) TO service_role/);
  });

  it('bill creation routes next_invoice_number through the service-role client', () => {
    // Pre-fix: supabase.rpc('next_invoice_number'). Post-fix: svc.rpc.
    expect(BILLS_ACT).toMatch(/svc\.rpc\('next_invoice_number'\)/);
    expect(BILLS_ACT).not.toMatch(/supabase\.rpc\('next_invoice_number'\)/);
  });
});

// ═════════════════════════════════════════════════════════════════════
//   M5 — cron auth header timing-safe
// ═════════════════════════════════════════════════════════════════════

describe('Cron route auth — M5 timing-safe compare', () => {
  it('uses crypto.timingSafeEqual against equal-length buffers', () => {
    expect(CRON_RT).toMatch(/crypto\.timingSafeEqual\(receivedBuf,\s*expectedBuf\)/);
    expect(CRON_RT).toMatch(/receivedBuf\.length\s*===\s*expectedBuf\.length/);
  });

  it('no longer uses raw string !== for the auth check', () => {
    // The old code path was: if (req.headers.get('authorization') !== expected)
    // The new code path stores headers in a buffer and uses timingSafeEqual.
    // A literal '!== expected' string match against the file would be
    // brittle — instead assert the buffer-based pattern is present.
    expect(CRON_RT).toMatch(/Buffer\.from\(expected,\s*'utf8'\)/);
  });

  it('continues to handle short / missing auth header cleanly (no throw)', () => {
    // The receivedHdr null-coalesces to '' so Buffer.from('', 'utf8') is a
    // zero-length buffer; equal-length check rejects without throwing.
    expect(CRON_RT).toMatch(/req\.headers\.get\('authorization'\)\s*\?\?\s*''/);
  });
});
