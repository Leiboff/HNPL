// ─── Reading the current request's identity signals ───────────────────────
//
// Split out of lib/security/identitySignals.ts on purpose. That module is
// imported by proxy.ts, which runs before the App Router request context
// exists — a static `import { headers } from 'next/headers'` in it would
// break the proxy outright. The dynamic imports below follow the convention
// lib/security/rateLimit.ts already set, and for the same second reason:
// several server-action suites mock next/headers with only the export they
// need, so a hard dependency here would turn "this action now collects
// signals" into a screenful of unrelated red tests.
//
// Everything is best-effort. A signal we could not read is a gap in
// tomorrow's link graph, never a reason to fail the request in front of us.

import { DEVICE_COOKIE, isValidDeviceId, type RawSignals } from './identitySignals';

/** The device id proxy.ts minted, or null if this browser has not got one. */
export async function deviceIdFromCookies(): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers');
    const value = (await cookies()).get(DEVICE_COOKIE)?.value ?? null;
    // Validate rather than trust: the cookie is httpOnly, but httpOnly is a
    // browser-side promise and this is the server side of it.
    return isValidDeviceId(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The two signals that are available on any authenticated request, without
 * the caller having to pass anything. `card` and `phone` are supplied by
 * their own call sites, which are the only places that know them.
 */
export async function requestSignals(extra: RawSignals = {}): Promise<RawSignals> {
  const { clientIp } = await import('./rateLimit');
  const [device, ip] = await Promise.all([deviceIdFromCookies(), clientIp()]);
  return { device, ip, ...extra };
}
