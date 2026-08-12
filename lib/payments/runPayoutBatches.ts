import {
  payoutWindowForRun,
  payoutWindowEndingOn,
  describePayoutWindow,
  type PayoutWindow,
} from './payoutWindow';

// ─── Weekly payout batching ─────────────────────────────────────────────
//
// Groups existing payouts rows into one batch per practice per week, so a
// practice can reconcile a single bank deposit against an exact, bounded set
// of activated plans. See migration 0090 for the table and the two DB-level
// idempotency guarantees; see ./payoutWindow for the boundary rule.
//
// WHAT THIS DOES NOT DO
// ─────────────────────
//   • It does not create payouts rows. activateFirstInstalment remains the
//     only creator (payouts.plan_id UNIQUE, 0087). This is a grouping layer.
//   • It does not compute or re-compute a fee. It SUMS payouts.net_amount,
//     which was calculated from practices.fee_percent at activation time. A
//     commission change must never retroactively move a batch.
//   • It does not move money. Settlement stays a platform-admin action
//     (markBatchPaid) with the EFT happening outside the app.
//   • It does not read any OTHER batch. Closing this week's batch is
//     independent of whether last week's was ever marked paid: candidates are
//     selected from payouts on `batch_id IS NULL`, and an unsettled previous
//     batch has already stamped its rows' batch_id. So an admin who never
//     clicks "Mark batch paid" delays money, but never blocks batching.
//
// IDEMPOTENCY
// ───────────
// Re-running the same window must not double-batch, double-pay, or create a
// duplicate batch row. Three things make that true, and only the third lives
// in this file:
//
//   1. UNIQUE (practice_id, window_start) on payout_batches — a duplicate
//      batch row is rejected by the database.
//   2. payouts.batch_id is a single column — "in two batches" is
//      unrepresentable, not merely forbidden.
//   3. Membership is claimed by a conditional UPDATE with `batch_id IS NULL`
//      in its predicate. Under READ COMMITTED the loser of a concurrent
//      claim re-evaluates that predicate after the winner commits, sees a
//      non-null batch_id, and skips the row. Same atomic-claim pattern
//      ./chargeInstalment.ts uses for payment rows.
//
// Totals are recomputed from ALL rows carrying the batch id — not from the
// rows this invocation happened to claim — so if two invocations split a
// window's rows between them, whichever finishes last still writes the
// correct total.

/**
 * Intentionally loose, for the reason lib/practice/tradingGate.ts documents
 * for its own alias: a structural type for Supabase's deeply-generic
 * PostgREST builder makes TypeScript report "Type instantiation is
 * excessively deep and possibly infinite" at the call sites.
 *
 * MUST be a service-role client. payout_batches has no INSERT/UPDATE policy
 * for anyone (0090) — the runner is trusted infrastructure and a practice
 * must never be able to batch or settle its own money.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PayoutRunnerSupabase = any;

export type BatchResult = {
  practiceId: string;
  batchId:    string;
  /** Rows this invocation claimed. 0 on a re-run — that is success, not a no-op error. */
  claimed:    number;
  /** Total rows in the batch after this invocation, from the DB. */
  planCount:  number;
  totalNet:   number;
};

export type PayoutRunSummary = {
  window_start:        string;
  window_end:          string;
  /**
   * Inclusive human form, e.g. '2026-08-06 to 2026-08-12'. Produced by
   * describePayoutWindow, NOT by local date formatting: this file's first
   * version sliced toISOString(), which reports the UTC calendar day and so
   * labelled every window a day early at both ends (Thu 00:00 SAST is 22:00
   * UTC the previous day). The label goes into cron_runs, where being a day
   * out is exactly the kind of thing someone reconciles against later.
   */
  window_label:        string;
  batches_created:     number;
  batches_reused:      number;
  payouts_claimed:     number;
  total_net:           number;
  practices:           BatchResult[];
  /**
   * Pending, unbatched payouts that ACTIVATED BEFORE this window — i.e. a
   * previous week's run was missed. Reported rather than silently swept in,
   * because a batch labelled "Thu 6 – Wed 12" must contain exactly that.
   * Backfill with ?weekEnding=YYYY-MM-DD. A non-zero count here is an alarm.
   */
  stranded_payouts:    number;
  /**
   * Active plans with NO payouts row at all. Should be impossible — every
   * activation goes through activateFirstInstalment, which inserts one. Counted
   * and reported so it surfaces here instead of as a practice's missing money;
   * deliberately NOT auto-created, because that would make this a second
   * writer to payouts and break the 0087 single-creator invariant.
   */
  orphan_active_plans: number;
  errors:              string[];
};

export type RunOptions = {
  /** Fixed run instant. Tests pass this; the cron passes its own start time. */
  now?: Date;
  /** Backfill a specific window by its exclusive Thursday end (SAST date). */
  weekEnding?: string | null;
};

/** Resolve the window to settle — normal run, or an explicit backfill. */
export function resolveRunWindow(opts: RunOptions = {}): PayoutWindow {
  if (opts.weekEnding) return payoutWindowEndingOn(opts.weekEnding);
  return payoutWindowForRun(opts.now ?? new Date());
}

export async function runPayoutBatches(
  supabase: PayoutRunnerSupabase,
  opts: RunOptions = {},
): Promise<PayoutRunSummary> {
  const window = resolveRunWindow(opts);
  const startIso = window.windowStart.toISOString();
  const endIso   = window.windowEnd.toISOString();
  const runAt    = (opts.now ?? new Date()).toISOString();

  const errors: string[] = [];

  // ── 1. Which practices have unbatched pending payouts in the window? ──
  //
  // Driven FROM payouts, so a practice with nothing to settle gets no batch
  // row at all — an empty batch would be a deposit that never happens.
  const { data: candidateRows, error: candidateErr } = await supabase
    .from('payouts')
    .select('id, practice_id, net_amount')
    .is('batch_id', null)
    .eq('status', 'pending')
    .gte('created_at', startIso)
    .lt('created_at', endIso);

  if (candidateErr) {
    return {
      window_start: startIso, window_end: endIso,
      window_label: describePayoutWindow(window),
      batches_created: 0, batches_reused: 0, payouts_claimed: 0, total_net: 0,
      practices: [], stranded_payouts: 0, orphan_active_plans: 0,
      errors: [`candidate query failed: ${candidateErr.message}`],
    };
  }

  const candidates = (candidateRows ?? []) as Array<{
    id: string; practice_id: string; net_amount: number | string;
  }>;
  const practiceIds = [...new Set(candidates.map((r) => r.practice_id))].sort();

  // ── 2. One batch per practice ─────────────────────────────────────────
  const results: BatchResult[] = [];
  let created = 0;
  let reused  = 0;

  for (const practiceId of practiceIds) {
    try {
      const outcome = await batchOnePractice(supabase, practiceId, window, runAt);
      results.push(outcome.result);
      if (outcome.createdBatch) created++; else reused++;
    } catch (e) {
      errors.push(`practice ${practiceId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 3. Visibility on the two things that should never happen ──────────
  const stranded = await countStranded(supabase, startIso, errors);
  const orphans  = await countOrphanActivePlans(supabase, errors);

  return {
    window_start:        startIso,
    window_end:          endIso,
    window_label:        describePayoutWindow(window),
    batches_created:     created,
    batches_reused:      reused,
    payouts_claimed:     results.reduce((s, r) => s + r.claimed, 0),
    total_net:           round2(results.reduce((s, r) => s + r.totalNet, 0)),
    practices:           results,
    stranded_payouts:    stranded,
    orphan_active_plans: orphans,
    errors,
  };
}

async function batchOnePractice(
  supabase: PayoutRunnerSupabase,
  practiceId: string,
  window: PayoutWindow,
  runAt: string,
): Promise<{ result: BatchResult; createdBatch: boolean }> {
  const startIso = window.windowStart.toISOString();
  const endIso   = window.windowEnd.toISOString();

  // ── 2a. Claim (or find) the batch row ────────────────────────────────
  //
  // upsert + ignoreDuplicates → INSERT ... ON CONFLICT (practice_id,
  // window_start) DO NOTHING. On a re-run or a concurrent invocation the
  // insert is a benign no-op rather than a unique-violation error — the same
  // technique activateFirstInstalment uses against payouts.plan_id. Totals
  // start at 0 and are written in 2c once membership is known.
  const { data: insertedRows, error: insertErr } = await supabase
    .from('payout_batches')
    .upsert(
      {
        practice_id:  practiceId,
        window_start: startIso,
        window_end:   endIso,
        run_at:       runAt,
        status:       'pending',
        total_net:    0,
        plan_count:   0,
      },
      { onConflict: 'practice_id,window_start', ignoreDuplicates: true },
    )
    .select('id');

  if (insertErr) throw new Error(`batch upsert failed: ${insertErr.message}`);

  let batchId      = (insertedRows ?? [])[0]?.id as string | undefined;
  let createdBatch = !!batchId;

  if (!batchId) {
    // The insert was a no-op: this practice/window batch already exists.
    // Read it back rather than trusting a local cache — under concurrency
    // the other invocation is the authority on the id.
    const { data: existing, error: readErr } = await supabase
      .from('payout_batches')
      .select('id')
      .eq('practice_id',  practiceId)
      .eq('window_start', startIso)
      .maybeSingle();
    if (readErr)     throw new Error(`batch read-back failed: ${readErr.message}`);
    if (!existing)   throw new Error('batch upsert was a no-op but no existing batch found');
    batchId      = existing.id as string;
    createdBatch = false;
  }

  // ── 2b. The atomic claim ─────────────────────────────────────────────
  //
  // `batch_id IS NULL` in the predicate is what makes this safe to run
  // twice. A row already claimed — by a previous run or by a concurrent
  // invocation — fails the predicate and is skipped, so it can never end up
  // in two batches or be counted twice. status='pending' excludes anything
  // already settled by the legacy per-plan flow: sweeping a paid payout into
  // a batch would invite paying it a second time.
  const { data: claimedRows, error: claimErr } = await supabase
    .from('payouts')
    .update({ batch_id: batchId })
    .is('batch_id', null)
    .eq('status', 'pending')
    .eq('practice_id', practiceId)
    .gte('created_at', startIso)
    .lt('created_at', endIso)
    .select('id');

  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const claimed = (claimedRows ?? []).length;

  // ── 2c. Totals from the DB, not from what we just claimed ────────────
  //
  // Reading back every member of the batch is what keeps concurrent
  // invocations consistent: if two runners split the window's rows, each
  // one's recomputation covers BOTH halves, so the last write is still
  // correct rather than half the money.
  const { data: memberRows, error: memberErr } = await supabase
    .from('payouts')
    .select('net_amount')
    .eq('batch_id', batchId);

  if (memberErr) throw new Error(`member read failed: ${memberErr.message}`);

  const members   = (memberRows ?? []) as Array<{ net_amount: number | string }>;
  const totalNet  = round2(members.reduce((s, r) => s + Number(r.net_amount), 0));
  const planCount = members.length;

  const { error: totalErr } = await supabase
    .from('payout_batches')
    .update({ total_net: totalNet, plan_count: planCount })
    .eq('id', batchId)
    // Never rewrite the totals of a batch an admin has already settled —
    // the figure they paid against must stay exactly what they saw.
    .eq('status', 'pending');

  if (totalErr) throw new Error(`total update failed: ${totalErr.message}`);

  return {
    result: { practiceId, batchId, claimed, planCount, totalNet },
    createdBatch,
  };
}

/**
 * Pending, unbatched payouts activated BEFORE this window — the signature of
 * a missed run. Counted so the miss is loud in cron_runs instead of being
 * discovered by a practice whose deposit never arrived.
 */
async function countStranded(
  supabase: PayoutRunnerSupabase,
  startIso: string,
  errors: string[],
): Promise<number> {
  const { count, error } = await supabase
    .from('payouts')
    .select('id', { count: 'exact', head: true })
    .is('batch_id', null)
    .eq('status', 'pending')
    .lt('created_at', startIso);
  if (error) {
    errors.push(`stranded count failed: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

/**
 * Active plans with no payouts row. Should be impossible; reported rather
 * than repaired, because repairing it here would make this a second creator
 * of payouts and break the single-writer invariant 0087 protects.
 */
async function countOrphanActivePlans(
  supabase: PayoutRunnerSupabase,
  errors: string[],
): Promise<number> {
  const { data: activePlans, error: planErr } = await supabase
    .from('plans')
    .select('id')
    .eq('status', 'active');
  if (planErr) {
    errors.push(`orphan scan (plans) failed: ${planErr.message}`);
    return 0;
  }
  const planIds = (activePlans ?? []).map((p: { id: string }) => p.id);
  if (planIds.length === 0) return 0;

  const { data: payoutRows, error: payoutErr } = await supabase
    .from('payouts')
    .select('plan_id')
    .in('plan_id', planIds);
  if (payoutErr) {
    errors.push(`orphan scan (payouts) failed: ${payoutErr.message}`);
    return 0;
  }
  const covered = new Set((payoutRows ?? []).map((r: { plan_id: string }) => r.plan_id));
  return planIds.filter((id: string) => !covered.has(id)).length;
}

/** Rands to 2dp. Sums of NUMERIC(10,2) can still pick up float dust in JS. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
