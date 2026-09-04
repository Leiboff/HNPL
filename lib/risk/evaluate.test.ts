import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { evaluateRisk, mayProceed, refusalMessageFor, RISK_RPC_TIMEOUT_MS } from './evaluate';
import { RISK_EVENTS } from './vocabulary';

// ─── The decision path, and what it does when it cannot decide ──────────────
//
// The audit asks for "provider outages … safe fail-closed behavior". This is
// that test, and it is the most important file in the suite: a fraud control
// that quietly allows everything when its database is slow is worse than no
// control, because the dashboards stay green while the loss chain runs.
//
// `next/headers` is mocked rather than imported because these actions run
// outside a request here. lib/risk/signals.ts and lib/risk/device.ts both
// reach it through a dynamic import inside a try/catch — the same shape
// lib/security/rateLimit.ts's clientIp uses, and for the same reason — so an
// unmocked run degrades to "no ambient signals" rather than throwing.

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
  cookies: async () => ({
    get: () => ({ value: 'a'.repeat(32) }),
    set: () => {},
  }),
}));

const KEY = 'RISK_CORRELATION_HMAC_KEY';
const URL_ENV = 'NEXT_PUBLIC_SUPABASE_URL';
const SERVICE = 'SUPABASE_SERVICE_ROLE_KEY';
const savedEnv: Record<string, string | undefined> = {};

/** A Supabase-shaped stub whose single rpc() the test controls. */
function stubClient(rpc: (name: string, args: Record<string, unknown>) => unknown) {
  return { rpc: (name: string, args: Record<string, unknown>) => rpc(name, args) };
}

function allowResponse() {
  return { data: { ok: true, decision: 'allow', score: 0, reasons: [], event_id: null, review_id: null }, error: null };
}

beforeEach(() => {
  for (const key of [KEY, URL_ENV, SERVICE]) savedEnv[key] = process.env[key];
  process.env[KEY] = 'test-correlation-key';
  process.env[URL_ENV] = 'https://example.supabase.co';
  process.env[SERVICE] = 'service-key';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const key of [KEY, URL_ENV, SERVICE]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('evaluateRisk — the happy path', () => {
  it('returns allow and does not log it', async () => {
    const decision = await evaluateRisk({
      event: 'signup', email: 'person@example.com',
      client: stubClient(() => Promise.resolve(allowResponse())),
    });
    expect(decision).toMatchObject({ decision: 'allow', allowed: true, outcome: 'evaluated' });
    expect(decision.refusalMessage).toBeNull();
    // Allowed traffic is the overwhelming majority; its durable record is
    // risk_observations, and a log that is 99.9% "allow" is a log nobody
    // reads carefully enough to notice the 0.1%.
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('sends the policy rules, budgets and switches for the event', async () => {
    let sent: Record<string, unknown> | null = null;
    await evaluateRisk({
      event: 'kyc_session', accountId: 'acct-1',
      client: stubClient((_name, args) => {
        sent = args;
        return Promise.resolve(allowResponse());
      }),
    });
    expect(sent!.p_event).toBe('kyc_session');
    expect(sent!.p_switches).toContain('vendor_spend');
    expect((sent!.p_budgets as Array<{ budget: string }>)[0].budget).toBe('kyc');
    expect((sent!.p_rules as Array<{ dimension: string }>).map((r) => r.dimension))
      .toContain('identity');
  });

  it('tokenises every signal — no raw identifier reaches the RPC', async () => {
    // The privacy invariant at the boundary. Asserted on the actual payload
    // rather than trusted from tokens.ts, because this is the wire.
    let sent: Record<string, unknown> | null = null;
    await evaluateRisk({
      event: 'plan_acceptance',
      accountId: 'acct-1',
      email: 'person@example.com',
      phone: '+27821234567',
      identityHash: 'blind-index-value',
      cardFingerprint: 'peach:VISA:4242:1230',
      client: stubClient((_name, args) => {
        sent = args;
        return Promise.resolve(allowResponse());
      }),
    });
    const serialised = JSON.stringify(sent!.p_signals);
    for (const raw of ['person@example.com', '27821234567', 'blind-index-value', '4242']) {
      expect(serialised, raw).not.toContain(raw);
    }
    // …and the domain is a token too, not the readable domain.
    expect(serialised).not.toContain('example.com');
  });

  it('passes the practice id through unhashed, deliberately', async () => {
    let sent: Record<string, unknown> | null = null;
    await evaluateRisk({
      event: 'counter_session', practiceId: 'practice-1', skipDevice: true,
      client: stubClient((_name, args) => { sent = args; return Promise.resolve(allowResponse()); }),
    });
    expect((sent!.p_signals as Record<string, string>).practice).toBe('practice-1');
    expect(sent!.p_practice_id).toBe('practice-1');
  });
});

describe('evaluateRisk — refusals', () => {
  it('carries the reasons and the review id, and logs one structured line', async () => {
    const decision = await evaluateRisk({
      event: 'signup',
      client: stubClient(() => Promise.resolve({
        data: {
          ok: true, decision: 'review', score: 30,
          reasons: [{ rule: 'device', metric: 'accounts', observed: 4, threshold: 3, window_secs: 604800 }],
          event_id: 'evt-1', review_id: 'rev-1',
        },
        error: null,
      })),
    });

    expect(decision).toMatchObject({ decision: 'review', allowed: false, reviewId: 'rev-1' });
    expect(decision.refusalMessage).toBe(refusalMessageFor('review'));

    const line = JSON.parse((console.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line).toMatchObject({
      event: 'risk_decision', risk_event: 'signup', decision: 'review', review_id: 'rev-1',
    });
    expect(line.reasons[0]).toMatchObject({ rule: 'device', observed: 4, threshold: 3 });
  });

  it('never puts a correlation token in the log line', async () => {
    // A log carrying tokens re-creates the joinable store in the log
    // aggregator, with none of the retention controls that make the real one
    // defensible.
    await evaluateRisk({
      event: 'signup', email: 'person@example.com',
      client: stubClient(() => Promise.resolve({
        data: {
          ok: true, decision: 'deny', score: 100,
          reasons: [{ rule: 'block', dimension: 'device', action: 'deny', reason: 'ring' }],
          event_id: 'evt-1', review_id: null,
        },
        error: null,
      })),
    });
    const line = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(line).not.toMatch(/[0-9a-f]{32}/);
    expect(line).not.toContain('person@example.com');
  });

  it('gives review and deny different copy, and neither names a threshold', async () => {
    const review = refusalMessageFor('review')!;
    const deny   = refusalMessageFor('deny')!;
    expect(review).not.toBe(deny);
    // A review is not a refusal and must not read as one — the person may
    // well be a customer whose household shares a router.
    expect(review.toLowerCase()).toContain('check');
    // A refusal that names its rule is a tuning oracle.
    expect(deny).not.toMatch(/\d/);
    expect(review).not.toMatch(/\d/);
  });

  it('reports an unrecognised event name as its own outcome rather than as a quiet allow', async () => {
    // The vocabulary drifted. "Everything is allowed on this surface" must be
    // loud, because it is indistinguishable from a quiet day otherwise.
    const decision = await evaluateRisk({
      event: 'signup',
      client: stubClient(() => Promise.resolve({
        data: { ok: true, decision: 'allow', score: 0, reasons: [{ rule: 'unknown_event' }], event_id: null, review_id: null },
        error: null,
      })),
    });
    expect(decision.outcome).toBe('unknown_event');
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('evaluateRisk — provider outages fail closed', () => {
  it('denies on an RPC error', async () => {
    const decision = await evaluateRisk({
      event: 'plan_acceptance',
      client: stubClient(() => Promise.resolve({ data: null, error: { code: '57014' } })),
    });
    expect(decision).toMatchObject({ decision: 'deny', allowed: false, outcome: 'unavailable' });
    const line = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line).toMatchObject({ dependency_stage: 'rpc', dependency_code: '57014' });
  });

  it('denies on a thrown RPC', async () => {
    const decision = await evaluateRisk({
      event: 'card_payment',
      client: stubClient(() => Promise.reject(new Error('connection reset'))),
    });
    expect(decision.decision).toBe('deny');
    expect(decision.outcome).toBe('unavailable');
  });

  it('denies on a timeout rather than holding the action open', async () => {
    vi.useFakeTimers();
    const promise = evaluateRisk({
      event: 'kyc_session',
      client: stubClient(() => new Promise(() => {})),
    });
    await vi.advanceTimersByTimeAsync(RISK_RPC_TIMEOUT_MS + 10);
    const decision = await promise;
    vi.useRealTimers();

    expect(decision.decision).toBe('deny');
    const line = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line.dependency_stage).toBe('rpc_timeout');
  });

  it('denies on a malformed response — a response we cannot read is a decision we did not take', async () => {
    const decision = await evaluateRisk({
      event: 'payout_release',
      client: stubClient(() => Promise.resolve({ data: { surprise: true }, error: null })),
    });
    expect(decision.decision).toBe('deny');
    const line = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line.dependency_code).toBe('MalformedResponse');
  });

  it('denies when the correlation key is missing rather than running unprotected', async () => {
    // The failure that would otherwise be invisible: with no key, every token
    // is null, every rule skips, and the controls are off while every request
    // returns allow.
    delete process.env[KEY];
    delete process.env[SERVICE];
    const decision = await evaluateRisk({
      event: 'signup',
      client: stubClient(() => Promise.resolve(allowResponse())),
    });
    expect(decision.decision).toBe('deny');
    const line = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(line.dependency_stage).toBe('key');
  });

  it('never throws, on any event, whatever the client does', async () => {
    // A control that can throw is a control that takes the surface down with
    // it. Every declared event, one hostile client.
    for (const event of RISK_EVENTS) {
      const decision = await evaluateRisk({
        event,
        client: stubClient(() => { throw new Error('boom'); }),
      });
      expect(decision.decision, event).toBe('deny');
    }
  });
});

describe('mayProceed', () => {
  const base = { score: 0, reasons: [], outcome: 'evaluated' as const, eventId: null, reviewId: null, refusalMessage: null };

  it('proceeds on allow', () => {
    expect(mayProceed({ ...base, decision: 'allow', allowed: true, stepUps: [] })).toBe(true);
  });

  it('proceeds on friction where the surface has no step-up to offer', () => {
    // The audit's point about not reaching for indiscriminate CAPTCHA: a
    // surface with nothing to challenge with must not invent one, so friction
    // there is allow-and-alert and the alert is the product.
    expect(mayProceed({ ...base, decision: 'friction', allowed: false, stepUps: [] })).toBe(true);
  });

  it('does NOT proceed on friction where a step-up exists', () => {
    expect(mayProceed({ ...base, decision: 'friction', allowed: false, stepUps: ['reauth'] })).toBe(false);
  });

  it('does not proceed on review or deny', () => {
    expect(mayProceed({ ...base, decision: 'review', allowed: false, stepUps: [] })).toBe(false);
    expect(mayProceed({ ...base, decision: 'deny',   allowed: false, stepUps: [] })).toBe(false);
  });
});
