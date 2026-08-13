import { sastDateString, type PayoutWindow } from '@/lib/payments/payoutWindow';
import { openPayoutWindow, payoutDateFor, windowDates } from '@/lib/payments/payoutSchedule';
import { payoutPatientLabel, type NextPayoutSupabase } from './nextPayout';

// ─── Payout history for one practice — the reconciliation surface ──────────
//
// /practice/payouts answers a different question from the dashboard hero. The
// hero answers "what is coming and when" for ONE figure. This answers "which
// plans produced the deposit that hit my bank account on the 14th" for every
// week — so it returns a LIST, and each entry carries enough per-plan detail
// to tick off against a bank statement.
//
// WHAT A BATCH IS, SINCE THE UI MUST NOT MISREPRESENT IT
// ─────────────────────────────────────────────────────
// A batch is composed of PLANS, not instalments. The practice is paid the full
// plan net UPFRONT when a plan activates (BetterNow carries the patient credit
// risk), so instalments 2..N generate no payout activity at all — see 0090's
// header. plan_count is therefore a count of activated plans, and total_net is
// the sum of their payouts.net_amount as it stood when the batch closed.
//
// THREE CERTAINTIES, AND WHY THEY ARE A DISCRIMINATED UNION
// ────────────────────────────────────────────────────────
//   'paid'      status='paid', paid_at set. An admin has confirmed the EFT
//               left our side.
//   'awaiting'  status='pending'. The batch is CLOSED — its total and plan set
//               are final and cannot move — but nobody has run the transfer.
//               Settlement is manual (0090 automates the BATCHING and the
//               WINDOW, not the bank transfer), so this state can persist.
//   'open'      the window still accumulating. Not a batch row at all: it is
//               synthesised from unbatched pending payouts inside the open
//               window, exactly as resolveNextPayout's 'projected' case does.
//
// The kind is resolved HERE rather than left to the component, so a surface
// cannot accidentally render an awaiting batch with paid styling. See
// app/practice/payoutCopy.ts for the words each kind is allowed to use.
//
// WHY THIS IS NOT resolveNextPayout WITH A HIGHER LIMIT
// ────────────────────────────────────────────────────
// It reuses everything reusable and deliberately does not reuse the rest:
//
//   REUSED   the window helpers (payoutWindow / payoutSchedule), so the dates
//            here are byte-identical to the runner's and the hero's;
//            payoutPatientLabel, so a patient is written the same way on every
//            practice-facing surface.
//
//   NOT      resolveNextPayout's shape. It returns ONE batch (the oldest
//   REUSED   unpaid) plus roll-ups, and its PayoutPlanLine carries net only.
//            This tab needs every batch, paid ones included, and needs gross
//            and fee per plan. Widening the hero's query to carry columns the
//            hero never renders would make the dashboard pay for this screen,
//            and bending its one-batch return into a list would leave the hero
//            picking an element out of a list it does not want.
//
// GROSS AND FEE ARE READ, NEVER RECOMPUTED
// ────────────────────────────────────────
// payouts stores gross_amount, fee_amount and net_amount (0001), all three
// captured at activation from the fee_percent in force AT THAT MOMENT
// (lib/payments/activateFirstInstalment.ts). So this module SELECTs them and
// does no arithmetic beyond summing.
//
// Recomputing the fee from practices.fee_percent — or from gross minus net —
// would be wrong in the one case that matters most: a practice whose
// commission changed would see historical batches silently restated, and the
// fee column on a six-month-old deposit would stop matching the invoice it was
// taken against. 0090 says the same thing about total_net: "Never recomputed
// from fee_percent — the fee was captured per plan at activation." This module
// imports no fee helper, and its test forbids one.
//
// SCOPING
// ───────
// Both reads apply .eq('practice_id', practiceId) unconditionally, in the same
// expression that names the table, and the plan-line read is additionally
// bounded to batch ids that came back from the already-scoped batch read. RLS
// is the real boundary (0090/0092: both tables are is_practice_member), but a
// query that relies on RLS alone is one service-role caller away from leaking,
// and the brand-admin path DOES pass service-role — see the page for why.

/** Same loose alias as nextPayout's, for the same PostgREST-generics reason. */
export type PayoutHistorySupabase = NextPayoutSupabase;

/** One plan inside a batch, with everything needed to reconcile it. */
export type PayoutHistoryPlanLine = {
  payoutId:      string;
  planId:        string | null;
  /** "Thabo M." — the shared practice-facing label, never a full surname. */
  patientLabel:  string;
  invoiceNumber: string | null;
  /** The reference the PRACTICE typed on their side. What they search by. */
  practiceReference: string | null;
  grossAmount:   number;
  /** The BetterNow fee as captured at activation. Never "MDR" on any surface. */
  feeAmount:     number;
  netAmount:     number;
  activatedAt:   string;
};

/** Pre-resolved SAST calendar dates. No component ever sees an instant. */
export type PayoutEntryDates = {
  /** The day this batch is/was due to be transferred. */
  payoutDate:  string;
  windowFirst: string;
  windowLast:  string;
  /** The day the transfer was confirmed. Non-null only when kind is 'paid'. */
  paidDate:    string | null;
};

export type PayoutHistoryEntry = {
  /** Stable React key. The batch id, or 'open' for the synthesised week. */
  key:       string;
  kind:      'paid' | 'awaiting' | 'open';
  /** Null for the open week — there is no batch row yet. */
  batchId:   string | null;
  window:    PayoutWindow;
  /** The batch's STORED total for a real batch; the summed rows for the open week. */
  totalNet:  number;
  planCount: number;
  plans:     PayoutHistoryPlanLine[];
  dates:     PayoutEntryDates;
  /**
   * True when the due date has already passed and the transfer still has not
   * gone out. Resolved here because the component owns no clock — and it
   * changes the copy: naming a past date as "due" reads as a claim that it
   * happened.
   */
  overdue:   boolean;
  /**
   * planCount > 0 but no plan rows came back. Post-0092 this is a genuine
   * inconsistency rather than a permission gap — same meaning as the hero's
   * plansHidden, and the UI says so rather than showing a count above nothing.
   */
  plansHidden: boolean;
  /** Sum of the plan lines' nets. Rendered as the breakdown's total. */
  plansNetSum: number;
  /**
   * Whether that sum equals the batch's stored total. The whole promise of
   * this screen is that the parts add up to the deposit, so when they do not,
   * the screen says so instead of showing two numbers and letting the reader
   * discover the gap.
   */
  sumMatchesTotal: boolean;
};

export type PayoutHistory = {
  /** Most recent first; the open week, when it has anything in it, leads. */
  entries: PayoutHistoryEntry[];
  /**
   * How many closed batches were read. Compared against the cap below so the
   * UI can say that older weeks exist rather than silently ending the list.
   */
  batchCount: number;
  /** True when the batch read came back full, i.e. there is probably more. */
  truncated:  boolean;
};

/**
 * Six months of weekly batches.
 *
 * Bounded because every entry's plans are loaded up front so a row can expand
 * without a round trip, and an unbounded read would mean a practice three
 * years in downloads its whole settlement history to look at last Friday. The
 * UI states when the list is capped — see `truncated`. Older history wants
 * pagination, which is its own piece of work.
 */
export const PAYOUT_HISTORY_WEEKS = 26;

export async function resolvePayoutHistory(
  supabase:   PayoutHistorySupabase,
  practiceId: string,
  now:        Date = new Date(),
  weeks:      number = PAYOUT_HISTORY_WEEKS,
): Promise<PayoutHistory> {
  const { data: batchRows } = await supabase
    .from('payout_batches')
    .select('id, window_start, window_end, total_net, plan_count, status, paid_at')
    .eq('practice_id', practiceId)
    .order('window_start', { ascending: false })
    .limit(weeks);

  const batches = (batchRows ?? []) as Array<{
    id: string; window_start: string; window_end: string;
    total_net: number | string; plan_count: number;
    status: string; paid_at: string | null;
  }>;

  const open = openPayoutWindow(now);
  const today = sastDateString(now);

  // ── The two plan-line reads ─────────────────────────────────────────────
  //
  // One for every batch on screen (a single `in` rather than N queries), one
  // for the open week. Run together — neither depends on the other.
  const [batchLines, openLines] = await Promise.all([
    batches.length === 0
      ? Promise.resolve([] as LineWithBatch[])
      : loadLines(supabase, practiceId, (q) => q.in('batch_id', batches.map((b) => b.id))),
    // Identical predicate to resolveNextPayout's 'projected' case: unbatched,
    // pending, and INSIDE the open window. The window bound is not optional —
    // a pending row that activated earlier will not be swept into the next
    // close, so counting it here would attach it to a date it will not arrive
    // on. Those rows are the hero's `strandedCount`, and they stay its job.
    loadLines(supabase, practiceId, (q) =>
      q.is('batch_id', null)
        .eq('status', 'pending')
        .gte('created_at', open.windowStart.toISOString())
        .lt('created_at',  open.windowEnd.toISOString()),
    ),
  ]);

  const linesByBatch = new Map<string, PayoutHistoryPlanLine[]>();
  for (const line of batchLines) {
    const bucket = linesByBatch.get(line.batchId ?? '');
    if (bucket) bucket.push(line);
    else linesByBatch.set(line.batchId ?? '', [line]);
  }

  const entries: PayoutHistoryEntry[] = [];

  // The open week leads, when it has anything in it. Nothing is synthesised
  // for an empty one: a row reading R0.00 would look like a measured figure
  // for a week that simply has not had an activation yet — the same reason the
  // hero's empty state is words and not a zero.
  if (openLines.length > 0) {
    const netSum = round2(openLines.reduce((s, l) => s + l.netAmount, 0));
    entries.push({
      key:       'open',
      kind:      'open',
      batchId:   null,
      window:    open,
      totalNet:  netSum,
      planCount: openLines.length,
      plans:     openLines,
      dates:     datesFor(open, null),
      // An open week is not late; it has not closed.
      overdue:   false,
      // Structurally impossible here — the count IS the rows' length.
      plansHidden:     false,
      plansNetSum:     netSum,
      sumMatchesTotal: true,
    });
  }

  for (const b of batches) {
    const window: PayoutWindow = {
      // The batch's OWN stored boundaries, never a recomputed window: a batch
      // that closed in March must keep describing the week it actually
      // covered, whatever the schedule does later.
      windowStart: new Date(b.window_start),
      windowEnd:   new Date(b.window_end),
    };
    const plans    = linesByBatch.get(b.id) ?? [];
    const totalNet = round2(Number(b.total_net));
    const netSum   = round2(plans.reduce((s, l) => s + l.netAmount, 0));
    const paid     = b.status === 'paid';
    const dates    = datesFor(window, b.paid_at);

    entries.push({
      key:       b.id,
      kind:      paid ? 'paid' : 'awaiting',
      batchId:   b.id,
      window,
      totalNet,
      planCount: b.plan_count,
      plans,
      dates,
      // Only an unpaid batch can be late, and only once its due day has
      // passed. A plain string comparison of two YYYY-MM-DD SAST dates — no
      // arithmetic, no timezone, and it cannot be off by an hour.
      overdue:     !paid && dates.payoutDate < today,
      plansHidden: b.plan_count > 0 && plans.length === 0,
      plansNetSum: netSum,
      // Only meaningful when there is a breakdown to compare. A batch whose
      // rows are missing entirely is reported through plansHidden instead, so
      // the reader is not told the sum is wrong when there is no sum.
      sumMatchesTotal: plans.length === 0 || netSum === totalNet,
    });
  }

  return {
    entries,
    batchCount: batches.length,
    truncated:  batches.length === weeks,
  };
}

/** Every date this feature shows, resolved once, through the shared helpers. */
function datesFor(window: PayoutWindow, paidAt: string | null): PayoutEntryDates {
  const { firstDate, lastDate } = windowDates(window);
  return {
    payoutDate:  payoutDateFor(window),
    windowFirst: firstDate,
    windowLast:  lastDate,
    // paid_at is a TIMESTAMPTZ instant; sastDateString is the only correct way
    // to name the DAY it fell on. Formatting it anywhere downstream would read
    // the host timezone and could report the wrong day.
    paidDate:    paidAt ? sastDateString(new Date(paidAt)) : null,
  };
}

type LineWithBatch = PayoutHistoryPlanLine & { batchId: string | null };

/**
 * The plan lines behind a figure. `narrow` supplies the case-specific
 * predicate; practice_id is applied before `narrow` ever sees the builder, so
 * no predicate can drop it.
 */
async function loadLines(
  supabase:   PayoutHistorySupabase,
  practiceId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  narrow:     (q: any) => any,
): Promise<LineWithBatch[]> {
  const scoped = supabase
    .from('payouts')
    .select(`
      id, plan_id, batch_id, gross_amount, fee_amount, net_amount, created_at,
      plans(
        invoice_number, practice_reference,
        patient:profiles!plans_patient_id_fkey(first_name, last_name)
      )
    `)
    .eq('practice_id', practiceId);

  const { data } = await narrow(scoped).order('created_at', { ascending: true });

  type Patient = { first_name: string | null; last_name: string | null };
  type PlanRef  = {
    invoice_number: string | null;
    practice_reference: string | null;
    patient: Patient | Patient[] | null;
  };
  const rows = (data ?? []) as Array<{
    id: string; plan_id: string | null; batch_id: string | null;
    gross_amount: number | string; fee_amount: number | string; net_amount: number | string;
    created_at: string; plans: PlanRef | PlanRef[] | null;
  }>;

  return rows.map((r) => {
    const plan    = Array.isArray(r.plans) ? (r.plans[0] ?? null) : r.plans;
    const patient = plan && (Array.isArray(plan.patient) ? (plan.patient[0] ?? null) : plan.patient);
    return {
      payoutId:          r.id,
      planId:            r.plan_id,
      batchId:           r.batch_id,
      patientLabel:      payoutPatientLabel(patient),
      invoiceNumber:     plan?.invoice_number ?? null,
      practiceReference: plan?.practice_reference ?? null,
      grossAmount:       round2(Number(r.gross_amount)),
      feeAmount:         round2(Number(r.fee_amount)),
      netAmount:         round2(Number(r.net_amount)),
      activatedAt:       r.created_at,
    };
  });
}

/** Rands to 2dp. Sums of NUMERIC(10,2) can pick up float dust in JS. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
