import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  breachesFor,
  breakerAction,
  breakerThresholds,
  evaluatePracticeBreaker,
  readPracticePosture,
  type PracticePosture,
} from './circuitBreaker';

// ─── The merchant circuit breaker ───────────────────────────────────────────
//
// The judgement is separated from the reading and from the freezing so it can
// be tested without a database and without freezing anyone — which is also
// how a monitor can report "this practice is close" without acting.
//
// The tension in this file is that a large honest practice and a mule
// merchant look identical on any ONE metric. That is why a single breach
// parks the practice for a human and two stop the money: nothing legitimate
// produces exposure AND a collapsed first-payment rate at the same time,
// while plenty of legitimate practices produce either alone.

const ENV_KEYS = [
  'RISK_PRACTICE_WINDOW_DAYS',
  'RISK_PRACTICE_MAX_EXPOSURE',
  'RISK_PRACTICE_MAX_WEEKLY_PAYOUT',
  'RISK_PRACTICE_MAX_NEW_CUSTOMERS',
  'RISK_PRACTICE_MIN_FIRST_PAYMENT_RATE',
  'RISK_PRACTICE_FIRST_PAYMENT_MIN_SAMPLE',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

const healthy: PracticePosture = {
  practiceId: 'p1',
  windowDays: 7,
  openExposure: 50_000,
  windowPayout: 40_000,
  newCustomers: 20,
  plansInWindow: 40,
  firstPaymentRate: 0.95,
};

describe('breachesFor', () => {
  it('finds nothing wrong with a busy, honest practice', () => {
    expect(breachesFor(healthy, breakerThresholds())).toEqual([]);
  });

  it('flags exposure over the ceiling', () => {
    const breaches = breachesFor({ ...healthy, openExposure: 500_000 }, breakerThresholds());
    expect(breaches).toEqual([{ metric: 'open_exposure', observed: 500_000, threshold: 400_000 }]);
  });

  it('flags a payout spike', () => {
    const breaches = breachesFor({ ...healthy, windowPayout: 400_000 }, breakerThresholds());
    expect(breaches[0].metric).toBe('window_payout');
  });

  it('flags a flood of new identities', () => {
    const breaches = breachesFor({ ...healthy, newCustomers: 200 }, breakerThresholds());
    expect(breaches[0].metric).toBe('new_customers');
  });

  it('flags a collapsed first-payment rate — the sharpest merchant signal', () => {
    // A real practice's plans almost all clear instalment 1: the patient is
    // standing at the counter with their own card. A mule merchant's do not,
    // because the cards are stolen or the customers do not exist.
    const breaches = breachesFor(
      { ...healthy, firstPaymentRate: 0.1, plansInWindow: 40 },
      breakerThresholds(),
    );
    expect(breaches[0]).toMatchObject({ metric: 'first_payment_rate', observed: 0.1 });
  });

  it('ignores the first-payment rate below the minimum sample', () => {
    // Two plans and one decline is 50%, and means nothing. Freezing a new
    // practice's money over it would be a business incident of its own.
    const breaches = breachesFor(
      { ...healthy, firstPaymentRate: 0.5, plansInWindow: 2 },
      breakerThresholds(),
    );
    expect(breaches).toEqual([]);
  });

  it('ignores a null rate — a brand-new practice is neither perfect nor failing', () => {
    const breaches = breachesFor(
      { ...healthy, firstPaymentRate: null, plansInWindow: 0 },
      breakerThresholds(),
    );
    expect(breaches).toEqual([]);
  });

  it('honours environment overrides so a ceiling can be tightened without a deploy', () => {
    process.env.RISK_PRACTICE_MAX_EXPOSURE = '10000';
    expect(breachesFor(healthy, breakerThresholds())[0].metric).toBe('open_exposure');
  });

  it('falls back to the default on a malformed override rather than freezing everyone', () => {
    process.env.RISK_PRACTICE_MAX_EXPOSURE = 'lots';
    expect(breakerThresholds().maxOpenExposure).toBe(400_000);
    expect(breachesFor(healthy, breakerThresholds())).toEqual([]);
  });
});

describe('breakerAction', () => {
  it('does nothing when nothing is breached', () => {
    expect(breakerAction([])).toBe('allow');
  });

  it('parks a single breach for a human', () => {
    // The honest large practice and the mule look identical on any one
    // metric, and freezing a real merchant's money on one number is a
    // business incident.
    expect(breakerAction([{ metric: 'open_exposure', observed: 1, threshold: 0 }])).toBe('review');
  });

  it('stops payouts on two or more at once', () => {
    // Exposure AND a collapsed first-payment rate is not a busy Tuesday.
    expect(breakerAction([
      { metric: 'open_exposure',      observed: 1, threshold: 0 },
      { metric: 'first_payment_rate', observed: 0, threshold: 1 },
    ])).toBe('deny');
  });
});

// ─── The database-facing half ───────────────────────────────────────────────

function stubClient(rpc: (name: string, args: Record<string, unknown>) => unknown) {
  return { rpc: (name: string, args: Record<string, unknown>) => rpc(name, args) };
}

describe('readPracticePosture', () => {
  it('maps the RPC payload, keeping a null rate null', () => {
    const client = stubClient(() => Promise.resolve({
      data: {
        practice_id: 'p1', window_days: 7, open_exposure: '1234.50',
        window_payout: '900', new_customers: 3, plans_in_window: 0,
        first_payment_rate: null,
      },
      error: null,
    }));
    return readPracticePosture('p1', 7, client).then((posture) => {
      expect(posture).toMatchObject({ openExposure: 1234.5, windowPayout: 900, firstPaymentRate: null });
    });
  });

  it('returns null when the posture cannot be read', async () => {
    const client = stubClient(() => Promise.resolve({ data: null, error: { code: '57014' } }));
    expect(await readPracticePosture('p1', 7, client)).toBeNull();
  });
});

describe('evaluatePracticeBreaker', () => {
  it('does nothing when the posture cannot be read', async () => {
    // Unlike a per-request decision there is no customer waiting on this
    // answer, so the safe move is to skip this pass and try again on the next
    // one. Freezing every practice because one query failed would be a worse
    // incident than the one being watched for.
    let tripped = false;
    const client = stubClient((name) => {
      if (name === 'trip_practice_circuit_breaker') tripped = true;
      return Promise.resolve({ data: null, error: { code: '57014' } });
    });
    const outcome = await evaluatePracticeBreaker('p1', { client });
    expect(outcome.tripped).toBe(false);
    expect(tripped).toBe(false);
  });

  it('does not trip a healthy practice', async () => {
    let tripped = false;
    const client = stubClient((name) => {
      if (name === 'trip_practice_circuit_breaker') { tripped = true; return Promise.resolve({ data: {}, error: null }); }
      return Promise.resolve({
        data: {
          practice_id: 'p1', window_days: 7, open_exposure: 50_000, window_payout: 40_000,
          new_customers: 20, plans_in_window: 40, first_payment_rate: 0.95,
        },
        error: null,
      });
    });
    const outcome = await evaluatePracticeBreaker('p1', { client });
    expect(outcome.tripped).toBe(false);
    expect(tripped).toBe(false);
  });

  it('trips with a reason naming every breached metric and its numbers', async () => {
    let sent: Record<string, unknown> | null = null;
    const client = stubClient((name, args) => {
      if (name === 'trip_practice_circuit_breaker') {
        sent = args;
        return Promise.resolve({ data: { ok: true, review_id: 'rev-1' }, error: null });
      }
      return Promise.resolve({
        data: {
          practice_id: 'p1', window_days: 7, open_exposure: 900_000, window_payout: 40_000,
          new_customers: 20, plans_in_window: 40, first_payment_rate: 0.05,
        },
        error: null,
      });
    });

    const outcome = await evaluatePracticeBreaker('p1', { client });
    expect(outcome.tripped).toBe(true);
    if (!outcome.tripped) return;

    // Two breaches at once, so payouts stop rather than pausing for a human.
    expect(outcome.action).toBe('deny');
    expect(outcome.reviewId).toBe('rev-1');
    expect(sent!.p_action).toBe('deny');
    // The reason a reviewer reads at 03:00 has to carry the numbers.
    expect(sent!.p_reason).toContain('open_exposure');
    expect(sent!.p_reason).toContain('first_payment_rate');
  });

  it('emits one structured line whenever it holds a practice', async () => {
    const client = stubClient((name) => {
      if (name === 'trip_practice_circuit_breaker') return Promise.resolve({ data: { ok: true }, error: null });
      return Promise.resolve({
        data: {
          practice_id: 'p1', window_days: 7, open_exposure: 900_000, window_payout: 0,
          new_customers: 0, plans_in_window: 40, first_payment_rate: 0.9,
        },
        error: null,
      });
    });
    await evaluatePracticeBreaker('p1', { client });
    const line = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line).toMatchObject({ event: 'risk_practice_breaker', practice_id: 'p1', action: 'review' });
    expect(line.breaches[0].metric).toBe('open_exposure');
  });
});
