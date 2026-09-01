import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The pieces the sweep depends on, in the code around it (A-13) ─────────
//
// sweepStuckProcessing's own behaviour is proved against real Postgres in
// sweepStuckProcessing.pglite.test.ts. This file pins the four things that
// live OUTSIDE it and that the whole fix silently stops working without:
//
//   1. provider_attempted_at is stamped BEFORE the provider call, at every
//      site that makes one. Stamped after, every in-flight charge would look
//      never-sent and the sweep would revert claims Peach was collecting.
//   2. The settle-entire-bill transport error marks and alerts rather than
//      returning in silence — the original defect was not the frozen row, it
//      was that nothing anywhere knew about it.
//   3. The sweep actually runs, daily, and its counts reach cron_runs.
//   4. The rows it deliberately does not touch are put in front of a human,
//      and the patient is not told to "try again" on a payment that may
//      already have gone through.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const CHARGE   = read('lib/payments/chargeInstalment.ts');
const SETTLE   = read('app/patient/orders/settle-actions.ts');
const CRON     = read('app/api/cron/collect-instalments/route.ts');
const SWEEP    = read('lib/payments/sweepStuckProcessing.ts');
const WEBHOOK  = read('app/api/payments/peach/webhook/route.ts');
const ADMIN    = read('app/admin/collections/page.tsx');
const SETTLE_BTN = read('app/patient/orders/SettleEntireBillButton.tsx');
const PAY_BTN    = read('app/patient/orders/PayNowButton.tsx');
const MIG      = readFileSync(
  resolve(ROOT, 'supabase/migrations/0132_processing_claim_provenance.sql'), 'utf8',
);

function at(src: string, needle: string): number {
  const i = src.indexOf(needle);
  expect(i, `expected to find ${needle}`).toBeGreaterThan(-1);
  return i;
}

describe('the stamp is written before the call, never after', () => {
  it('chargeInstalment stamps, then charges', () => {
    // The ordering IS the safety property. After the call, a process that
    // died mid-flight would leave provider_attempted_at NULL on a charge
    // Peach had already accepted — and the sweep reads exactly that column
    // to decide it may revert.
    const stamp  = at(CHARGE, 'provider_attempted_at: new Date().toISOString()');
    const charge = at(CHARGE, 'await provider.chargeSavedCard({');
    expect(stamp).toBeLessThan(charge);
  });

  it('selfSettleEntirePlan stamps, then charges', () => {
    const stamp  = at(SETTLE, 'provider_attempted_at: new Date().toISOString()');
    const charge = at(SETTLE, 'await provider.chargeSavedCard({');
    expect(stamp).toBeLessThan(charge);
  });

  it('a failed stamp does not stop the charge', () => {
    // It fails to the conservative side on its own (the sweep then treats
    // the row as never-sent, which is the wrong side) — so it is logged
    // loudly rather than thrown, because refusing to collect money over a
    // bookkeeping write is worse than either.
    expect(CHARGE).toMatch(/\[charge-instalment\] ALERT could not stamp provider_attempted_at/);
    expect(CHARGE).not.toMatch(/if \(stampErr\) return/);
  });

  it('the database maintains the other two facts itself', () => {
    // Not the call sites: "the code path that forgot" is the failure mode
    // this whole finding is about, and there are four claimers.
    expect(MIG).toMatch(/NEW\.processing_since := now\(\)/);
    expect(MIG).toMatch(/NEW\.pre_claim_status := OLD\.status/);
    expect(MIG).toMatch(/CREATE TRIGGER trg_track_payment_processing_claim\s+BEFORE UPDATE ON payments/);
    expect(MIG).toMatch(/CREATE TRIGGER trg_stamp_payment_processing_insert\s+BEFORE INSERT ON payments/);
  });

  it('legacy processing rows are backfilled as MAYBE-sent, not as never-sent', () => {
    // Pessimism on purpose: for a row that predates the migration there is
    // no provenance at all, and "we do not know" must not be read as
    // "nothing was sent". It puts every legacy row in front of a human.
    expect(MIG).toMatch(/SET processing_since\s+= created_at,\s+provider_attempted_at = created_at/);
  });
});

describe('the transport error stops being silent', () => {
  it('still does NOT revert — the row stays claimed', () => {
    // Unchanged and correct. A transport error means the response did not
    // arrive, not that the charge did not happen, and releasing a claim
    // Peach is about to collect double-charges the customer for their whole
    // remaining balance.
    const branch = SETTLE.slice(at(SETTLE, "if (chargeResult.status === 'error')"));
    const guard  = branch.slice(0, branch.indexOf("if (chargeResult.status === 'rejected')"));
    expect(guard).not.toMatch(/failSettlementRow/);
    expect(guard).not.toMatch(/status: 'failed'/);
  });

  it('but marks the row and raises an alert', () => {
    const branch = SETTLE.slice(at(SETTLE, "if (chargeResult.status === 'error')"));
    expect(branch).toMatch(/failure_reason: 'transport_error — awaiting reconciliation'/);
    // The marking write is itself conditional on the row still being
    // claimed, so it cannot resurrect a status somebody else has resolved.
    expect(branch).toMatch(/\.eq\('status', 'processing'\)/);
    expect(branch).toMatch(/\[settle-entire-bill\] ALERT transport error/);
  });

  it('and the patient is told not to pay again', () => {
    // "Please try again in a moment" was the old copy and it is the one
    // thing that must not be said: the charge may have gone through, and in
    // any case the retry cannot work — every instalment is claimed, so the
    // next attempt finds nothing eligible and reports "nothing outstanding",
    // which reads as success.
    for (const src of [SETTLE_BTN, PAY_BTN]) {
      const branch = src.slice(at(src, "case 'transport_error':"));
      expect(branch.slice(0, 900)).toMatch(/Do NOT pay again/);
      expect(branch.slice(0, 900)).not.toMatch(/try again in a moment/);
    }
  });
});

describe('the sweep runs, and its counts are visible', () => {
  it('rides the daily collection cron', () => {
    expect(CRON).toMatch(/import \{ sweepStuckProcessing, type SweepSummary \} from '@\/lib\/payments\/sweepStuckProcessing'/);
    expect(CRON).toMatch(/await sweepStuckProcessing\(svc, \{ now: startedAt \}\)/);
  });

  it('runs AFTER the collection and dunning passes', () => {
    // Its cutoff is hours old so nothing this run claimed is in scope — but
    // ordering makes that a property rather than an arithmetic coincidence.
    const collect = at(CRON, 'await attemptChargeInstalment(');
    const dunning = at(CRON, 'await assessDunningFee(');
    const sweep   = at(CRON, 'await sweepStuckProcessing(');
    expect(sweep).toBeGreaterThan(collect);
    expect(sweep).toBeGreaterThan(dunning);
  });

  it('cannot take the collection run down with it', () => {
    // This job's purpose is collecting money. A reconciliation pass that
    // throws must not stop that.
    const block = CRON.slice(at(CRON, 'let sweep: SweepSummary | null = null;'));
    expect(block.slice(0, 800)).toMatch(/try \{[\s\S]*?\} catch \(err\) \{/);
    expect(CRON).toMatch(/stuck-processing sweep threw \(non-fatal\)/);
  });

  it('reports every count into cron_runs', () => {
    // A sweep that silently stops, or one whose reconciliation queue is
    // growing week on week, has to be visible somewhere other than logs
    // that roll off.
    for (const key of [
      'stuck_scanned', 'stuck_reverted', 'stuck_covered_reverted',
      'stuck_skipped_resumable', 'stuck_needs_reconciliation', 'stuck_unrestorable',
    ]) {
      expect(CRON).toContain(key);
    }
    expect(CRON).toMatch(/job_name:\s+'collect-instalments'/);
  });

  it('alerts when anything is waiting on a human', () => {
    expect(CRON).toMatch(/ALERT payments awaiting manual reconciliation/);
    expect(SWEEP).toMatch(/\[sweep-stuck-processing\] ALERT a charge may be in flight/);
  });
});

describe('what the sweep will not resolve is put in front of someone', () => {
  it('/admin/collections lists the rows awaiting reconciliation', () => {
    expect(ADMIN).toMatch(/\.not\('provider_attempted_at', 'is', null\)/);
    expect(ADMIN).toMatch(/\.eq\('status', 'processing'\)/);
    expect(ADMIN).toMatch(/awaiting reconciliation/);
    // With the reference, because looking it up in the Peach dashboard is
    // the entire action this block exists to prompt.
    expect(ADMIN).toMatch(/row\.peach_payment_id \?\? 'no reference'/);
  });

  it('shares the sweep\'s own staleness window rather than a second one', () => {
    expect(ADMIN).toMatch(/import \{ STUCK_PROCESSING_HOURS \} from '@\/lib\/payments\/sweepStuckProcessing'/);
    expect(ADMIN).not.toMatch(/60 \* 60 \* 1000\s*\*\s*\d/);
  });

  it('is shown on every chip, not hidden behind one', () => {
    // It is not a filter of the collections view — it is the thing that was
    // invisible, and putting it behind a chip nobody clicks leaves it that
    // way. Rendered above the chip row, gated only on being non-empty.
    expect(ADMIN.indexOf('awaiting reconciliation'))
      .toBeLessThan(at(ADMIN, 'CHIP_DEFINITIONS.map((def) => {'));
    expect(ADMIN).toMatch(/\{stuckRows\.length > 0 && \(/);
  });
});

describe('a late webhook after a revert still resolves the right rows', () => {
  it('falls back to the settlement snapshot when the links are gone', () => {
    // The sweep can release a settlement's covered rows, and the webhook
    // can then arrive anyway. Without this the settlement would be marked
    // collected while the instalments it paid for sit unpaid — the customer
    // charged AND still owing, which is the worst outcome available.
    expect(WEBHOOK).toMatch(/if \(\(covered \?\? \[\]\)\.length === 0\) \{/);
    expect(WEBHOOK).toMatch(/const ids = Object\.keys\(snapshot\)/);
    expect(WEBHOOK).toMatch(/covered rows had been released/);
  });

  it('never restamps a row that is already collected', () => {
    const block = WEBHOOK.slice(at(WEBHOOK, 'if ((covered ?? []).length === 0) {'));
    expect(block.slice(0, 700)).toMatch(/\.neq\('status', 'collected'\)/);
  });

  it('and the event it records counts the rescued rows', () => {
    expect(WEBHOOK).toMatch(/covered_count:\s+\(covered\?\.length \?\? 0\) \+ rescuedCount/);
  });
});
