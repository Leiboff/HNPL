import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Every privileged admin action is in the record (A-12) ─────────────────
//
// Migration 0048 built admin_audit_log with an unforgeable INSERT policy, and
// then two actions were wired into it: addNote and changePracticeFeePercent.
// Everything that actually moves money or grants access wrote nothing:
//
//   • marking a payout batch paid — the human assertion that an EFT left
//   • marking an unbatched payout paid
//   • retrying a collection — a real card charge
//   • granting or revoking 'sales' — read access to the entire CRM
//   • granting or revoking brand-admin on a group
//   • changing a practice's, a branch's or a group's banking details
//
// The database half of the fix is proved against real Postgres in
// supabase/migrations/0131_admin_audit_coverage.rls.test.ts — the triggers,
// the redaction, the nullable actor, the RLS that still cannot be forged.
//
// This file is the OTHER half: that every action which has an authenticated
// caller records who they were, and does it before the state change rather
// than after. That cannot be asserted from the database, because the whole
// property is about code paths that could simply not call it.
//
// ─── WHY BOTH HALVES ───────────────────────────────────────────────────────
//
// They fail in opposite directions. A trigger cannot be forgotten but cannot
// name an actor on a service-role connection (auth.uid() is NULL there, and
// every action in this file that needs the 0054 column locks bypassed runs on
// exactly that connection). A call-site insert names the actor but can be
// forgotten by the next code path. Together, an unattributed row with no
// attributed twin means a write arrived from somewhere nobody wired up —
// which is a finding, and is what /admin/audit's "Unattributed" chip is for.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const HELPER      = read('app/admin/_lib/adminAudit.ts');
// The helper's reasoning is the deliverable as much as its code — a future
// caller reading it is how the actor-id rule survives. Read raw for the
// assertions about what it SAYS.
const HELPER_RAW  = readFileSync(resolve(ROOT, 'app/admin/_lib/adminAudit.ts'), 'utf8');
const PAYOUTS     = read('app/admin/payouts/actions.ts');
const COLLECTIONS = read('app/admin/collections/actions.ts');
const SALES       = read('app/admin/sales-team/actions.ts');
const GROUPS      = read('app/admin/groups/actions.ts');
const BRAND       = read('app/brand/actions.ts');
const AUDIT_PAGE  = read('app/admin/audit/page.tsx');
const NOTES       = read('app/admin/_components/AdminNotes.tsx');
// The nav link list moved out of AdminNav.tsx when the phone nav became a
// hamburger: both surfaces (the desktop sidebar and AdminMobileMenu) now
// render this one source, so this is where "is it in the nav" is answered —
// and answering it here covers BOTH widths rather than only desktop.
const NAV         = read('app/admin/adminNavLinks.ts');

/** Position of a needle, asserted present so an ordering test cannot pass on -1. */
function at(src: string, needle: string): number {
  const i = src.indexOf(needle);
  expect(i, `expected to find ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe('the helper', () => {
  it('never lets an audit failure fail the action it describes', () => {
    // A logging outage that blocks settlement is not a safer system: an admin
    // who cannot mark a batch paid will mark it paid another way, and that
    // one is definitely not logged. Loud console, no throw, no return value
    // the caller has to handle.
    expect(HELPER).toMatch(/export async function recordAdminAction\([\s\S]*?\): Promise<void>/);
    expect(HELPER).toMatch(/try \{[\s\S]*?\} catch \(err\) \{/);
    expect(HELPER).toMatch(/\[admin-audit\] ALERT failed to record a privileged action/);
    expect(HELPER).toMatch(/\[admin-audit\] ALERT threw while recording a privileged action/);
  });

  it('takes an already-authorized actor id, never a session or a request field', () => {
    // The signature IS the rule: there is nowhere to pass a user id that has
    // not been through the calling action's guard.
    expect(HELPER).toMatch(/actorId:\s+string;/);
    expect(HELPER_RAW).toMatch(/Never pass one from a request body/);
    // No session or client parameter to be tempted by, either — the caller
    // cannot hand this a client whose identity it has not already checked.
    expect(HELPER).not.toMatch(/supabase[?:]/);
  });

  it('offers an attempt/outcome pair for actions that can fail halfway', () => {
    // A card retry that dies mid-flight is precisely the event an
    // investigator needs, and a log written only on success would omit it.
    expect(HELPER).toMatch(/export async function recordAdminAttempt/);
    expect(HELPER).toMatch(/action: `\$\{entry\.action\}_result`/);
  });

  it('its entity types match the migration\'s CHECK constraint', () => {
    const MIG = readFileSync(
      resolve(ROOT, 'supabase/migrations/0131_admin_audit_coverage.sql'), 'utf8',
    );
    for (const t of ['practice', 'customer', 'practice_group', 'payout', 'payout_batch', 'payment']) {
      expect(HELPER).toContain(`'${t}'`);
      expect(MIG).toContain(`'${t}'`);
    }
  });
});

describe('settlement — the assertion that money left the bank', () => {
  it('markBatchPaid records the batch BEFORE flipping anything', () => {
    // It makes two writes (members, then the batch) and can die between
    // them. A record written after success would be missing exactly the
    // half-finished settlements worth investigating.
    const record = at(PAYOUTS, "action:     'mark_batch_paid'");
    const flip   = at(PAYOUTS, "update({ status: 'paid', paid_at: paidAt })");
    expect(record).toBeLessThan(flip);
    expect(PAYOUTS).toMatch(/entityType: 'payout_batch'/);
  });

  it('markPayoutPaid records the single payout before flipping it', () => {
    const record = at(PAYOUTS, "action:     'mark_payout_paid'");
    const flip   = PAYOUTS.indexOf(".from('payouts')", record);
    expect(flip).toBeGreaterThan(record);
    expect(PAYOUTS).toMatch(/entityType: 'payout'/);
  });

  it('both take the actor from the guard, which resolves it from the session', () => {
    expect(PAYOUTS).toMatch(/return \{ ok: true as const, error: null, supabase, userId: user\.id \}/);
    expect((PAYOUTS.match(/actorId:\s+guard\.userId!/g) ?? []).length).toBe(2);
    // And the guard's failure paths carry a null id, so a refused call cannot
    // accidentally attribute anything.
    expect((PAYOUTS.match(/userId: null/g) ?? []).length).toBe(2);
  });
});

describe('a card retry — the one action no trigger can catch', () => {
  it('records the attempt before the charge and the outcome after it', () => {
    const attempt = at(COLLECTIONS, "action:     'retry_collection'");
    const charge  = at(COLLECTIONS, 'await attemptChargeInstalment(svc, paymentId)');
    const outcome = at(COLLECTIONS, 'await finish(');
    expect(attempt).toBeLessThan(charge);
    expect(charge).toBeLessThan(outcome);
  });

  it('records all three outcomes, transport error included', () => {
    // The transport-error case is the one that strands the row in
    // 'processing' (see A-13), so it is the outcome most worth having.
    expect(COLLECTIONS).toMatch(/kind: 'charged', attempt: result\.attemptNumber/);
    expect(COLLECTIONS).toMatch(/kind: 'transport_error', error: result\.error/);
    expect(COLLECTIONS).toMatch(/kind: 'claim_lost', reason: result\.reason/);
  });

  it('is filed against the payment, so it lands on that collection', () => {
    expect(COLLECTIONS).toMatch(/entityType: 'payment'/);
    expect(COLLECTIONS).toMatch(/entityId:\s+paymentId/);
  });
});

describe('role grants — CRM-wide read access', () => {
  it('grantSalesRole records who granted it, before the write', () => {
    // The write is service-role (the 0054 column lock demands it), so
    // 0131's trigger sees auth.uid() = NULL and cannot name anybody. This
    // insert is the only place the attribution can come from.
    const record = at(SALES, "action:     'grant_sales_role'");
    const write  = SALES.indexOf("update({ role: 'sales' })", record);
    expect(write).toBeGreaterThan(record);
    expect(SALES).toMatch(/actorId:\s+guard\.userId/);
    expect(SALES).toMatch(/payload:\s+\{ from: profile\.role, to: 'sales', email: cleanEmail \}/);
  });

  it('revokeSalesRole records the revoke too', () => {
    const record = at(SALES, "action:     'revoke_sales_role'");
    const write  = SALES.indexOf("update({ role: 'patient' })", record);
    expect(write).toBeGreaterThan(record);
  });

  it('brand-admin grants and revokes are recorded', () => {
    // A brand admin can edit their branches' banking, so this is an access
    // grant with a money consequence. No trigger covers it: a membership row
    // APPEARING is not a column changing on an existing one.
    expect(GROUPS).toMatch(/action:\s+'grant_brand_admin'/);
    expect(GROUPS).toMatch(/action:\s+'revoke_brand_admin'/);
    for (const action of ['grant_brand_admin', 'revoke_brand_admin']) {
      const record = at(GROUPS, `action:     '${action}'`);
      const write  = GROUPS.indexOf(".from('practice_group_members')", record);
      expect(write).toBeGreaterThan(record);
    }
  });
});

describe('banking — where the money goes', () => {
  it('a branch banking change records the brand admin who made it', () => {
    // The scenario A-12 describes: change the account, wait for the Friday
    // EFT, change it back. This is the most commonly-walked path to it, and
    // it is a BRAND admin rather than a platform admin — which is why the
    // helper takes an actor id instead of relying on the log's own RLS
    // policy, whose is_platform_admin() would refuse this insert.
    const record = at(BRAND, "action:     'branch_banking_changed'");
    const write  = BRAND.indexOf(".from('practices')", record);
    expect(write).toBeGreaterThan(record);
    expect(BRAND).toMatch(/by_role:\s+'brand_admin'/);
  });

  it('the group-level fallback account is recorded too', () => {
    // Every branch with no banking of its own settles here, so one edit can
    // redirect a whole brand's money.
    const record = at(GROUPS, "action:     'group_banking_changed'");
    const write  = GROUPS.indexOf(".from('practice_groups')", record);
    expect(write).toBeGreaterThan(record);
  });

  it('NO call site writes an account number into the log', () => {
    // admin_audit_log is append-only and readable by every platform admin,
    // so anything put in it is there forever. The trigger's last-4 plus
    // SHA-256 is what makes a round trip provable without keeping the number.
    // Specifically: no payload PROPERTY is assigned the number. Mentioning
    // the variable in a boolean (`cleared: input.bankAccountNumber === null`)
    // is fine and is what these payloads do — it records that banking was
    // cleared without recording what it was.
    for (const src of [BRAND, GROUPS, PAYOUTS, SALES, COLLECTIONS]) {
      const inserts = src.match(/recordAdminAction\(\{[\s\S]*?\}\);/g) ?? [];
      for (const insert of inserts) {
        expect(insert).not.toMatch(/:\s*(input\.)?bankAccountNumber\s*[,}]/);
        expect(insert).not.toMatch(/:\s*(NEW\.|OLD\.)?bank_account_number\s*[,}]/);
      }
    }
    // And the same property, stated once about the SQL: the trigger payload
    // builder reduces the number rather than passing it through.
    const MIG = readFileSync(
      resolve(ROOT, 'supabase/migrations/0131_admin_audit_coverage.sql'), 'utf8',
    );
    expect(MIG).toMatch(/'account_last4',\s+CASE WHEN old_account IS NULL/);
    expect(MIG).toMatch(/encode\(sha256\(old_account::bytea\), 'hex'\)/);
    expect(MIG).not.toMatch(/'account_number',/);
  });

  it('and moving a branch between brands is recorded — it moves the fallback', () => {
    expect(GROUPS).toMatch(/action:\s+'practice_reassigned_to_group'/);
  });
});

describe('the log is surfaced, or it is not a control', () => {
  it('there is a page for the whole stream and it is in the nav', () => {
    expect(NAV).toMatch(/href: '\/admin\/audit'/);
    expect(AUDIT_PAGE).toMatch(/const PAGE_SIZE = 100/);
    expect(AUDIT_PAGE).toMatch(/\.order\('created_at', \{ ascending: false \}\)/);
  });

  it('it reads through the SESSION client so RLS gates it', () => {
    // Never service-role. A demoted account must lose the log with its role,
    // and 0048's SELECT policy is what enforces that — a service-role read
    // here would quietly bypass it.
    expect(AUDIT_PAGE).not.toMatch(/createServiceClient|SUPABASE_SERVICE_ROLE_KEY/);
    expect(AUDIT_PAGE).toMatch(/supabase\s*\n?\s*\.from\('admin_audit_log'\)/);
  });

  it('it can isolate the rows that mean somebody was not identified', () => {
    // An unattributed row with no attributed twin is a write from a path
    // nobody wired a call site into. That is the finding this page exists to
    // make findable.
    expect(AUDIT_PAGE).toMatch(/chip === 'unattributed'/);
    expect(AUDIT_PAGE).toMatch(/\.is\('actor_id', null\)/);
  });

  it('an unattributed row is never labelled as the system doing it', () => {
    // "by the system" closes a question that should stay open. Nothing here
    // is done by a system; it is done by a person whose connection did not
    // carry their identity.
    expect(AUDIT_PAGE).toMatch(/unattributed — no session identity on the write/);
    expect(AUDIT_PAGE).not.toMatch(/by the system|System/);
    expect(NOTES).toMatch(/row\.actor_id \? fullName\(row\.actor\) : 'an unattributed write'/);
  });

  it('the per-entity timeline renders the new actions, and still falls back', () => {
    // The fallback is load-bearing: 0131 made the database a primary writer,
    // so actions can appear that no TypeScript here names.
    expect(NOTES).toMatch(/row\.action === 'banking_changed'/);
    expect(NOTES).toMatch(/row\.action === 'role_changed'/);
    expect(NOTES).toMatch(/JSON\.stringify\(row\.payload, null, 2\)/);
  });

  it('the timeline does not render an account number either', () => {
    expect(NOTES).toMatch(/account_last4/);
    expect(NOTES).not.toMatch(/account_number/);
  });
});
