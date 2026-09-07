import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { experianConfig, experianConfigured, DEFAULT_P_VERSION } from './config';

// ─── Credentials and tunables ──────────────────────────────────────────
//
// The pVersion default is the interesting one. It is an env var rather than
// a constant because Experian activating the Sigma Transcend fallback is a
// change on THEIR side, and picking it up — or backing out of it — should
// not need a deploy.

const KEYS = [
  'EXPERIAN_USERNAME', 'EXPERIAN_PASSWORD', 'EXPERIAN_ORIGIN',
  'EXPERIAN_ENV', 'EXPERIAN_PVERSION', 'EXPERIAN_TIMEOUT_MS',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.EXPERIAN_USERNAME = 'u';
  process.env.EXPERIAN_PASSWORD = 'p';
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('experianConfigured', () => {
  it('is false until BOTH credentials are present', () => {
    delete process.env.EXPERIAN_PASSWORD;
    expect(experianConfigured()).toBe(false);
    process.env.EXPERIAN_PASSWORD = 'p';
    expect(experianConfigured()).toBe(true);
  });

  it('does not throw on an unconfigured deployment', () => {
    // The whole reason it is separate from experianConfig(): runCreditCheck
    // asks this question on every call, including in environments that will
    // never talk to Experian.
    delete process.env.EXPERIAN_USERNAME;
    delete process.env.EXPERIAN_PASSWORD;
    expect(() => experianConfigured()).not.toThrow();
  });
});

describe('pVersion', () => {
  it('defaults to 4.0 — the version with the Sigma Transcend fallback', () => {
    expect(DEFAULT_P_VERSION).toBe('4.0');
    expect(experianConfig().pVersion).toBe('4.0');
  });

  it('is overridable from the environment without a deploy', () => {
    process.env.EXPERIAN_PVERSION = '2.0';
    expect(experianConfig().pVersion).toBe('2.0');
  });

  it('falls back to the default on a blank value rather than sending an empty version', () => {
    // An empty pVersion returns -105 "Input version not supported", and that
    // is billable.
    process.env.EXPERIAN_PVERSION = '   ';
    expect(experianConfig().pVersion).toBe('4.0');
  });
});

describe('environment selection', () => {
  it('defaults to uat — a missing variable must not start billing production', () => {
    expect(experianConfig().env).toBe('uat');
  });

  it('accepts live explicitly', () => {
    process.env.EXPERIAN_ENV = 'live';
    expect(experianConfig().env).toBe('live');
  });

  it('refuses an unrecognised value rather than guessing which one was meant', () => {
    process.env.EXPERIAN_ENV = 'production';
    expect(() => experianConfig()).toThrow(/EXPERIAN_ENV/);
  });
});

describe('credentials', () => {
  it('throws by NAME when one is missing, never echoing a value', () => {
    delete process.env.EXPERIAN_PASSWORD;
    expect(() => experianConfig()).toThrow(/EXPERIAN_PASSWORD is not set/);
  });

  it('defaults the origin so Experian-side logs stay attributable', () => {
    expect(experianConfig().origin).toBe('BetterNow');
  });

  it('a non-numeric timeout falls back rather than becoming NaN', () => {
    // AbortSignal.timeout(NaN) would throw at call time — after the request
    // had been built, and inside the one function that must not throw with a
    // password in scope.
    process.env.EXPERIAN_TIMEOUT_MS = 'soon';
    expect(experianConfig().timeoutMs).toBe(20_000);
  });
});
