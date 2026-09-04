// ─── The device-bound identifier ────────────────────────────────────────
//
// The audit asks for "a privacy-reviewed device-bound identifier". This is
// the privacy review, written down where the code is.
//
// ─── WHAT THIS IS ───────────────────────────────────────────────────────
//
// A first-party cookie holding 128 random bits that we generated. It is a
// label WE issued, not a measurement of the visitor's machine.
//
// ─── WHAT THIS IS DELIBERATELY NOT ──────────────────────────────────────
//
// Not a browser fingerprint. No canvas hashing, no font or plugin
// enumeration, no WebGL, no screen or timezone entropy, no audio context.
// Every one of those techniques identifies a person ACROSS sites they never
// consented to be linked across, cannot be cleared by the person it
// describes, and would make this a covert tracking system that happens to
// also catch fraud.
//
// The consequences of that choice are real and are accepted:
//
//   • Clearing cookies gets a new device token. So does a private window,
//     and so does a second browser on the same machine.
//   • Therefore the device dimension CANNOT be the only thing standing
//     between a ring and the platform, and the policy does not treat it that
//     way — every event that keys on device also keys on subnet, identity
//     and, where money moves, on the payment instrument.
//
// What a cheap-to-clear identifier still buys is the cost of clearing it.
// An attacker who must discard cookies between every account loses session
// continuity, has to re-solve every step-up, and cannot script the flow as
// one browser context. That is friction that scales against them and costs
// an ordinary customer nothing.
//
// ─── PROPERTIES ─────────────────────────────────────────────────────────
//
//   httpOnly   The page cannot read it, so an XSS or a malicious script in
//              the client cannot exfiltrate the device label or forge one.
//   secure     HTTPS only, outside local development.
//   sameSite   'lax' — sent on top-level navigations so a returning customer
//              is recognised, not sent on cross-site subrequests.
//   maxAge     180 days. Long enough to link the accounts a ring opens over
//              a season; short enough that the label expires on its own.
//   value      32 hex chars of crypto randomness. Carries no information
//              about the device, the person, or anything we measured.
//
// The value is HMAC'd again before it reaches the correlation store
// (lib/risk/tokens.ts), so a leak of risk_observations does not yield a
// cookie value that could be replanted in someone's browser.

import { randomBytes } from 'node:crypto';

export const DEVICE_COOKIE = 'hnpl_dv';
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/** The retention statement the privacy notice and the ROPA both cite. */
export const DEVICE_IDENTIFIER_PURPOSE =
  'Fraud and automated-abuse prevention. A random first-party identifier we ' +
  'issue; no device characteristics are measured or stored. Correlation ' +
  'records derived from it are deleted after 90 days.';

export function newDeviceId(): string {
  return randomBytes(16).toString('hex');
}

/** A value we could have issued. Anything else is discarded rather than
 *  stored — an attacker-chosen cookie is an attacker-chosen correlation key,
 *  and a long or structured one would let them write into the graph. */
export function isWellFormedDeviceId(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

type CookieJar = {
  get(name: string): { value?: string } | undefined;
  set(options: Record<string, unknown>): void;
};

/**
 * The device id for this request, minting and setting one if absent.
 *
 * Resolves `next/headers` through a dynamic import inside a try/catch for
 * the same two reasons lib/security/rateLimit.ts documents for `clientIp`:
 * the failure mode is "no signal" rather than an exception on a live
 * surface, and a static import would make `next/headers` a hard dependency
 * of every test of every action that takes a risk decision.
 *
 * Returns null when there is no cookie store to read (a route that runs
 * outside a request, a cron job). The device rules then skip, which is
 * correct — a background job has no device.
 *
 * ─── ON WRITING A COOKIE FROM A READ ────────────────────────────────────
 *
 * Server Components cannot set cookies; only actions and route handlers
 * can. `cookies().set` throws in the former, and that throw is caught and
 * swallowed here: the request still gets a device id for its own decision,
 * it just is not persisted, and the next action-driven request mints and
 * stores one. Failing the request instead would make every risk-evaluated
 * page render an error.
 */
export async function resolveDeviceId(): Promise<string | null> {
  let jar: CookieJar;
  try {
    const { cookies } = await import('next/headers');
    jar = (await cookies()) as unknown as CookieJar;
  } catch {
    return null;
  }

  try {
    const existing = jar.get(DEVICE_COOKIE)?.value;
    if (isWellFormedDeviceId(existing)) return existing!;
  } catch {
    return null;
  }

  const minted = newDeviceId();
  try {
    jar.set({
      name: DEVICE_COOKIE,
      value: minted,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
    });
  } catch {
    // A Server Component render. See the header — the id is still returned
    // and used for this decision; persisting it is the next request's job.
  }
  return minted;
}
