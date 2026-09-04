// ─── Getting the risk queue in front of a person ────────────────────────
//
// The controls in 0142 record everything and hold what they should. None of
// that reaches anybody unless somebody happens to open /admin/risk, and the
// audit is explicit that operational response is half the control. This is
// the other half: one email, to the platform's admin address, carrying
// everything nobody has been told about yet.
//
// ─── WHY A DIGEST AND NOT AN EMAIL PER EVENT ────────────────────────────
//
// Because a fraud ring generates its findings in bursts, by construction. A
// script working through a list of leaked SA IDs trips the duplicate-identity
// rule on every one of them; one email each would be four hundred emails in
// ten minutes, and the fifth would already have been filtered to a folder
// nobody reads. The batch is not a compromise on latency — it is what keeps
// the channel worth having.
//
// The cadence is every fifteen minutes (vercel.json). What that buys, and
// what it costs:
//
//   • Nothing waits on it. `evaluateRisk` is on the hot path of signup,
//     checkout and plan acceptance; sending mail from there would put an
//     8-second network timeout in front of a customer's payment.
//   • The decision has ALREADY been enforced by the time this runs. The
//     ring was refused, the plan was held, the payout was stopped — the
//     email exists to get a human to look, not to stop anything. A
//     quarter-hour on that is not a risk.
//
// ─── AND WHY IT IS EXACTLY-ONCE ─────────────────────────────────────────
//
// 0143's `claim_risk_notifications` stamps and returns in one statement, so
// two overlapping runs cannot both send the same batch. Waking somebody
// twice at 03:00 is how an alert channel gets muted, and a muted channel is
// strictly worse than no channel — it looks like coverage and provides
// none.

import { sendEmail } from '@/lib/email/resend';
import { alertsFor, type RiskAlert } from './alerts';
import type { RiskReason } from './evaluate';
import { dailyBudgetLimit } from './policy';
import { RISK_BUDGETS, type RiskBudget, type RiskEvent } from './vocabulary';

/**
 * Where the digest goes.
 *
 * `RISK_ALERT_EMAIL` first so fraud alerts can be routed somewhere
 * different from practice-signup notifications if that is ever wanted, then
 * the existing platform admin address, then the constant. The constant is
 * the point: unlike `notifyAdminOfPracticeSignup`, which skips the send when
 * its env var is missing, a fraud digest must not be silently dropped
 * because nobody set a variable. A missed practice signup is a delayed
 * approval; a missed duplicate-identity page is a loss.
 */
export const DEFAULT_RISK_ALERT_EMAIL = 'admin@betternow.co.za';

export function riskAlertRecipient(): string {
  return (
    process.env.RISK_ALERT_EMAIL?.trim() ||
    process.env.ADMIN_NOTIFICATION_EMAIL?.trim() ||
    DEFAULT_RISK_ALERT_EMAIL
  );
}

// ─── The claim payload ──────────────────────────────────────────────────

export type ClaimedReview = {
  id: string;
  event: string;
  state: string;
  account_id: string | null;
  practice_id: string | null;
  score: number;
  hit_count: number;
  opened_at: string;
  reasons: Array<Record<string, unknown>> | null;
};

export type ClaimedEvent = {
  id: string;
  event: string;
  decision: string;
  score: number;
  reasons: Array<Record<string, unknown>> | null;
  account_id: string | null;
  practice_id: string | null;
  occurred_at: string;
};

export type ClaimedSwitch = { name: string; reason: string | null; changed_at: string };
export type ClaimedBudget = { budget: string; consumed: number | string };

export type RiskNotificationClaim = {
  reviews: ClaimedReview[];
  events: ClaimedEvent[];
  switches: ClaimedSwitch[];
  budgets: ClaimedBudget[];
};

export type BudgetPressure = {
  budget: RiskBudget;
  consumed: number;
  limit: number;
  /** 0-1. Reported from 80% so an operator sees a ceiling coming rather
   *  than only learning about it once customers are being refused. */
  fraction: number;
};

export const BUDGET_WARN_FRACTION = 0.8;

/**
 * Which budgets are close to or past their ceiling.
 *
 * The limits live in lib/risk/policy.ts and the consumption lives in the
 * database, so this is the one place the two meet. Kept pure so the
 * threshold arithmetic is testable without a database or a mailbox.
 */
export function budgetPressure(budgets: ClaimedBudget[]): BudgetPressure[] {
  const out: BudgetPressure[] = [];
  for (const row of budgets) {
    if (!(RISK_BUDGETS as readonly string[]).includes(row.budget)) continue;
    const budget = row.budget as RiskBudget;
    const consumed = Number(row.consumed);
    const limit = dailyBudgetLimit(budget);
    if (!Number.isFinite(consumed) || limit <= 0) continue;
    const fraction = consumed / limit;
    if (fraction >= BUDGET_WARN_FRACTION) {
      out.push({ budget, consumed, limit, fraction });
    }
  }
  return out.sort((a, b) => b.fraction - a.fraction);
}

// ─── Severity ───────────────────────────────────────────────────────────

export type DigestSeverity = 'urgent' | 'routine';

/**
 * How the subject line reads.
 *
 * `urgent` is reserved for the things that mean money or vendor spend has
 * ALREADY been cut off platform-wide, or that a ring is confirmed rather
 * than suspected: an engaged kill switch, an exhausted budget, a
 * page-severity finding (duplicate identity, duplicate instrument), or the
 * controls being unable to decide at all.
 *
 * Everything else is routine, and that restraint is the whole design. A
 * subject line that shouts on a busy dental practice trains the reader to
 * stop looking, and then the duplicate-identity page arrives in a mailbox
 * nobody reads carefully.
 */
export function digestSeverity(input: {
  switches: ClaimedSwitch[];
  pressure: BudgetPressure[];
  alerts: RiskAlert[];
}): DigestSeverity {
  if (input.switches.length > 0) return 'urgent';
  if (input.pressure.some((p) => p.fraction >= 1)) return 'urgent';
  if (input.alerts.some((a) => a.severity === 'page')) return 'urgent';
  return 'routine';
}

/** Every alert the claimed decisions imply, deduplicated by name. */
export function alertsForClaim(events: ClaimedEvent[]): RiskAlert[] {
  const seen = new Map<string, RiskAlert>();
  for (const row of events) {
    // The rows come back from Postgres as loose JSON. `rule` is written by
    // 0142 on every reason it emits, so the cast is a statement about the
    // producer rather than a hope about the data — and `classifyReason`
    // falls back to 'other' on anything it does not recognise.
    const reasons = (row.reasons ?? []) as RiskReason[];
    for (const alert of alertsFor(row.event as RiskEvent, reasons)) {
      const existing = seen.get(alert.name);
      if (!existing || (existing.severity === 'ticket' && alert.severity === 'page')) {
        seen.set(alert.name, alert);
      }
    }
  }
  return [...seen.values()];
}

// ─── The email ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rand(n: number): string {
  return `R${n.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;
}

function humanise(s: string): string {
  const words = s.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One reason, as a sentence.
 *
 * Mirrors `describeReason` in app/admin/risk/RiskControls.tsx — the email
 * and the queue must describe the same finding the same way, or a reviewer
 * reading both thinks they are looking at two things.
 *
 * NO TOKEN IS EVER RENDERED, here or on the page. The tokens are keyed
 * hashes (lib/risk/tokens.ts); putting one in an email would move the
 * correlation graph into a mailbox and a mail provider's logs, with none of
 * the retention controls that make the real store defensible.
 */
export function describeReasonLine(reason: Record<string, unknown>): string {
  const rule = String(reason.rule ?? '');
  if (rule === 'kill_switch') return `The "${reason.switch}" kill switch is engaged.`;
  if (rule === 'budget')      return `The daily "${reason.budget}" budget is exhausted.`;
  if (rule === 'block')       return `A standing block applies: ${reason.reason ?? 'no reason recorded'}.`;
  if (rule === 'dependency_unavailable') return 'The risk controls could not be reached, so the request was refused.';
  if (rule === 'circuit_breaker') return `The practice circuit breaker tripped: ${reason.reason ?? 'no reason recorded'}.`;

  const noun = humanise(rule).toLowerCase();
  if (reason.metric === 'accounts') {
    return `The same ${noun} has been used by ${reason.observed} accounts (limit ${reason.threshold}).`;
  }
  return `This ${noun} was seen ${reason.observed} times (limit ${reason.threshold}).`;
}

export type DigestContent = { subject: string; html: string; severity: DigestSeverity };

/**
 * Build the digest. Pure — no send, no database, so the copy and the
 * severity are testable without either.
 *
 * Returns null when there is nothing to say. A monitor that emails "all
 * clear" every fifteen minutes is a monitor whose mail rule gets written on
 * day two, taking the real alerts with it.
 */
export function buildRiskDigest(claim: RiskNotificationClaim): DigestContent | null {
  const pressure = budgetPressure(claim.budgets);
  const alerts   = alertsForClaim(claim.events);

  const nothing =
    claim.reviews.length === 0 &&
    claim.events.length === 0 &&
    claim.switches.length === 0 &&
    pressure.length === 0;
  if (nothing) return null;

  const severity = digestSeverity({ switches: claim.switches, pressure, alerts });
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const queueLink = `${appUrl}/admin/risk`;

  const headline =
    claim.reviews.length > 0
      ? `${claim.reviews.length} held for review`
      : claim.switches.length > 0
        ? 'Platform stop engaged'
        : pressure.some((p) => p.fraction >= 1)
          ? 'Daily budget exhausted'
          : `${claim.events.length} risk decision${claim.events.length === 1 ? '' : 's'}`;

  const subject = `${severity === 'urgent' ? '[URGENT] ' : ''}BetterNow risk: ${headline}`;

  const sections: string[] = [];

  if (claim.switches.length > 0) {
    sections.push(`
      <div style="border:1px solid #f3b0aa;background:#fdf2f1;border-radius:8px;padding:12px 14px;margin:0 0 16px;">
        <p style="margin:0 0 6px;font-weight:600;color:#8A2B22;">Kill switches engaged — customers are being refused right now</p>
        <ul style="margin:0;padding-left:18px;color:#8A2B22;">
          ${claim.switches.map((s) => `<li>${escapeHtml(humanise(s.name))}${s.reason ? ` — ${escapeHtml(s.reason)}` : ''}</li>`).join('')}
        </ul>
      </div>`);
  }

  if (pressure.length > 0) {
    sections.push(`
      <div style="border:1px solid #f0d7a8;background:#fdf8ef;border-radius:8px;padding:12px 14px;margin:0 0 16px;">
        <p style="margin:0 0 6px;font-weight:600;color:#7a5b12;">Daily budgets</p>
        <ul style="margin:0;padding-left:18px;color:#7a5b12;">
          ${pressure.map((p) => `<li>${escapeHtml(humanise(p.budget))}: ${
            p.budget === 'payout' || p.budget === 'approved_credit'
              ? `${rand(p.consumed)} of ${rand(p.limit)}`
              : `${p.consumed} of ${p.limit}`
          } (${Math.round(p.fraction * 100)}%)${p.fraction >= 1 ? ' — exhausted, requests are being refused' : ''}</li>`).join('')}
        </ul>
      </div>`);
  }

  if (claim.reviews.length > 0) {
    sections.push(`
      <p style="margin:0 0 8px;font-weight:600;">Held for review</p>
      <ul style="margin:0 0 16px;padding-left:18px;">
        ${claim.reviews.slice(0, 25).map((r) => `
          <li style="margin:0 0 8px;">
            <strong>${escapeHtml(humanise(r.event))}</strong>
            — ${r.account_id ? 'customer' : r.practice_id ? 'practice' : 'unattached'}, score ${r.score}${
              r.hit_count > 1 ? `, hit ${r.hit_count} times` : ''}
            <br/>
            <span style="color:#4b5563;">${(r.reasons ?? []).map((x) => escapeHtml(describeReasonLine(x))).join(' ')}</span>
          </li>`).join('')}
      </ul>
      ${claim.reviews.length > 25 ? `<p style="margin:0 0 16px;color:#6b7280;">…and ${claim.reviews.length - 25} more on the queue.</p>` : ''}`);
  }

  if (alerts.length > 0) {
    sections.push(`
      <p style="margin:0 0 8px;font-weight:600;">What fired</p>
      <ul style="margin:0 0 16px;padding-left:18px;">
        ${alerts.map((a) => `<li>${escapeHtml(humanise(a.name))}${a.severity === 'page' ? ' <strong>(page)</strong>' : ''}</li>`).join('')}
      </ul>`);
  }

  if (claim.events.length > 0) {
    const denied = claim.events.filter((e) => e.decision === 'deny').length;
    const held   = claim.events.filter((e) => e.decision === 'review').length;
    sections.push(`
      <p style="margin:0 0 16px;color:#4b5563;">
        ${claim.events.length} decision${claim.events.length === 1 ? '' : 's'} in this window
        — ${denied} refused, ${held} held.
      </p>`);
  }

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#13294B;max-width:600px;">
      <h2 style="margin:0 0 16px;">Risk: ${escapeHtml(headline)}</h2>
      ${sections.join('')}
      <p style="margin:0 0 24px;">
        <a href="${queueLink}" style="display:inline-block;background:#15A89E;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">
          Open the risk queue →
        </a>
      </p>
      <p style="margin:0;color:#6b7280;font-size:12px;">
        BetterNow risk notification. Sent because the aggregate fraud controls held
        something or a platform limit moved. Thresholds are in lib/risk/policy.ts;
        the runbook is docs/FRAUD-RISK-OPERATIONS.md. This address is unmonitored —
        act on the queue, not on a reply.
      </p>
    </div>`;

  return { subject, html, severity };
}

export type DigestSendResult =
  | { sent: true; severity: DigestSeverity; recipient: string }
  | { sent: false; reason: 'nothing_to_report' }
  | { sent: false; reason: 'send_failed'; error: string };

/** Build and send. Never throws — the caller is a cron job whose other work
 *  must not be lost to a mail failure. */
export async function sendRiskDigest(
  claim: RiskNotificationClaim,
): Promise<DigestSendResult> {
  const digest = buildRiskDigest(claim);
  if (!digest) return { sent: false, reason: 'nothing_to_report' };

  const recipient = riskAlertRecipient();
  const result = await sendEmail({
    to: recipient,
    subject: digest.subject,
    html: digest.html,
  });

  if (!result.ok) {
    // Loud: this is the failure mode where the controls are working, the
    // queue is filling, and nobody is being told.
    console.error(JSON.stringify({
      event: 'risk_digest_send_failed',
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      severity: digest.severity,
      reviews: claim.reviews.length,
      decisions: claim.events.length,
      error: result.error,
    }));
    return { sent: false, reason: 'send_failed', error: result.error };
  }

  console.warn(JSON.stringify({
    event: 'risk_digest_sent',
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    severity: digest.severity,
    reviews: claim.reviews.length,
    decisions: claim.events.length,
  }));

  return { sent: true, severity: digest.severity, recipient };
}
