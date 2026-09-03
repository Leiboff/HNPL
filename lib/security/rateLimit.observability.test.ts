// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeRateLimitDetailed,
  RATE_LIMIT_RPC_TIMEOUT_MS,
} from './rateLimit';

const RULE = { max: 5, windowSecs: 60 };
const ORIGINAL_HMAC_KEY = process.env.RATE_LIMIT_LOG_HMAC_KEY;

beforeEach(() => {
  process.env.RATE_LIMIT_LOG_HMAC_KEY = 'rate-limit-observability-test-key';
});

afterEach(() => {
  if (ORIGINAL_HMAC_KEY === undefined) delete process.env.RATE_LIMIT_LOG_HMAC_KEY;
  else process.env.RATE_LIMIT_LOG_HMAC_KEY = ORIGINAL_HMAC_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function loggedEvent(spy: ReturnType<typeof vi.spyOn>) {
  return JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
}

describe('rate-limit operational telemetry', () => {
  it('logs a quota denial without exposing the raw subject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { rpc: vi.fn(async () => ({ data: false, error: null })) };

    const decision = await consumeRateLimitDetailed('contact_form', 'person@example.test', RULE, client);

    expect(decision).toEqual({ allowed: false, outcome: 'limited' });
    const event = loggedEvent(warn);
    expect(event).toMatchObject({
      event: 'rate_limit_decision',
      schema_version: 1,
      bucket: 'contact_form',
      outcome: 'limited',
      subject_kind: 'account',
      limit_max: 5,
      window_seconds: 60,
    });
    expect(event.subject_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(event)).not.toContain('person@example.test');
  });

  it('distinguishes a missing enforcement subject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const decision = await consumeRateLimitDetailed('signup', null, RULE, {});

    expect(decision).toEqual({ allowed: false, outcome: 'missing_subject' });
    expect(loggedEvent(warn)).toMatchObject({
      outcome: 'missing_subject',
      subject_hash: null,
    });
  });

  it('uses a keyed fingerprint rather than a plain subject hash', async () => {
    const first = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { rpc: vi.fn(async () => ({ data: false, error: null })) };
    await consumeRateLimitDetailed('signup', '203.0.113.7', RULE, client, 'ip');
    const fingerprintA = loggedEvent(first).subject_hash;

    first.mockClear();
    process.env.RATE_LIMIT_LOG_HMAC_KEY = 'rotated-test-key';
    await consumeRateLimitDetailed('signup', '203.0.113.7', RULE, client, 'ip');

    expect(loggedEvent(first).subject_hash).not.toBe(fingerprintA);
  });

  it('logs an RPC error code but not its possibly-sensitive message', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: 'PGRST500', message: 'secret connection detail' },
      })),
    };

    const decision = await consumeRateLimitDetailed('credit_check', 'user-1', RULE, client);

    expect(decision).toEqual({ allowed: false, outcome: 'unavailable' });
    const event = loggedEvent(errorLog);
    expect(event).toMatchObject({
      outcome: 'unavailable',
      dependency_stage: 'rpc',
      dependency_code: 'PGRST500',
    });
    expect(JSON.stringify(event)).not.toContain('secret connection detail');
  });

  it('bounds a stalled limiter RPC and reports the timeout distinctly', async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { rpc: vi.fn(() => new Promise(() => {})) };

    const pending = consumeRateLimitDetailed('pay_saved_card', 'user-1', RULE, client);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RPC_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ allowed: false, outcome: 'unavailable' });
    expect(loggedEvent(errorLog)).toMatchObject({
      dependency_stage: 'rpc_timeout',
      dependency_code: 'RateLimitRpcTimeoutError',
    });
  });
});
