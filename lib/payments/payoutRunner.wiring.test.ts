import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Payout runner wiring + the provider-destination removal ────────────
//
// Source-level pins for the things that aren't behaviour you can call:
// the cron's schedule and auth posture, the batch-first settlement surface,
// and the fact that four write sites no longer offer a per-provider payout
// destination. Behaviour itself is covered by payoutWindow.test.ts and
// runPayoutBatches.pglite.test.ts.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/** Comments legitimately DISCUSS what was removed; code must not contain it. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const CRON       = read('app/api/cron/payout-batches/route.ts');
const COLLECT    = read('app/api/cron/collect-instalments/route.ts');
const VERCEL     = read('vercel.json');
const RUNNER     = read('lib/payments/runPayoutBatches.ts');
const ACTIONS    = read('app/admin/payouts/actions.ts');
const PAGE       = read('app/admin/payouts/page.tsx');
const ACTIVATE   = read('lib/payments/activateFirstInstalment.ts');
const MEMBERS_VW = read('app/practice/members/MembersView.tsx');
const MEMBERS_AC = read('app/practice/members/actions.ts');
const ADD_FORM   = read('app/practice/members/AddMemberForm.tsx');
const INVITE     = read('lib/brand/inviteMember.ts');
const PROVIDER   = read('app/provider/profile/page.tsx');
const ADMIN_PRAC = read('app/admin/practices/[id]/page.tsx');
const DIR_TEST   = read('app/patient/explore/practitioners-directory.test.ts');

describe('the cron runs on Friday morning SAST', () => {
  it('vercel.json schedules it Fridays at 04:00 UTC = 06:00 SAST', () => {
    const cfg = JSON.parse(VERCEL) as { crons: Array<{ path: string; schedule: string }> };
    const job = cfg.crons.find((c) => c.path === '/api/cron/payout-batches');
    expect(job).toBeTruthy();
    // Vercel cron schedules are UTC. `5` is Friday.
    expect(job!.schedule).toBe('0 4 * * 5');
  });

  it('does not disturb the existing crons', () => {
    const cfg = JSON.parse(VERCEL) as { crons: Array<{ path: string; schedule: string }> };
    const byPath = new Map(cfg.crons.map((c) => [c.path, c.schedule]));
    expect(byPath.get('/api/cron/collect-instalments')).toBe('0 11 * * *');
    expect(byPath.get('/api/cron/crm-reply-poll')).toBe('0 6 * * *');
  });

  it('the window rule is documented against the collection cron it must not align with', () => {
    // 11:00 UTC = 13:00 SAST. A cut-off there would strand Wednesday
    // afternoon activations into the following week. (Both files wrap the
    // phrase across comment lines, hence the tolerant match.)
    expect(COLLECT).toMatch(/11:00 UTC =\s*(\/\/\s*)?13:00 SAST/);
    expect(read('lib/payments/payoutWindow.ts')).toMatch(/11:00 UTC = 13:00 SAST/);
  });
});

describe('the cron matches the established route pattern', () => {
  it('requires CRON_SECRET with a constant-time compare', () => {
    expect(CRON).toMatch(/const REQUIRE_CRON_SECRET = true/);
    expect(CRON).toMatch(/crypto\.timingSafeEqual/);
    expect(CRON).toMatch(/receivedBuf\.length === expectedBuf\.length/);
    expect(CRON).toMatch(/status: 401/);
  });

  it('refuses to run when the secret is not configured', () => {
    expect(CRON).toMatch(/CRON_SECRET is not set — refusing to run/);
    expect(CRON).toMatch(/status: 500/);
  });

  it('is force-dynamic and answers both GET and POST', () => {
    expect(CRON).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(CRON).toMatch(/export async function GET/);
    expect(CRON).toMatch(/export async function POST/);
  });

  it('records every run in cron_runs under a stable job_name', () => {
    expect(CRON).toMatch(/from\('cron_runs'\)/);
    expect(CRON).toMatch(/job_name:\s*'payout-batches'/);
    expect(CRON).toMatch(/started_at/);
    expect(CRON).toMatch(/finished_at/);
  });

  it('supports ?weekEnding= backfill and rejects a bad window with 400, not 500', () => {
    expect(CRON).toMatch(/searchParams\.get\('weekEnding'\)/);
    expect(CRON).toMatch(/not a Thursday/);
    expect(CRON).toMatch(/isBadWindow \? 400 : 500/);
  });
});

describe('the runner does not become a second writer of payouts', () => {
  it('never inserts or upserts into payouts', () => {
    const code = codeOf(RUNNER);
    expect(code).not.toMatch(/from\('payouts'\)[\s\S]{0,120}\.insert\(/);
    expect(code).not.toMatch(/from\('payouts'\)[\s\S]{0,120}\.upsert\(/);
  });

  it('only ever sets batch_id on payouts', () => {
    const updates = [...codeOf(RUNNER).matchAll(/\.update\((\{[^}]*\})\)/g)].map((m) => m[1]);
    const payoutUpdates = updates.filter((u) => u.includes('batch_id'));
    expect(payoutUpdates.length).toBeGreaterThan(0);
    for (const u of payoutUpdates) {
      expect(u).not.toMatch(/status/);
      expect(u).not.toMatch(/net_amount|fee_amount|gross_amount/);
      expect(u).not.toMatch(/paid_at/);
    }
  });

  it('claims only PENDING rows, and only unbatched ones', () => {
    expect(RUNNER).toMatch(/\.is\('batch_id', null\)/);
    expect(RUNNER).toMatch(/\.eq\('status', 'pending'\)/);
  });

  it('sums stored net_amount rather than recomputing a fee', () => {
    const code = codeOf(RUNNER);
    expect(code).toMatch(/net_amount/);
    expect(code).not.toMatch(/calculateFee|fee_percent/);
  });

  it('reports orphans and stranded rows instead of silently absorbing them', () => {
    expect(RUNNER).toMatch(/orphan_active_plans/);
    expect(RUNNER).toMatch(/stranded_payouts/);
  });
});

describe('settlement is batch-first', () => {
  // Anchor on the DECLARATIONS, not the first mention: the file's header
  // comment names both functions, so indexOf('markBatchPaid') would slice
  // from the prose and produce an empty or wrong body window.
  const declIdx = (name: string) => {
    const i = ACTIONS.indexOf(`export async function ${name}`);
    expect(i).toBeGreaterThan(0);
    return i;
  };
  const batchBody  = () => ACTIONS.slice(declIdx('markBatchPaid'), declIdx('markPayoutPaid'));
  const payoutBody = () => ACTIONS.slice(declIdx('markPayoutPaid'));

  it('markBatchPaid flips the member payouts BEFORE the batch', () => {
    // Dying between the two must leave a pending batch a retry can finish,
    // not a paid batch full of pending payouts.
    const payoutsIdx = ACTIONS.indexOf("from('payouts')");
    const batchIdx   = ACTIONS.indexOf("from('payout_batches')\n    .update({ status: 'paid'");
    expect(ACTIONS).toMatch(/export async function markBatchPaid/);
    expect(payoutsIdx).toBeGreaterThan(0);
    expect(batchIdx).toBeGreaterThan(payoutsIdx);
  });

  it('both writes are conditional on pending, so a double-click cannot double-flip', () => {
    // Two guarded writes plus the guarded read = at least three.
    expect((batchBody().match(/\.eq\('status', 'pending'\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('markPayoutPaid REFUSES a payout that belongs to a batch', () => {
    const body = payoutBody();
    expect(body).toMatch(/if \(payout\.batch_id\)/);
    expect(body).toMatch(/settle the batch instead/);
    // And re-asserts it at write time, since the read is a separate statement.
    expect(body).toMatch(/\.is\('batch_id', null\)/);
  });

  it('still requires platform-admin for both actions', () => {
    expect(ACTIONS).toMatch(/async function guardAdmin/);
    expect(batchBody()).toMatch(/await guardAdmin\(\)/);
    expect(payoutBody()).toMatch(/await guardAdmin\(\)/);
  });

  it('the admin page settles batches and shows the window each covers', () => {
    expect(PAGE).toMatch(/markBatchPaid/);
    expect(PAGE).toMatch(/Mark batch paid/);
    expect(PAGE).toMatch(/Covers \(SAST\)/);
    expect(PAGE).toMatch(/function windowLabel/);
    // Never show the exclusive Thursday to a human.
    expect(PAGE).toMatch(/window_end\)\.getTime\(\) - 24 \* 60 \* 60 \* 1000/);
  });

  it('per-row Mark paid is offered ONLY for unbatched payouts', () => {
    expect(PAGE).toMatch(/const unbatched = payouts\.filter\(p => p\.status === 'pending' && !p\.batch_id\)/);
    const unbatchedSection = PAGE.slice(PAGE.indexOf('Not yet batched'));
    expect(unbatchedSection).toMatch(/action=\{markPayoutPaid\}/);
  });
});

// ─── Part C: the provider payout destination is gone ────────────────────

describe('provider payout destination — removed from every write site', () => {
  it('activateFirstInstalment always writes practice, with no branch', () => {
    const code = codeOf(ACTIVATE);
    expect(code).toMatch(/payout_destination:\s*'practice'/);
    expect(code).not.toMatch(/'provider'/);
    expect(code).not.toMatch(/snapshot_/);
    expect(code).not.toMatch(/personal_/);
  });

  it('MembersView no longer collects or submits a destination', () => {
    const code = codeOf(MEMBERS_VW);
    expect(code).not.toMatch(/payout_destination:\s*(opt|editDraft)/);
    expect(code).not.toMatch(/patchDraft\(\{ payout_destination/);
    expect(code).not.toMatch(/personal_bank_name:\s*editDraft/);
    // And says plainly where the money goes instead.
    expect(MEMBERS_VW).toMatch(/member-payout-destination-note/);
    expect(MEMBERS_VW).toMatch(/practice&apos;s bank account/);
  });

  it("MembersUpdates / NewMemberInput can no longer carry banking", () => {
    const code = codeOf(MEMBERS_AC);
    expect(code).not.toMatch(/payout_destination\?/);
    expect(code).not.toMatch(/personal_bank_name\?/);
    expect(code).not.toMatch(/payoutDestination/);
    expect(code).not.toMatch(/personalAccountNumber/);
  });

  it('AddMemberForm has no payout sub-form and no gating prop', () => {
    const code = codeOf(ADD_FORM);
    expect(code).not.toMatch(/showPayoutFields/);
    expect(code).not.toMatch(/payoutDestination/);
    expect(code).not.toMatch(/personalBranchCode/);
  });

  it('inviteMemberIntoPractice hardcodes practice and takes no banking input', () => {
    const code = codeOf(INVITE);
    expect(code).toMatch(/payout_destination:\s*'practice'/);
    expect(code).not.toMatch(/input\.payoutDestination/);
    expect(code).not.toMatch(/personalAccountHolder/);
  });
});

describe('provider payout destination — the doctor-facing surface', () => {
  it('no longer reads the destination or the personal account number', () => {
    const code = codeOf(PROVIDER);
    expect(code).not.toMatch(/payout_destination/);
    expect(code).not.toMatch(/personal_account_number/);
    expect(code).not.toMatch(/payoutLabel/);
  });

  it('REPLACES the card with copy rather than silently deleting it', () => {
    // A doctor who used to see "Your personal account (•••• 1234)" here would
    // otherwise be left wondering where the setting went.
    expect(PROVIDER).toMatch(/How you get paid/);
    expect(PROVIDER).toMatch(/provider-payout-destination/);
    expect(PROVIDER).toMatch(/Into your practice&apos;s bank account/);
    // Explains the weekly rhythm and who to ask.
    expect(PROVIDER).toMatch(/once a week/);
    expect(PROVIDER).toMatch(/practice admin/);
  });

  it('the admin practice page no longer selects the unused column', () => {
    const code = codeOf(ADMIN_PRAC);
    expect(code).not.toMatch(/payout_destination/);
  });

  it("the doctor's dashboard names the RECIPIENT of the money it shows", () => {
    // A third display site, beyond the two the brief listed. /provider showed
    // "Total paid out" / "Pending payout" from payouts where provider_id = me
    // — which now always land in the PRACTICE's account. The old labels read
    // as money paid to the doctor.
    const DASH = read('app/provider/page.tsx');
    expect(DASH).toMatch(/Paid to your practice/);
    expect(DASH).toMatch(/Owed to your practice/);
    expect(DASH).not.toMatch(/'Total paid out'/);
    expect(DASH).not.toMatch(/'Pending payout'/);
    expect(DASH).toMatch(/provider-payout-recipient-note/);
    // Copy only — the figures still come from the same untouched query.
    expect(DASH).toMatch(/\.eq\('provider_id', user\.id\)/);
    expect(DASH).toMatch(/p\.status === 'paid' \? sum \+ Number\(p\.net_amount\)/);
  });
});

describe('⚠️ the patient-facing leak guard OUTLIVES the feature', () => {
  it('the forbidden-column pins are still present', () => {
    // The columns REMAIN in the database (historical payouts snapshotted
    // them), so the practitioners-directory view must still be checked
    // against exposing them — even though nothing writes them any more.
    for (const col of [
      'payout_destination',
      'personal_bank_name',
      'personal_account_holder',
      'personal_account_number',
      'personal_branch_code',
      'personal_account_type',
    ]) {
      expect(DIR_TEST).toContain(`'${col}'`);
    }
  });

  it('and now carry an explanation of why they outlive it', () => {
    // Without this, a tidy-up PR deletes them as dead weight and silently
    // stops guarding a SECURITY DEFINER view against real bank details.
    expect(DIR_TEST).toMatch(/OUTLIVE THE FEATURE/i);
    expect(DIR_TEST).toMatch(/DO NOT REMOVE/i);
    expect(DIR_TEST).toMatch(/COLUMNS THEMSELVES DELIBERATELY REMAIN/i);
    expect(DIR_TEST).toMatch(/RLS is row-level, not column-level/i);
    // States the correct trigger for removal.
    expect(DIR_TEST).toMatch(/COLUMN being dropped/i);
  });
});

describe('nothing was dropped from the schema', () => {
  const MIG = read('supabase/migrations/0090_payout_batches.sql');
  /** SQL statements only — the migration's prose discusses 0087 by name. */
  const sql = MIG.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('0090 adds only — no DROP COLUMN, no DROP CONSTRAINT, no DROP TABLE', () => {
    expect(sql).not.toMatch(/DROP\s+COLUMN/i);
    expect(sql).not.toMatch(/DROP\s+CONSTRAINT/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    // DROP POLICY IF EXISTS before CREATE POLICY is the repo's idempotent
    // pattern and is not a schema removal.
  });

  it('does not touch payouts.plan_id UNIQUE (0087 stands)', () => {
    expect(sql).not.toMatch(/plan_id/i);
    expect(read('supabase/migrations/0087_payouts_plan_id_unique.sql')).toMatch(/unique/i);
  });

  it('enforces both idempotency guarantees at the DB level', () => {
    expect(MIG).toMatch(/UNIQUE \(practice_id, window_start\)/);
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES payout_batches\(id\)/);
  });

  it('gives practices and brand-admins read access but no write path', () => {
    expect(MIG).toMatch(/is_practice_member\(practice_id\)/);
    expect(MIG).toMatch(/is_brand_admin_of_practice\(practice_id\)/);
    // Only the platform admin gets FOR ALL; practice-side is SELECT only.
    expect(MIG).toMatch(/CREATE POLICY "admins_all_payout_batches"[\s\S]{0,120}FOR ALL/);
    expect(MIG).toMatch(/CREATE POLICY "practice_members_select_payout_batches"[\s\S]{0,120}FOR SELECT/);
  });
});
