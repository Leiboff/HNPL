import { sastDateString, sastMidnight } from '@/lib/payments/payoutWindow';
import { payoutPatientLabel } from './nextPayout';

// ─── What happened at this till today ───────────────────────────────────────
//
// WHY THIS EXISTS
// ───────────────
// The product decision is that a receptionist lives in the till and never needs
// the practice dashboard. That was not true: /practice/pos renders exactly ONE
// session at a time and "Start next patient" throws it away, so the single most
// common front-desk question — "did that bill go through?", asked across the
// counter and over the phone — could only be answered on a screen the
// receptionist is not logged into.
//
// This is the read that answers it. Today, this practice, most recent first.
// Nothing else: no filtering, no search, no yesterday.
//
// IT IS NOT SESSION STATE
// ───────────────────────
// That distinction is the whole point. The till's in-progress session lives in
// CounterSessionForm's React state and is discarded by "Start next patient".
// This is a fresh read of what the DATABASE says happened today, so the reset
// cannot touch it — see app/practice/pos/TodayActivityStrip for why the
// component is mounted as a SIBLING of that form rather than inside it.
//
// AUTHORITY IS NOT DECIDED HERE
// ─────────────────────────────
// The till has no Supabase user session — it authenticates with a device secret
// plus a PIN, so RLS keyed on auth.uid() does not apply to it and
// checkout_sessions' own practice_biller_select policy can never match. The
// caller (getTodaysCounterSessions in app/practice/pos/actions.ts) proves
// authority through requireUnlockedDevice, exactly like every other till
// action, and passes in the practice_id THAT call resolved. This module makes no
// authority decision of its own and must never be handed a practice id from a
// client.
//
// The .eq('practice_id', …) below is applied unconditionally, in one place, for
// the same reason lib/practice/nextPayout.ts applies its own that way: there is
// then no code path through this module that reads a session row without it.
//
// WHERE EACH FIELD COMES FROM, AND WHY A PLANS JOIN IS UNAVOIDABLE
// ────────────────────────────────────────────────────────────────
// checkout_sessions (0085) carries the OUTCOME but not much else that a human
// can read:
//   • stage        — created / scanned / completed / declined / expired. This
//                    alone is enough to classify the outcome; no plan status is
//                    consulted for it.
//   • sa_id_number — ENCRYPTED, and an SA ID is the last thing that should
//                    appear on a screen the next patient in the queue is
//                    standing in front of. Never read here.
//   • no amount at all.
//
// So the amount (plans.total_amount), the invoice number, and the patient's name
// (plans.patient_id → profiles) all require the join. It is not an optimisation
// choice — the row simply does not contain them.
//
// A CONSEQUENCE WORTH STATING: plans.patient_id is NULL until the phone-side
// checkout resolves who is paying, so a session that is still in progress or was
// abandoned has NO patient name to show, ever. The label falls back to the
// invoice number, which is what a practice quotes anyway.

/**
 * Loose structural type, same reason as lib/practice/tradingGate.ts: naming
 * Supabase's generic builder makes TypeScript report "type instantiation is
 * excessively deep" at the call sites. Always the service-role client here —
 * there is no user session in the till path to drive RLS with.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TillActivitySupabase = any;

/** The stage values 0085's CHECK constraint allows. */
export type TillSessionStage = 'created' | 'scanned' | 'completed' | 'declined' | 'expired';

/**
 * Three buckets, because three is what a receptionist can scan while somebody
 * waits: the money arrived, it hasn't yet, or it isn't going to.
 *
 *   done     stage='completed' — the patient finished checkout on their phone.
 *   pending  created / scanned — the QR is out and nothing has resolved.
 *   stopped  declined / expired — no money, and this session will not produce
 *            any. Whether it timed out or the teller moved on is a distinction
 *            the ROW keeps (see `stage`) and the strip prints, but it is the
 *            same answer to "did it go through?", so it is one bucket.
 */
export type TillSessionOutcome = 'done' | 'pending' | 'stopped';

export type TillSessionRow = {
  sessionId: string;
  /** Raw stage, kept so the UI can name expired vs declined precisely. */
  stage:     TillSessionStage;
  outcome:   TillSessionOutcome;
  /** plans.total_amount, in rands. Formatted by the caller, never here. */
  amount:    number | null;
  /**
   * What to call this session on a shared screen.
   *
   * "Thabo M." via payoutPatientLabel when a patient is attached — the same
   * rule every other money surface in the app follows, and a till is the LAST
   * place to print more of a name than the payouts tab does, because the next
   * patient in the queue can read it. Falls back to the invoice number (no
   * patient exists yet on an unresolved session) and then to a dash.
   */
  label:         string;
  invoiceNumber: string | null;
  /** True when `label` IS the invoice number, so the UI does not print it twice. */
  labelIsInvoice: boolean;
};

export type TillActivity = {
  sessions: TillSessionRow[];
  /** Counts across the whole day, for the strip's one-line summary. */
  doneCount:    number;
  pendingCount: number;
  stoppedCount: number;
  /** The SAST calendar date this covers, for the caller to state plainly. */
  sastDate: string;
  /** True when the day held more sessions than the cap — stated, never silent. */
  truncated: boolean;
};

/**
 * A busy front desk does not do forty counter checkouts a day, so this is a
 * runaway guard rather than pagination. It is reported (see `truncated`) because
 * a list that silently stops is a list that lies about the day.
 */
export const TILL_ACTIVITY_LIMIT = 40;

const STAGE_OUTCOME: Record<TillSessionStage, TillSessionOutcome> = {
  completed: 'done',
  created:   'pending',
  scanned:   'pending',
  declined:  'stopped',
  expired:   'stopped',
};

type PatientRef = { first_name: string | null; last_name: string | null };
type PlanRef = {
  total_amount:   number | string | null;
  invoice_number: string | null;
  patient:        PatientRef | PatientRef[] | null;
};

/**
 * Today's counter sessions for one practice.
 *
 * @param supabase   service-role client
 * @param practiceId resolved by requireUnlockedDevice — NEVER from a client
 * @param now        injectable clock, so the SAST day boundary is testable AT
 *                   the boundary instant rather than approximately
 */
export async function resolveTodaysTillActivity(
  supabase:   TillActivitySupabase,
  practiceId: string,
  now:        Date = new Date(),
  limit:      number = TILL_ACTIVITY_LIMIT,
): Promise<TillActivity> {
  // "Today" is the practice's own SAST calendar day, and both halves of that
  // come from lib/payments/payoutWindow — the module that exists because
  // formatting or bucketing a SAST instant with host-timezone maths silently
  // names the wrong DAY. sastDateString gives the date; sastMidnight turns it
  // back into an unambiguous instant via an explicit +02:00 offset.
  //
  // Note there is deliberately NO upper bound. A session cannot be created in
  // the future, so ">= today's SAST midnight" already IS "today" — and adding
  // an end boundary would mean stepping a day forward, which is exactly the
  // date arithmetic this module is not allowed to invent.
  const sastDate = sastDateString(now);
  const dayStart = sastMidnight(sastDate);

  const { data } = await supabase
    .from('checkout_sessions')
    .select(`
      id, stage, created_at,
      plans(
        total_amount,
        invoice_number,
        patient:profiles!plans_patient_id_fkey(first_name, last_name)
      )
    `)
    .eq('practice_id', practiceId)
    .gte('created_at', dayStart.toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as Array<{
    id: string; stage: string; created_at: string; plans: PlanRef | PlanRef[] | null;
  }>;

  const sessions: TillSessionRow[] = rows.map((r) => {
    const plan    = Array.isArray(r.plans) ? (r.plans[0] ?? null) : r.plans;
    const patient = plan && (Array.isArray(plan.patient) ? (plan.patient[0] ?? null) : plan.patient);
    const stage   = r.stage as TillSessionStage;

    const invoiceNumber = plan?.invoice_number ?? null;
    // payoutPatientLabel returns '—' when there is no first name, which is also
    // what a not-yet-resolved session looks like. Treated as "no label yet" so
    // the invoice number can take over rather than showing a bare dash.
    const patientLabel  = payoutPatientLabel(patient ?? null);
    const hasPatient    = patientLabel !== '—';
    const label         = hasPatient ? patientLabel : (invoiceNumber ?? '—');

    return {
      sessionId: r.id,
      stage,
      // Unknown stages fall to 'pending' rather than 'done': the failure a
      // receptionist must never see is a session reported as paid when the
      // product does not actually know that it was.
      outcome:   STAGE_OUTCOME[stage] ?? 'pending',
      amount:    plan?.total_amount != null ? Number(plan.total_amount) : null,
      label,
      invoiceNumber,
      labelIsInvoice: !hasPatient && invoiceNumber != null,
    };
  });

  return {
    sessions,
    doneCount:    sessions.filter((s) => s.outcome === 'done').length,
    pendingCount: sessions.filter((s) => s.outcome === 'pending').length,
    stoppedCount: sessions.filter((s) => s.outcome === 'stopped').length,
    sastDate,
    truncated: rows.length === limit,
  };
}
