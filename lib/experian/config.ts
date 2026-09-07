import type { ExperianConfig, ExperianEnv } from './client';

// ─── Experian credentials and tunables ─────────────────────────────────
//
// Same shape as lib/datanamix/client.ts and lib/payments/peach/client.ts: a
// module-private requireEnv, read lazily at call time, throwing on a missing
// secret. Deliberately NOT a central config module — three integrations
// already do it this way, and inventing a fourth pattern for the fourth
// integration is how a convention stops being one.
//
// Lazily, not at module load, for the reason every other integration does it:
// importing this file must not throw in an environment that never calls
// Experian. Tests, the build, and every unrelated route import lib/underwriting
// transitively.
//
//   EXPERIAN_USERNAME  — pUsername. Required.
//   EXPERIAN_PASSWORD  — pPassword. Required. Travels in the SOAP body in
//                        CLEARTEXT; see the warning in ./client.ts.
//   EXPERIAN_ORIGIN    — pMyOrigin, max 30. Defaults to 'BetterNow' so
//                        Experian-side logs are attributable to us.
//   EXPERIAN_ENV       — 'uat' | 'live'. Defaults to 'uat', which is the
//                        fail-safe direction: a missing variable must not
//                        silently start billing against production.
//   EXPERIAN_PVERSION  — defaults to '4.0'. See ExperianConfig.pVersion for
//                        what each version does on our branch. An env var
//                        rather than a constant because Experian activating
//                        the STS fallback is a branch-side change and should
//                        not need a deploy to pick up — or to back out of.
//   EXPERIAN_TIMEOUT_MS— defaults to 20s.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

/** The default. Changing it is a deploy; changing the env var is not. */
export const DEFAULT_P_VERSION = '4.0';

const DEFAULT_ORIGIN = 'BetterNow';

/**
 * A bureau call is one hop in a signup request that already carries an auth
 * round trip, a profile read, two rate-limit statements and a risk RPC. 20s
 * is generous for the SOAP service and still well inside the function budget.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * True when both credentials are present.
 *
 * Read by affordabilityPolicyConfigured() so the interim "no policy is wired
 * up" state is a stated fact rather than something inferred from a refusal —
 * and so the check itself never throws on an unconfigured deployment, which
 * is the whole reason this is separate from experianConfig().
 */
export function experianConfigured(): boolean {
  return !!process.env.EXPERIAN_USERNAME && !!process.env.EXPERIAN_PASSWORD;
}

/** Throws if a required credential is missing. Callers treat that as `unavailable`. */
export function experianConfig(): ExperianConfig {
  const env = (process.env.EXPERIAN_ENV ?? 'uat').trim().toLowerCase();
  if (env !== 'uat' && env !== 'live') {
    throw new Error(`EXPERIAN_ENV must be 'uat' or 'live' (got '${env}').`);
  }

  const rawTimeout = Number(process.env.EXPERIAN_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;

  return {
    env: env as ExperianEnv,
    username: requireEnv('EXPERIAN_USERNAME'),
    password: requireEnv('EXPERIAN_PASSWORD'),
    origin: (process.env.EXPERIAN_ORIGIN ?? DEFAULT_ORIGIN).trim() || DEFAULT_ORIGIN,
    pVersion: (process.env.EXPERIAN_PVERSION ?? DEFAULT_P_VERSION).trim() || DEFAULT_P_VERSION,
    timeoutMs,
  };
}
