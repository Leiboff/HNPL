import { type PayoutWindow } from '@/lib/payments/payoutWindow';
import { openPayoutWindow, paidRecentlySince } from '@/lib/payments/payoutSchedule';

// ─── "Next payout" for one practice ─────────────────────────────────────
//
// Resolves what a practice is owed and when, for the dashboard hero. Read
// only: it writes nothing, creates no payouts, and never recomputes a fee.
// Every figure it reports either came out of the database or is a SUM of
// rows that did.
//
// THE THREE STATES, AND WHY THEY MUST LOOK DIFFERENT
// ─────────────────────────────────────────────────
//   committed — a payout_batches row is CLOSED (status 'pending') and
//               awaiting the transfer. total_net and plan_count were written
//               when the batch closed and are final. This is a promise.
//   projected — no closed batch, but unbatched pending payouts exist inside
//               the window still open. This is a RUNNING TOTAL: another plan
//               activating tomorrow changes it, so it must never be
//               presented with the confidence of a closed batch.
//   none      — neither. The UI shows an empty state; it must not render R0
//               as though zero were a measured figure.
//
// Note which side of the line 'projected' sits on: the number is real (it is
// a SUM of real payouts rows) but the SET is not final. That is the whole
// reason for the distinction, and it is why this returns a discriminated
// union rather than a nullable amount with a boolean flag — a caller cannot
// accidentally render a projection as a commitment.
//
// RLS — THE TWO TABLES NOW MATCH
// ──────────────────────────────
// Both are readable by ANY active member of the practice:
//
//   payout_batches  is_practice_member  (0090)
//   payouts         is_practice_member  (0092)
//
// They did NOT always match, and the history is why this module is shaped the
// way it is. payouts was manager-only — 0002 created
// practice_admins_select_payouts on is_practice_admin (role = 'admin'), 0035
// re-created it on is_practice_manager (can_manage_practice = true) under the
// same misleading name — while payout_batches was open to every member. So an
// ordinary member could read a batch's TOTAL but not the rows inside it, and
// saw a plan count above an empty list. 0092 replaced that policy with
// practice_members_select_payouts on is_practice_member, which is what makes
// the plan breakdown work for everyone who can see the total.
//
// Both tables are additionally readable by is_brand_admin_of_practice
// (0061 / 0090), and 0022 lets a provider read payouts rows where
// provider_id = auth.uid().
//
// This module still REPORTS what came back rather than predicting it. That is
// not defensive habit, it is the lesson of 0035: re-stating a permission rule
// in app code is how the app's copy of it goes stale, and this file's own
// comments were wrong about the policy within a day of it changing. Reacting
// to the actual result cannot drift from the database.
//
// So `plansHidden` — a batch claiming N plans while the payouts read returned
// none — no longer means a permission gap. Post-0092 it means a genuine
// inconsistency between plan_count and the batch's members, and the UI copy
// says that instead of blaming permissions.
//
// The empty-state copy stays written as "nothing scheduled yet" rather than as
// an assertion that the practice is owed nothing. Not because a read might have
// been refused any more, but because "no batch and no unbatched payouts" is
// genuinely not the same statement as "you are owed nothing".

/**
 * Intentionally loose, for the reason lib/practice/tradingGate.ts documents
 * for its own alias: a structural type for Supabase's deeply-generic
 * PostgREST builder makes TypeScript report "Type instantiation is
 * excessively deep and possibly infinite" at the call sites.
 *
 * Whatever client the caller already uses for practice-scoped reads. On the
 * member path that is their own RLS-bound client; on the brand-admin path
 * the dashboard passes service-role, having already proven brand authority.
 * This module makes no authority decision of its own.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NextPayoutSupabase = any;

/** One plan inside the figure being shown. */
export type PayoutPlanLine = {
  payoutId:      string;
  planId:        string | null;
  netAmount:     number;
  /** Practice-facing patient label, e.g. "Thabo M." — never a full surname. */
  patientLabel:  string;
  invoiceNumber: string | null;
  activatedAt:   string;
};

type Common = {
  /** The window the figure covers. */
  window:    PayoutWindow;
  totalNet:  number;
  planCount: number;
  /** The plans composing the figure. See plansHidden for the empty-yet-counted case. */
  plans:     PayoutPlanLine[];
  /**
   * True when planCount > 0 but no payouts rows came back — a batch whose
   * plan_count disagrees with its own members.
   *
   * Kept as a defensive fallback, not as a permission signal. Before 0092 this
   * fired for an ordinary member, because payouts was manager-only while
   * payout_batches was not; now both are is_practice_member, so the only way to
   * reach it is real inconsistency. Retained because "N plans" above an empty
   * list is worse than saying plainly that the breakdown is missing.
   */
  plansHidden: boolean;
};

export type NextPayout =
  | ({ kind: 'committed'; batchId: string } & Common)
  | ({ kind: 'projected' } & Common)
  | { kind: 'none' };

export type NextPayoutResult = {
  next: NextPayout;
  /** Sum of total_net over batches marked paid in the last 30 days. */
  paidRecentlyNet:   number;
  paidRecentlyCount: number;
  /**
   * Closed batches beyond the one shown, still awaiting transfer. Normally
   * 0 — one batch closes and is settled each week. Non-zero means an earlier
   * week was never settled, so showing only the next batch would understate
   * what the practice is owed. Reported rather than silently folded in: they
   * are separate deposits, not one bigger one.
   */
  otherPendingCount: number;
  otherPendingNet:   number;
  /**
   * Pending, unbatched payouts that activated BEFORE the open window. The
   * runner's window is strict, so these will NOT be swept into the next
   * close — they need a backfill. Surfaced as a count with no date attached,
   * because promising them "Friday" would be false.
   */
  strandedCount: number;
};

const EMPTY: NextPayout = { kind: 'none' };

export async function resolveNextPayout(
  supabase:   NextPayoutSupabase,
  practiceId: string,
  now:        Date = new Date(),
): Promise<NextPayoutResult> {
  const [batches, paid] = await Promise.all([
    // Every closed-but-unpaid batch. Oldest first: the next transfer to go
    // out is the one that has been waiting longest, and that is what "next
    // payout" means to a practice.
    supabase
      .from('payout_batches')
      .select('id, window_start, window_end, total_net, plan_count')
      .eq('practice_id', practiceId)
      .eq('status', 'pending')
      .order('window_start', { ascending: true }),
    supabase
      .from('payout_batches')
      .select('total_net')
      .eq('practice_id', practiceId)
      .eq('status', 'paid')
      .gte('paid_at', paidRecentlySince(now).toISOString()),
  ]);

  const pendingBatches = (batches.data ?? []) as Array<{
    id: string; window_start: string; window_end: string;
    total_net: number | string; plan_count: number;
  }>;
  const paidRows = (paid.data ?? []) as Array<{ total_net: number | string }>;

  const paidRecentlyNet   = round2(paidRows.reduce((s, r) => s + Number(r.total_net), 0));
  const paidRecentlyCount = paidRows.length;

  // ── (a) A closed batch is waiting. The committed case. ────────────────
  if (pendingBatches.length > 0) {
    const [batch, ...rest] = pendingBatches;
    const plans = await loadPlanLines(supabase, practiceId, (q) => q.eq('batch_id', batch.id));
    const planCount = batch.plan_count;

    return {
      next: {
        kind:        'committed',
        batchId:     batch.id,
        // The batch's OWN stored boundaries, not a recomputed window: a
        // batch that closed weeks ago must keep describing the week it
        // actually covered.
        window:      { windowStart: new Date(batch.window_start), windowEnd: new Date(batch.window_end) },
        totalNet:    round2(Number(batch.total_net)),
        planCount,
        plans,
        plansHidden: planCount > 0 && plans.length === 0,
      },
      paidRecentlyNet,
      paidRecentlyCount,
      otherPendingCount: rest.length,
      otherPendingNet:   round2(rest.reduce((s, r) => s + Number(r.total_net), 0)),
      strandedCount:     await countStranded(supabase, practiceId, now),
    };
  }

  // ── (b) Nothing closed yet — project the window still open. ───────────
  //
  // Bounded by the OPEN window, not merely "unbatched": a pending row that
  // activated before this window opened will not be picked up by the next
  // close (the runner's window is strict), so counting it here would promise
  // money on a date it will not arrive. Those rows are reported separately.
  const open = openPayoutWindow(now);
  const inWindow = await loadPlanLines(supabase, practiceId, (q) =>
    q.is('batch_id', null)
      .eq('status', 'pending')
      .gte('created_at', open.windowStart.toISOString())
      .lt('created_at',  open.windowEnd.toISOString()),
  );

  const stranded = await countStranded(supabase, practiceId, now);

  if (inWindow.length === 0) {
    return {
      next: EMPTY,
      paidRecentlyNet, paidRecentlyCount,
      otherPendingCount: 0, otherPendingNet: 0,
      strandedCount: stranded,
    };
  }

  return {
    next: {
      kind:        'projected',
      window:      open,
      totalNet:    round2(inWindow.reduce((s, p) => s + p.netAmount, 0)),
      planCount:   inWindow.length,
      plans:       inWindow,
      // Not reachable for a projection: the count IS derived from the rows,
      // so it cannot be non-zero while the list is empty. Stated explicitly
      // rather than left to inference.
      plansHidden: false,
    },
    paidRecentlyNet, paidRecentlyCount,
    otherPendingCount: 0, otherPendingNet: 0,
    strandedCount: stranded,
  };
}

/**
 * Pending, unbatched payouts older than the open window — the practice-side
 * view of the runner's stranded_payouts alarm. Counted only; no amount, no
 * date, because the honest thing to say is "we are looking into it".
 */
async function countStranded(
  supabase:   NextPayoutSupabase,
  practiceId: string,
  now:        Date,
): Promise<number> {
  const { count } = await supabase
    .from('payouts')
    .select('id', { count: 'exact', head: true })
    .eq('practice_id', practiceId)
    .eq('status', 'pending')
    .is('batch_id', null)
    .lt('created_at', openPayoutWindow(now).windowStart.toISOString());
  return count ?? 0;
}

/**
 * The plans behind a figure. `narrow` applies the case-specific predicate —
 * batch membership for a committed batch, the open-window filter for a
 * projection — so both cases share one query shape and one mapping.
 *
 * practice_id is applied HERE, unconditionally, for every case. That is the
 * scoping guarantee: there is no code path through this module that reads a
 * payouts row without it, so a caller cannot be handed another practice's
 * money by passing the wrong predicate.
 */
async function loadPlanLines(
  supabase:   NextPayoutSupabase,
  practiceId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  narrow:     (q: any) => any,
): Promise<PayoutPlanLine[]> {
  // practice_id is applied before `narrow` ever sees the builder, so no
  // case-specific predicate can drop it.
  const scoped = supabase
    .from('payouts')
    .select(`
      id, plan_id, net_amount, created_at,
      plans(
        invoice_number,
        patient:profiles!plans_patient_id_fkey(first_name, last_name)
      )
    `)
    .eq('practice_id', practiceId);

  const { data } = await narrow(scoped).order('created_at', { ascending: true });

  type Patient = { first_name: string | null; last_name: string | null };
  type PlanRef  = { invoice_number: string | null; patient: Patient | Patient[] | null };
  const rows = (data ?? []) as Array<{
    id: string; plan_id: string | null; net_amount: number | string;
    created_at: string; plans: PlanRef | PlanRef[] | null;
  }>;

  return rows.map((r) => {
    const plan    = Array.isArray(r.plans) ? (r.plans[0] ?? null) : r.plans;
    const patient = plan && (Array.isArray(plan.patient) ? (plan.patient[0] ?? null) : plan.patient);
    return {
      payoutId:      r.id,
      planId:        r.plan_id,
      netAmount:     round2(Number(r.net_amount)),
      patientLabel:  patientLabel(patient),
      invoiceNumber: plan?.invoice_number ?? null,
      activatedAt:   r.created_at,
    };
  });
}

/**
 * "Thabo M." — first name plus surname initial, the same shape the bills
 * table and the patient columns elsewhere in the practice portal use. A
 * practice legitimately knows who its own patients are, but a payout list is
 * a money surface, so it carries the minimum that still identifies a row.
 */
function patientLabel(patient: { first_name: string | null; last_name: string | null } | null): string {
  if (!patient?.first_name) return '—';
  const initial = patient.last_name?.charAt(0).toUpperCase();
  return initial ? `${patient.first_name} ${initial}.` : patient.first_name;
}

/** Rands to 2dp. Sums of NUMERIC(10,2) can pick up float dust in JS. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
