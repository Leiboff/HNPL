// ─── The safety net under every claim (audit A-13) ─────────────────────────
//
// Four code paths flip a `payments` row to 'processing' and then do something
// that can fail: settle-entire-bill, the collection cron, payWithSavedCard
// and initiateCheckout. A row left in 'processing' is invisible to every
// automated path in the system — attemptChargeInstalment claims only
// scheduled/failed/defaulted, the cron selects only scheduled and failed,
// assessDunningFee looks only at failed. So a stranded claim is not a stalled
// payment; it is a permanent, silent write-off of everything it covers, on a
// plan that then never defaults and never freezes the customer.
//
// This is the daily reconciliation for that, and it is deliberately two
// tiers, because the two populations admit different answers.
//
// ─── TIER 1 — REVERT, when nothing was ever sent ───────────────────────────
//
// `provider_attempted_at IS NULL` means the claim died before the HTTP call:
// a crashed process, a failed precondition lookup, a lambda that timed out
// between the UPDATE and the fetch. There is no charge at Peach to double, so
// restoring the row to `pre_claim_status` (both trigger-maintained, migration
// 0132) is unconditionally safe and exactly right.
//
// ─── TIER 2 — REPORT, when a charge may be in flight ───────────────────────
//
// `provider_attempted_at IS NOT NULL` means we handed the charge over and did
// not learn what happened. The audit's suggested fix here was to revert like
// the `rejected` branch does, and that is not safe: a transport error means
// we do not know whether Peach received it, and reverting a claim Peach is
// about to collect risks charging the customer twice for the same money.
//
// The honest resolution would be to ASK — but this Peach client has no
// payment-status query on the recurring surface, and inventing an endpoint
// against a third-party API nobody has verified is how you get a sweep that
// confidently reverts on a 404 from the wrong URL. So these rows are not
// touched. They are logged with an alertable prefix and surfaced on
// /admin/collections, where a human reconciles them against the Peach
// dashboard — the only place that answer actually exists.
//
// That is not a lesser fix. The defect was never "a human has to check four
// rows"; it was that nobody knew the rows existed.
//
// ─── THE ONE CARVE-OUT ─────────────────────────────────────────────────────
//
// Instalment 1 of a plan still at `pending_first_payment` is NOT a stranded
// claim. It is a live, resumable checkout: the row sits in 'processing' by
// design while the patient is in the Peach widget, and the resume path
// deliberately re-uses that row so the deterministic reference is identical
// and Peach dedups instead of double-charging. Reverting it would break the
// resume, and it already has its own end state — claim_credit_for_plan
// deletes and rewrites the schedule on re-acceptance, and
// expire_stale_checkout_session closes the token.

/** How long a row may sit in 'processing' before it counts as stuck. */
export const STUCK_PROCESSING_HOURS = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

type StuckRow = {
  id:                    string;
  plan_id:               string | null;
  patient_id:            string | null;
  kind:                  string | null;
  instalment_number:     number | null;
  amount:                number | string;
  status:                string;
  processing_since:      string | null;
  pre_claim_status:      string | null;
  provider_attempted_at: string | null;
  settled_by_payment_id: string | null;
  peach_payment_id:      string | null;
};

export type SweepSummary = {
  scanned:          number;
  reverted:         number;
  /** Instalments restored as a side effect of failing a settlement row. */
  covered_reverted: number;
  /** Live resumable checkouts, deliberately left alone. */
  skipped_resumable: number;
  /** Tier 2 — a charge may be in flight. Needs a human. */
  needs_reconciliation:     number;
  needs_reconciliation_ids: string[];
  /** Stuck, never sent, but with no recorded prior status to restore to. */
  unrestorable:     number;
  unrestorable_ids: string[];
  errors:           number;
};

/**
 * One pass. Safe to run concurrently with anything: every write is
 * conditional on the row still being 'processing', so a claim that resolves
 * mid-sweep simply is not touched.
 */
export async function sweepStuckProcessing(
  svc: Svc,
  opts: { now?: Date; hours?: number } = {},
): Promise<SweepSummary> {
  const now    = opts.now ?? new Date();
  const hours  = opts.hours ?? STUCK_PROCESSING_HOURS;
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();

  const summary: SweepSummary = {
    scanned: 0, reverted: 0, covered_reverted: 0, skipped_resumable: 0,
    needs_reconciliation: 0, needs_reconciliation_ids: [],
    unrestorable: 0, unrestorable_ids: [],
    errors: 0,
  };

  const { data: rows, error } = await svc
    .from('payments')
    .select(
      'id, plan_id, patient_id, kind, instalment_number, amount, status, '
      + 'processing_since, pre_claim_status, provider_attempted_at, '
      + 'settled_by_payment_id, peach_payment_id',
    )
    .eq('status', 'processing')
    .not('processing_since', 'is', null)
    .lt('processing_since', cutoff);

  if (error) {
    console.error('[sweep-stuck-processing] query failed', error.message);
    summary.errors++;
    return summary;
  }

  const stuck = (rows ?? []) as StuckRow[];
  summary.scanned = stuck.length;
  if (stuck.length === 0) return summary;

  // The settlement rows in THIS scan. A covered instalment whose parent is
  // here is released by the parent, so it is skipped rather than handled
  // twice — which would double-count the revert and, worse, make the outcome
  // depend on the order the rows came back in.
  const settlementsInScan = new Set(
    stuck.filter((r) => r.kind === 'settlement').map((r) => r.id),
  );

  // Which of these plans are live resumable checkouts. One query rather than
  // one per row.
  const planIds = [...new Set(stuck.map((r) => r.plan_id).filter((x): x is string => !!x))];
  const { data: planRows } = await svc
    .from('plans')
    .select('id, status')
    .in('id', planIds);
  const planStatus = new Map<string, string>(
    ((planRows ?? []) as Array<{ id: string; status: string }>).map((p) => [p.id, p.status]),
  );

  for (const row of stuck) {
    // The carve-out. See the header: this row is the resume path's anchor.
    if (
      row.kind !== 'settlement'
      && row.instalment_number === 1
      && row.plan_id
      && planStatus.get(row.plan_id) === 'pending_first_payment'
    ) {
      summary.skipped_resumable++;
      continue;
    }

    // Tier 2. Not touched, on purpose.
    if (row.provider_attempted_at !== null) {
      summary.needs_reconciliation++;
      summary.needs_reconciliation_ids.push(row.id);
      console.error(
        '[sweep-stuck-processing] ALERT a charge may be in flight and never resolved '
        + '— reconcile against the Peach dashboard',
        {
          paymentId:       row.id,
          planId:          row.plan_id,
          kind:            row.kind,
          reference:       row.peach_payment_id,
          amount:          row.amount,
          processingSince: row.processing_since,
          attemptedAt:     row.provider_attempted_at,
        },
      );
      continue;
    }

    // ── Tier 1 ────────────────────────────────────────────────────────
    //
    // A settlement row carries the statuses of everything it claimed, so
    // failing it is what releases them. Routed through the same shape the
    // webhook's failure path uses rather than a second implementation of
    // the revert.
    if (row.kind === 'settlement') {
      const ok = await revertSettlement(svc, row, summary);
      if (!ok) summary.errors++;
      continue;
    }

    // An instalment claimed BY a settlement is reverted when that settlement
    // is — not on its own, or we would clear the link its snapshot is keyed
    // by and leave the settlement row claiming rows it no longer holds.
    if (row.settled_by_payment_id) {
      if (settlementsInScan.has(row.settled_by_payment_id)) continue;

      const { data: parent } = await svc
        .from('payments')
        .select('id, status, processing_since, provider_attempted_at, pre_settlement_snapshot')
        .eq('id', row.settled_by_payment_id)
        .maybeSingle();
      // If the parent is still 'processing' it is in this same scan and will
      // be handled on its own row. If it is NOT — the parent resolved but
      // this child was missed — release the child from the parent's snapshot.
      if (parent && parent.status !== 'processing') {
        const snapshot = (parent.pre_settlement_snapshot ?? {}) as Record<string, { status?: string }>;
        const prior    = snapshot[row.id]?.status;
        if (!prior) {
          summary.unrestorable++;
          summary.unrestorable_ids.push(row.id);
          console.error(
            '[sweep-stuck-processing] ALERT orphaned settlement child with no snapshot entry',
            { paymentId: row.id, settlementId: parent.id },
          );
          continue;
        }
        const { data: released, error: relErr } = await svc
          .from('payments')
          .update({ status: prior, settled_by_payment_id: null })
          .eq('id', row.id)
          .eq('status', 'processing')
          .select('id');
        if (relErr) { summary.errors++; continue; }
        // Counted only when a row actually moved. The .eq('status',
        // 'processing') guard means a claim that resolved mid-sweep matches
        // nothing, and reporting a revert that did not happen would make the
        // cron summary lie about money.
        if ((released ?? []).length === 0) continue;
        summary.reverted++;
        await logRevert(svc, row, prior, 'orphaned_settlement_child');
      }
      continue;
    }

    // A plain instalment claim that never reached the provider.
    if (!row.pre_claim_status) {
      // Nothing to restore to. This is an INSERT straight into 'processing'
      // (instalment 1 of a fresh schedule) whose plan is not
      // pending_first_payment any more — so the carve-out above did not
      // apply and we have no prior status. Guessing 'scheduled' on a
      // past-due row would make the cron charge it, and guessing 'failed'
      // would post a dunning fee for a failure that never happened. Report.
      summary.unrestorable++;
      summary.unrestorable_ids.push(row.id);
      console.error(
        '[sweep-stuck-processing] ALERT stuck row with no recorded prior status',
        { paymentId: row.id, planId: row.plan_id, planStatus: row.plan_id ? planStatus.get(row.plan_id) : null },
      );
      continue;
    }

    const { data: restored, error: revErr } = await svc
      .from('payments')
      .update({
        status:           row.pre_claim_status,
        peach_payment_id: null,
        failure_reason:   'reverted by stuck-processing sweep (never sent to provider)',
      })
      .eq('id', row.id)
      .eq('status', 'processing')
      .select('id');
    if (revErr) { summary.errors++; continue; }
    if ((restored ?? []).length === 0) continue;
    summary.reverted++;
    await logRevert(svc, row, row.pre_claim_status, 'claim_never_sent');
  }

  return summary;
}

/**
 * Fail a settlement row that never reached the provider, and release every
 * instalment it claimed back to its snapshot status.
 *
 * The revert is the same operation the webhook's charge.failed path performs.
 * It is repeated here rather than shared because the two differ in the one
 * place that matters: the webhook has a provider verdict and this does not,
 * so the reason recorded is different and must stay distinguishable in
 * plan_events.
 */
async function revertSettlement(svc: Svc, row: StuckRow, summary: SweepSummary): Promise<boolean> {
  const { data: settlement } = await svc
    .from('payments')
    .select('id, plan_id, patient_id, pre_settlement_snapshot')
    .eq('id', row.id)
    .maybeSingle();
  if (!settlement) return false;

  const reason = 'reverted by stuck-processing sweep (never sent to provider)';
  const { data: failed, error: failErr } = await svc
    .from('payments')
    .update({ status: 'failed', failure_reason: reason })
    .eq('id', row.id)
    .eq('status', 'processing')
    .select('id');
  if (failErr) return false;
  // Somebody resolved it between the scan and now. Not an error, and not a
  // revert — leave its children to whoever did.
  if ((failed ?? []).length === 0) return true;

  const snapshot = (settlement.pre_settlement_snapshot ?? {}) as Record<string, { status?: string }>;
  const { data: covered } = await svc
    .from('payments')
    .select('id')
    .eq('settled_by_payment_id', row.id)
    .eq('status', 'processing')
    .eq('kind', 'instalment');

  for (const child of (covered ?? []) as Array<{ id: string }>) {
    // Default 'failed' rather than 'scheduled' when the snapshot is missing
    // an entry: a settlement only ever claims rows that were scheduled,
    // failed or defaulted, and 'failed' is the one that puts the row back in
    // the dunning ladder instead of straight into the next cron charge.
    const prior = snapshot[child.id]?.status ?? 'failed';
    const { data: releasedChild, error } = await svc
      .from('payments')
      .update({ status: prior, settled_by_payment_id: null })
      .eq('id', child.id)
      .eq('settled_by_payment_id', row.id)
      .eq('status', 'processing')
      .select('id');
    if (!error && (releasedChild ?? []).length > 0) summary.covered_reverted++;
  }

  summary.reverted++;
  await logRevert(svc, row, 'failed', 'settlement_never_sent');
  return true;
}

/**
 * A revert moves a customer's money position, so it belongs in the timeline
 * they and support both read. Non-fatal: a sweep that cannot write an event
 * must still do the revert, because the revert is what un-writes-off the
 * balance.
 */
async function logRevert(
  svc: Svc,
  row: StuckRow,
  restoredTo: string,
  reason: string,
): Promise<void> {
  if (!row.plan_id) return;
  const { error } = await svc.from('plan_events').insert({
    plan_id:    row.plan_id,
    patient_id: row.patient_id,
    event_type: 'stuck_claim_reverted',
    payload: {
      payment_id:       row.id,
      kind:             row.kind,
      restored_to:      restoredTo,
      reason,
      processing_since: row.processing_since,
    },
  });
  if (error) {
    console.warn('[sweep-stuck-processing] could not record plan_event (non-fatal)', error.message);
  }
}
