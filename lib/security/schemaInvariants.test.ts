// @vitest-environment node
//
// ─── The invariants three audits kept re-deriving by hand ─────────────────
//
// Rounds one, two and three each found a Critical issue, and two of them
// were the same shape: a table a user session can INSERT into, with nothing
// checking what the INSERT contains. F-01, F-05, A-17, R3-01 and R3-02 are
// all that bug. Each was fixed properly and none of the fixes generalised,
// because nobody ever asked the question in its general form.
//
// This file asks it, on every commit. The point is not that it re-finds the
// bugs already fixed — it is that the NEXT migration to add an INSERT policy
// fails CI until someone has decided, in writing, what guards it.
//
// ─── HOW TO READ A FAILURE ────────────────────────────────────────────────
//
// If you added a policy and this went red, you have three honest options and
// one dishonest one:
//
//   1. Add a BEFORE INSERT trigger on the table (the 0121/0128/0135 shape).
//   2. Add the table to INSERT_GUARD_EXEMPT below WITH A REASON that says
//      why an unconstrained INSERT is safe there.
//   3. Decide the policy should not exist and drop it — which is what
//      0135 concluded for both of round three's Criticals.
//
// The dishonest option is widening the exemption list without reading the
// WITH CHECK clause. The reason strings exist so that a reviewer can tell
// the difference in the diff.
//
// ─── WHAT THIS DOES NOT COVER ─────────────────────────────────────────────
//
// It replays the MIGRATIONS, so it describes the schema a fresh environment
// gets, and it cannot see the live database — a check that needs production
// credentials cannot run in CI, and a check that only runs when someone
// remembers to point it at production is a check that stops running. This one
// runs on the commit that introduces the policy, which is the only moment the
// fix is cheap.
//
// The two were reconciled by 0136 (audit R3-08): as of that migration the
// replay reproduces production exactly — 120 policies and 31 triggers,
// matching in both directions. The assertions in the R3-08 block below are
// what stop the repo drifting back. They cannot detect a NEW hand-edit made
// directly in the dashboard; only a periodic diff of replaySchema() against
// pg_policies can do that, and it belongs in ops rather than in CI.

import { describe, it, expect } from 'vitest';
import {
  assertFullyParsed,
  readMigrations,
  replaySchema,
  statementText,
  tablesWithUserInsert,
  hasBeforeInsertTrigger,
  browserCallableGrants,
} from './schemaInvariants';

const schema = replaySchema();

// ─── Exemptions, each with the reason it is safe ──────────────────────────
//
// "Trusted tier" means the only policy granting INSERT resolves through
// is_platform_admin(). That is a real answer, not a shrug: a platform admin
// can already do the thing the trigger would prevent, through the admin UI,
// and 0131 records it. It is NOT an answer for a table a patient or a
// practice member can write.
//
// Entries marked REVIEW are exempt today because the blast radius is bounded,
// and are listed in docs/SECURITY-AUDIT-R3.md as follow-up work. They are
// written here rather than omitted so the next person inherits the question
// instead of re-discovering it.

const INSERT_GUARD_EXEMPT: Record<string, string> = {
  // ── Trusted tier: platform admin only ──────────────────────────────────
  admin_audit_log:
    'Platform admin only. Written by recordAdminAction; an admin forging an '
    + 'audit row is a non-repudiation concern, not an authorization one.',
  payout_batches:
    'Platform admin only (admins_all_payout_batches). The batch runner writes '
    + 'these on the cron service-role client. REVIEW: money-shaped, and an '
    + 'admin INSERT is unconstrained.',
  plan_events:
    'Platform admin only. Append-only event log; no money and no decision '
    + 'reads from it.',
  refunds:
    'Platform admin only (admins_all_refunds). REVIEW: money-shaped, and the '
    + 'refund path is not yet exercised — worth a lock before it is.',
  practice_groups:
    'Platform admin only. Creating a group is an admin act; a group on its '
    + 'own confers nothing until a practice is placed in it.',
  practice_group_members:
    'Platform admin only. This is the table that grants brand-admin scope, so '
    + 'it is deliberately admin-exclusive rather than trigger-guarded.',

  // ── Scoped to the caller, and holding nothing that decides money ───────
  crm_activities:
    'INSERT is gated on crm_can_see_lead(lead_id) (0129). Call notes; no '
    + 'money, no identity, no decision reads from it.',
  crm_lead_tags:
    'crm_can_see_lead(lead_id) (0129). Free-text tags on a visible lead.',
  crm_tasks:
    'Owner-scoped and lead-scoped (0129), and a rep may only create tasks '
    + 'owned by themselves.',
  crm_saved_views:
    'owner_user_id = auth.uid(). A saved filter, visible to its owner.',
  crm_signatures:
    'Self-scoped (0072). The HTML is sanitised at the Server Action before it '
    + 'is stored, and the row is only ever read back for its own owner.',
  crm_suggestion_dismissals:
    'Both lead ids must pass crm_can_see_lead (0129). A dismissal flag.',
  crm_email_templates:
    'Admin-only INSERT (0129). Shared templates; merge fields are escaped at '
    + 'render.',
  crm_sendas_aliases:
    'Admin-only INSERT (0074). Which Gmail alias a rep may send as; the alias '
    + 'itself is verified by Google, not by us.',
  crm_locality_geocode_cache:
    'admin/sales INSERT (0106). A geocode cache — worst case is a wrong '
    + 'suburb label.',

  // ── Bounded by something other than a trigger ──────────────────────────
  patient_invitations:
    'is_practice_biller(practice_id). A biller can already create invitations '
    + 'through the UI; the token is generated server-side on the service-role '
    + 'path and the invite is single-use.',
  practice_invitations:
    'admin/sales INSERT (0068). Consumed by accept_practice_invitation, which '
    + 'has carried its own ownership check since 0127.',
  till_device_registration_codes:
    'is_practice_manager(practice_id). An 8-digit code in a global keyspace, '
    + 'rate-limited on redemption by the till_registration bucket (0124/0134).',
  push_subscriptions:
    'patient_id = auth.uid(), and the route refuses an endpoint owned by '
    + 'another account (F-12). REVIEW: the endpoint value itself is '
    + 'unvalidated — that is R3-03 (SSRF), fixed at the route, not here.',
  payment_methods:
    'patient_id = auth.uid(). REVIEW: every other column is free, including '
    + 'peach_registration_id — the same shape as R3-01, bounded only by the '
    + 'fact that another patient\'s token is not readable through RLS.',
  practice_members:
    'Owner or practice manager. REVIEW: role and the capability flags are '
    + 'unconstrained, so an owner can self-grant provider/manager on a '
    + 'practice they own. Bounded since 0135 (a self-made practice can no '
    + 'longer be approved, so it cannot trade) but still worth pinning.',
};

/**
 * Tables that may NEVER be exempted, whatever a future reviewer decides.
 *
 * The first four are the ledger. If one of them ever loses its BEFORE INSERT
 * trigger, the answer is to put it back, not to write a reason.
 *
 * The last two (0138) are here for the inverse reason, and it is worth
 * spelling out because it is easy to talk yourself out of: identity_signals
 * and fraud_decisions hold no money and no personal data — only peppered
 * hashes. The risk is not that somebody READS them, it is that somebody
 * WRITES them. An attacker who can plant signals onto an innocent account
 * manufactures the link graph that gets that account blocked, which turns
 * this platform's fraud defence into a denial-of-service weapon pointed at
 * its own customers. A future reviewer looking at "it's just hashes" and
 * relaxing the guard is exactly the mistake this entry exists to stop.
 */
const MUST_BE_GUARDED = [
  'plans', 'payments', 'payouts', 'applications',
  'identity_signals', 'fraud_decisions',
] as const;

// ─── The 0125 allow-list ──────────────────────────────────────────────────
//
// 0125 made function EXECUTE default-deny, so a function added after it is
// private on creation and needs an explicit GRANT to be browser-callable.
// That is only an allow-list while somebody is checking the list — this is
// the check. A new GRANT to anon/authenticated fails here until its name and
// its reason are added.

const BROWSER_CALLABLE_FUNCTIONS = new Set([
  // (a) Token-scoped, reachable before there is a session
  'get_invitation_by_token', 'stamp_invitation_viewed',
  'get_checkout_session_by_token', 'stamp_checkout_session_scanned',
  'get_practice_invitation_by_token',
  // (b) Self-scoped: each derives the patient from auth.uid() internally
  'set_default_card_flag', 'archive_card', 'crm_accounts_billing_summary',
  // (c) RLS policy predicates — revoking these breaks every read
  'is_platform_admin', 'is_practice_member', 'is_practice_admin',
  'is_practice_manager', 'is_practice_biller', 'is_brand_admin',
  'is_brand_admin_of_practice', 'is_own_active_membership',
  'practice_can_trade',
  // (d) Called from an invoker-rights trigger
  'crm_normalise_address_text',
  // Added by 0129: the single definition of CRM lead visibility, used inside
  // every crm_* child policy, so it must stay executable by the querying role.
  'crm_can_see_lead',
]);

// ─────────────────────────────────────────────────────────────────────────

describe('schema invariants — the parse itself', () => {
  it('accounts for every policy and trigger statement in every migration', () => {
    // Hard failure rather than a warning: every assertion below is only as
    // good as this parse, and the dangerous direction is a policy the parser
    // silently did not see.
    expect(() => assertFullyParsed()).not.toThrow();
  });

  it('produces a non-trivial schema (a parser that matched nothing would pass everything)', () => {
    expect(schema.policies.size).toBeGreaterThan(100);
    expect(schema.triggers.size).toBeGreaterThan(20);
  });
});

describe('INVARIANT — a user-insertable table has a write guard', () => {
  const insertable = tablesWithUserInsert(schema);

  it('every table a user session can INSERT into is guarded or exempted', () => {
    const unaccounted: string[] = [];
    for (const [table, policies] of insertable) {
      if (hasBeforeInsertTrigger(schema, table)) continue;
      if (table in INSERT_GUARD_EXEMPT) continue;
      unaccounted.push(`${table} (via ${policies.map((p) => p.name).join(', ')})`);
    }

    expect(
      unaccounted,
      'These tables accept an INSERT from a user session and nothing checks '
      + 'what the row contains. That is the exact shape of F-01, F-05, A-17, '
      + 'R3-01 and R3-02. Add a BEFORE INSERT trigger, drop the policy, or '
      + 'add the table to INSERT_GUARD_EXEMPT with a reason.',
    ).toEqual([]);
  });

  it.each(MUST_BE_GUARDED)('%s has a BEFORE INSERT trigger and is not exempt', (table) => {
    expect(hasBeforeInsertTrigger(schema, table)).toBe(true);
    expect(INSERT_GUARD_EXEMPT).not.toHaveProperty(table);
  });

  it('the exemption list has no stale entries', () => {
    // An exemption for a table that is now guarded, or that no longer accepts
    // a user INSERT at all, is a reason nobody has re-read. 0135 produced two
    // of these by dropping the policies outright.
    const stale = Object.keys(INSERT_GUARD_EXEMPT).filter(
      (t) => !insertable.has(t) || hasBeforeInsertTrigger(schema, t),
    );
    expect(
      stale,
      'These tables are exempted but no longer need to be — remove them so '
      + 'the list stays a list of live decisions.',
    ).toEqual([]);
  });

  it('the two round-three holes stay closed', () => {
    // R3-01: payouts had a patient INSERT policy and no trigger.
    expect([...schema.policies.keys()]).not.toContain('payouts patients_insert_payout_on_accept');
    expect(hasBeforeInsertTrigger(schema, 'payouts')).toBe(true);
    // R3-02: practices had an open INSERT policy and an UPDATE-only trigger.
    expect([...schema.policies.keys()]).not.toContain('practices authenticated_insert_practice');
    expect(tablesWithUserInsert(schema).has('practices')).toBe(false);
  });
});

describe('INVARIANT — the repo reproduces production RLS (R3-08)', () => {
  // 0136 reconciled three policies that existed only in the live database.
  // These assertions are what stops the repo drifting back: the two
  // superseded names are the LOOSER ones (is_practice_member rather than
  // is_practice_admin), so their return would be a silent widening.
  const names = new Set(schema.policies.keys());

  it.each([
    'plans practice_admins_select_plans',
    'payments practice_admins_select_payments',
    'payments provider_select_own_payments',
  ])('%s is in the migrations, not only in production', (k) => {
    expect(names.has(k)).toBe(true);
  });

  it.each([
    'plans practice_members_select_plans',
    'payments practice_members_select_payments',
  ])('%s is gone — it is the looser predicate', (k) => {
    expect(names.has(k)).toBe(false);
  });

  it('the practitioner payments predicate uses the 0094 membership model', () => {
    // 0094 moved every provider predicate off `plans.provider_id = auth.uid()`
    // so that a DEACTIVATED membership loses access. It named two policies and
    // there were three; the third was invisible to it because it lived only in
    // production. Asserted on the migration text because the replay models
    // policy names and commands, not their expressions.
    const mig = readMigrations().find((m) => m.version === '0136');
    expect(mig, 'migration 0136 is missing').toBeDefined();
    const body = statementText(mig!.sql);
    const stmt = /CREATE POLICY "provider_select_own_payments"[\s\S]*?;/.exec(body)?.[0] ?? '';
    expect(stmt).toContain('is_own_active_membership');
    expect(stmt).not.toContain('provider_id = auth.uid()');
  });
});

describe('INVARIANT — EXECUTE stays an allow-list after 0125', () => {
  const grants = browserCallableGrants();

  it('every function granted to anon/authenticated since 0125 is on the list', () => {
    const unlisted = grants
      .filter((g) => !BROWSER_CALLABLE_FUNCTIONS.has(g.fn))
      .map((g) => `${g.fn} → ${g.roles.join(', ')} (${g.migration})`);

    expect(
      unlisted,
      '0125 made function EXECUTE default-deny so that a browser-callable '
      + 'function has to be a decision rather than an accident. These grants '
      + 'were added without one. Add the name to BROWSER_CALLABLE_FUNCTIONS '
      + 'with the reason it must be reachable from a browser, and to the '
      + 'allow-list in 0125 if it is not already there.',
    ).toEqual([]);
  });

  it('a quoted grant inside a DO block does not run on into the next statement', () => {
    // The bug 0138 exposed. `EXECUTE 'GRANT EXECUTE ON FUNCTION f() TO
    // service_role';` has no semicolon inside the string, so a name span of
    // `[\s\S]*?` could not stop there and swallowed everything up to the
    // next `TO <roles>;` in the file — attributing THOSE roles to THIS
    // function.
    //
    // The noisy failure (a table grant misreported as a function grant) is
    // the harmless half. The dangerous half is the same run-on hiding a real
    // anon grant behind the wrong function name, so the allow-list would be
    // policing a name nobody granted while the actual grant went unlisted.
    const grants = browserCallableGrants([{
      file: '9999_regression.sql',
      version: '9999',
      sql: [
        'DO $$ BEGIN',
        "  EXECUTE 'GRANT EXECUTE ON FUNCTION quoted_service_only(UUID) TO service_role';",
        'END $$;',
        'GRANT SELECT ON some_table TO authenticated;',
        'GRANT EXECUTE ON FUNCTION genuinely_public(TEXT) TO anon, authenticated;',
      ].join('\n'),
    }]);

    expect(grants.map((g) => g.fn)).toEqual(['genuinely_public']);
    expect(grants[0].roles).toEqual(['anon', 'authenticated']);
  });

  it('the allow-list has no entries nothing grants (so it cannot rot)', () => {
    const granted = new Set(grants.map((g) => g.fn));
    const orphans = [...BROWSER_CALLABLE_FUNCTIONS].filter((f) => !granted.has(f));
    expect(
      orphans,
      'These names are allow-listed but no migration at or after 0125 grants '
      + 'them. Either the grant was removed (drop the name) or it lives in an '
      + 'earlier migration and 0125 revoked it (which means it is already '
      + 'unreachable and the entry is misleading).',
    ).toEqual([]);
  });

  it('the phone-OTP and settlement primitives are NOT browser-callable', () => {
    // A-01 and A-11 in one assertion: these are the functions whose whole
    // fix was that a browser can no longer reach them.
    for (const fn of [
      'prepare_phone_verification', 'verify_phone_otp',
      'prepare_phone_verification_for_user', 'verify_phone_otp_for_user',
      'consume_rate_limit', 'next_invoice_number', 'refresh_card_token',
      'claim_plan_for_settlement', 'claim_credit_for_plan',
      'expire_stale_checkout_session', 'change_default_card',
      'accept_practice_invitation', 'find_auth_user_by_email',
    ]) {
      expect(BROWSER_CALLABLE_FUNCTIONS.has(fn), `${fn} must not be browser-callable`).toBe(false);
      expect(grants.some((g) => g.fn === fn), `${fn} is granted to a browser role`).toBe(false);
    }
  });
});
