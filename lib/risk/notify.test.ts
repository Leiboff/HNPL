import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BUDGET_WARN_FRACTION,
  DEFAULT_RISK_ALERT_EMAIL,
  alertsForClaim,
  budgetPressure,
  buildRiskDigest,
  describeReasonLine,
  digestSeverity,
  riskAlertRecipient,
  sendRiskDigest,
  type ClaimedEvent,
  type ClaimedReview,
  type RiskNotificationClaim,
} from './notify';

// ─── The operator digest ────────────────────────────────────────────────────
//
// Three properties, and the second is the one that decides whether any of
// this is worth having:
//
//   IT REACHES SOMEBODY.  A default recipient, not a silent skip on a
//                         missing environment variable.
//   IT STAYS READABLE.    One email per window, no "all clear" noise, and
//                         URGENT reserved for things that mean money has
//                         already stopped. An alert channel that cries wolf
//                         gets a mail rule written against it on day two,
//                         and takes the real pages with it.
//   IT LEAKS NOTHING.     No correlation token in the subject or the body.
//                         An email lands in a mailbox and a mail provider's
//                         logs, neither of which has the 90-day retention
//                         that makes the real store defensible.

const ENV = ['RISK_ALERT_EMAIL', 'ADMIN_NOTIFICATION_EMAIL', 'NEXT_PUBLIC_APP_URL',
             'RESEND_API_KEY', 'RISK_DAILY_BUDGET_KYC'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

const emptyClaim: RiskNotificationClaim = {
  reviews: [], events: [], switches: [], budgets: [],
};

function review(over: Partial<ClaimedReview> = {}): ClaimedReview {
  return {
    id: 'rev-1',
    event: 'plan_acceptance',
    state: 'open',
    account_id: 'acct-1',
    practice_id: null,
    score: 60,
    hit_count: 1,
    opened_at: '2026-09-04T01:00:00Z',
    reasons: [{ rule: 'device', metric: 'accounts', observed: 4, threshold: 3, window_secs: 604800 }],
    ...over,
  };
}

function event(over: Partial<ClaimedEvent> = {}): ClaimedEvent {
  return {
    id: 'evt-1',
    event: 'kyc_session',
    decision: 'deny',
    score: 100,
    reasons: [{ rule: 'identity', metric: 'accounts', observed: 2, threshold: 1 }],
    account_id: 'acct-1',
    practice_id: null,
    occurred_at: '2026-09-04T01:00:00Z',
    ...over,
  };
}

describe('riskAlertRecipient', () => {
  it('defaults to the platform admin address rather than skipping the send', () => {
    // Deliberately unlike notifyAdminOfPracticeSignup, which skips when its
    // env var is missing. A missed practice signup is a delayed approval; a
    // missed duplicate-identity page is a loss.
    expect(riskAlertRecipient()).toBe(DEFAULT_RISK_ALERT_EMAIL);
    expect(DEFAULT_RISK_ALERT_EMAIL).toBe('admin@betternow.co.za');
  });

  it('prefers a dedicated risk address, then the general admin one', () => {
    process.env.ADMIN_NOTIFICATION_EMAIL = 'ops@example.com';
    expect(riskAlertRecipient()).toBe('ops@example.com');
    process.env.RISK_ALERT_EMAIL = 'fraud@example.com';
    expect(riskAlertRecipient()).toBe('fraud@example.com');
  });

  it('ignores a blank override rather than sending to an empty address', () => {
    process.env.RISK_ALERT_EMAIL = '   ';
    expect(riskAlertRecipient()).toBe(DEFAULT_RISK_ALERT_EMAIL);
  });
});

describe('budgetPressure', () => {
  it('reports nothing below the warning fraction', () => {
    // kyc default is 500.
    expect(budgetPressure([{ budget: 'kyc', consumed: 100 }])).toEqual([]);
  });

  it('reports a budget at or above 80%', () => {
    const pressure = budgetPressure([{ budget: 'kyc', consumed: 400 }]);
    expect(pressure).toHaveLength(1);
    expect(pressure[0]).toMatchObject({ budget: 'kyc', consumed: 400, limit: 500 });
    expect(pressure[0].fraction).toBeCloseTo(BUDGET_WARN_FRACTION, 5);
  });

  it('reports an exhausted budget with a fraction of at least 1', () => {
    expect(budgetPressure([{ budget: 'kyc', consumed: 500 }])[0].fraction).toBe(1);
  });

  it('honours an environment override of the ceiling', () => {
    process.env.RISK_DAILY_BUDGET_KYC = '100';
    expect(budgetPressure([{ budget: 'kyc', consumed: 90 }])[0].fraction).toBeCloseTo(0.9, 5);
  });

  it('sorts the most pressured first', () => {
    const pressure = budgetPressure([
      { budget: 'kyc', consumed: 420 },
      { budget: 'sms', consumed: 2_000 },
    ]);
    expect(pressure.map((p) => p.budget)).toEqual(['sms', 'kyc']);
  });

  it('ignores a budget name the policy does not declare', () => {
    expect(budgetPressure([{ budget: 'not_a_budget', consumed: 999_999 }])).toEqual([]);
  });

  it('ignores a non-numeric consumption rather than reporting NaN', () => {
    expect(budgetPressure([{ budget: 'kyc', consumed: 'lots' }])).toEqual([]);
  });
});

describe('digestSeverity', () => {
  it('is routine for ordinary held subjects', () => {
    // A busy practice and a shared device are tickets. Paging on them is how
    // the channel gets muted.
    expect(digestSeverity({
      switches: [], pressure: [],
      alerts: [{ name: 'duplicate_device', severity: 'ticket', event: 'signup', reason: { rule: 'device' } }],
    })).toBe('routine');
  });

  it('is urgent when a kill switch is engaged', () => {
    expect(digestSeverity({
      switches: [{ name: 'credit_issuance', reason: null, changed_at: '2026-09-04T01:00:00Z' }],
      pressure: [], alerts: [],
    })).toBe('urgent');
  });

  it('is urgent when a budget is exhausted, but not merely pressured', () => {
    const nearing = [{ budget: 'kyc' as const, consumed: 400, limit: 500, fraction: 0.8 }];
    const spent   = [{ budget: 'kyc' as const, consumed: 500, limit: 500, fraction: 1 }];
    expect(digestSeverity({ switches: [], pressure: nearing, alerts: [] })).toBe('routine');
    expect(digestSeverity({ switches: [], pressure: spent,   alerts: [] })).toBe('urgent');
  });

  it('is urgent on a page-severity finding', () => {
    expect(digestSeverity({
      switches: [], pressure: [],
      alerts: [{ name: 'duplicate_identity', severity: 'page', event: 'kyc_session', reason: { rule: 'identity' } }],
    })).toBe('urgent');
  });
});

describe('alertsForClaim', () => {
  it('de-duplicates across many decisions with the same finding', () => {
    // The case that motivates the whole digest: a ring working a list trips
    // one rule four hundred times.
    const events = Array.from({ length: 400 }, (_, i) => event({ id: `evt-${i}` }));
    const alerts = alertsForClaim(events);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe('duplicate_identity');
  });

  it('keeps a page over a ticket for the same alert name', () => {
    const alerts = alertsForClaim([
      event({ id: 'a', event: 'card_payment', reasons: [{ rule: 'card', metric: 'events', observed: 20, threshold: 12 }] }),
      event({ id: 'b', event: 'plan_acceptance', reasons: [{ rule: 'card', metric: 'accounts', observed: 4, threshold: 2 }] }),
    ]);
    expect(alerts.find((a) => a.name === 'duplicate_instrument')?.severity).toBe('page');
  });

  it('handles a decision with null reasons', () => {
    expect(alertsForClaim([event({ reasons: null })])).toEqual([]);
  });
});

describe('describeReasonLine', () => {
  it('reads as a sentence, and distinguishes accounts from volume', () => {
    expect(describeReasonLine({ rule: 'device', metric: 'accounts', observed: 4, threshold: 3 }))
      .toBe('The same device has been used by 4 accounts (limit 3).');
    expect(describeReasonLine({ rule: 'subnet', metric: 'events', observed: 40, threshold: 30 }))
      .toBe('This subnet was seen 40 times (limit 30).');
  });

  it('names the platform-level outcomes plainly', () => {
    expect(describeReasonLine({ rule: 'kill_switch', switch: 'payouts' }))
      .toContain('kill switch is engaged');
    expect(describeReasonLine({ rule: 'budget', budget: 'kyc' }))
      .toContain('budget is exhausted');
    expect(describeReasonLine({ rule: 'dependency_unavailable' }))
      .toContain('could not be reached');
  });
});

describe('buildRiskDigest', () => {
  it('returns null when there is nothing to report', () => {
    // No "all clear" email. A monitor that mails every fifteen minutes
    // regardless is a monitor whose mail rule gets written on day two,
    // taking the real alerts with it.
    expect(buildRiskDigest(emptyClaim)).toBeNull();
  });

  it('leads the subject with the held count and no URGENT for routine findings', () => {
    const digest = buildRiskDigest({ ...emptyClaim, reviews: [review()] })!;
    expect(digest.severity).toBe('routine');
    expect(digest.subject).not.toContain('URGENT');
    expect(digest.subject).toContain('1 held for review');
  });

  it('marks the subject URGENT when a kill switch is engaged', () => {
    const digest = buildRiskDigest({
      ...emptyClaim,
      switches: [{ name: 'credit_issuance', reason: 'incident', changed_at: '2026-09-04T01:00:00Z' }],
    })!;
    expect(digest.subject).toContain('[URGENT]');
    expect(digest.html).toContain('being refused right now');
  });

  it('reports an exhausted budget as refusing requests', () => {
    const digest = buildRiskDigest({ ...emptyClaim, budgets: [{ budget: 'kyc', consumed: 600 }] })!;
    expect(digest.severity).toBe('urgent');
    expect(digest.html).toContain('exhausted');
  });

  it('says what fired, in the alert vocabulary the runbook uses', () => {
    const digest = buildRiskDigest({ ...emptyClaim, events: [event()] })!;
    expect(digest.html).toContain('Duplicate identity');
    expect(digest.html).toContain('(page)');
  });

  it('caps the listed reviews and says how many more there are', () => {
    const reviews = Array.from({ length: 40 }, (_, i) => review({ id: `rev-${i}` }));
    const digest = buildRiskDigest({ ...emptyClaim, reviews })!;
    expect(digest.subject).toContain('40 held for review');
    expect(digest.html).toContain('and 15 more on the queue');
  });

  it('links to the queue', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    const digest = buildRiskDigest({ ...emptyClaim, reviews: [review()] })!;
    expect(digest.html).toContain('https://app.example.com/admin/risk');
  });

  it('never renders a correlation token', () => {
    // The reasons carried by a real decision include the dimension but
    // never the token — this pins that the digest does not start rendering
    // one if a future reason shape carries it.
    const digest = buildRiskDigest({
      ...emptyClaim,
      reviews: [review({
        reasons: [{ rule: 'device', metric: 'accounts', observed: 4, threshold: 3,
                    token: 'deadbeefdeadbeefdeadbeefdeadbeef' }],
      })],
    })!;
    expect(digest.html).not.toContain('deadbeef');
    expect(digest.subject).not.toContain('deadbeef');
  });

  it('escapes text that came from a reviewer or a breaker reason', () => {
    const digest = buildRiskDigest({
      ...emptyClaim,
      reviews: [review({ reasons: [{ rule: 'block', reason: '<script>alert(1)</script>' }] })],
    })!;
    expect(digest.html).not.toContain('<script>');
    expect(digest.html).toContain('&lt;script&gt;');
  });
});

describe('sendRiskDigest', () => {
  it('does not send when there is nothing to report', async () => {
    const result = await sendRiskDigest(emptyClaim);
    expect(result).toEqual({ sent: false, reason: 'nothing_to_report' });
  });

  it('reports a send failure loudly rather than swallowing it', async () => {
    // No RESEND_API_KEY, so sendEmail returns ok:false. This is the failure
    // mode where the controls work, the queue fills, and nobody is told.
    const result = await sendRiskDigest({ ...emptyClaim, reviews: [review()] });
    expect(result.sent).toBe(false);
    if (result.sent) return;
    expect(result.reason).toBe('send_failed');
    const line = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line.event).toBe('risk_digest_send_failed');
    expect(line.reviews).toBe(1);
  });
});
