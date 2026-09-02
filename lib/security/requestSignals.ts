// SERVER-ONLY. Never import in a client component.
//
// ─── Assembling one request's correlation context ───────────────────────
//
// The three doors onto credit (acceptPlan, payWithSavedCard,
// initiateCheckout) each need to hand claimCreditForPlan a RingContext.
// Building it by hand at each site is how three doors drift apart — audit
// A-05's finding, and the reason claimCredit exists as one function at all
// — so it is built here, once.
//
// WHAT IT GATHERS
//
//   device  — the httpOnly cookie minted in proxy.ts
//   ip      — the proxy header, via the same helper the rate limiter uses
//   email   — from profiles, alias-normalised downstream
//   phone   — from profiles
//   card    — passed by the caller when a card is in hand; absent otherwise
//
// and the applicant's sa_id_lookup_hash, which is what makes the
// assessment about an IDENTITY rather than an account.
//
// NEVER THROWS. A gatherer that can throw is a fraud control that can take
// down checkout. Every failure degrades to a context with fewer signals,
// and fewer signals means a quieter assessment — never a louder one, since
// every rule in identityGraph.ts only ever adds score for a link it can
// actually see.

import { cookies, headers } from 'next/headers';
import { clientIpFrom } from './rateLimit';
import { DEVICE_COOKIE, isWellFormedDeviceId } from './deviceCookie';
import type { RawSignals } from './identitySignals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export type RingContextResult = {
  identityHash: string | null;
  signals:      RawSignals;
};

/** The device id this browser is carrying, or null. */
export async function requestDeviceId(): Promise<string | null> {
  try {
    const value = (await cookies()).get(DEVICE_COOKIE)?.value;
    return isWellFormedDeviceId(value) ? value! : null;
  } catch {
    return null;
  }
}

/** The client IP for this request, or null. */
export async function requestIp(): Promise<string | null> {
  try {
    return clientIpFrom(await headers());
  } catch {
    return null;
  }
}

/**
 * Everything this request reveals about who is asking, ready to hand to
 * claimCreditForPlan as `ring`.
 *
 * `cardFingerprint` is payment_methods.signature — the synthetic
 * brand:last4:expiry value from saveCardForPatient, since Peach exposes no
 * issuer fingerprint. It survives an attacker re-entering the same card
 * under a different name, but it can also collide between strangers; see
 * the caveat on the 'card' key in identityGraph.ts for why that shapes its
 * allowance rather than disqualifying it.
 */
export async function buildRingContext(
  svc: Svc,
  patientId: string,
  extra: { cardFingerprint?: string | null } = {},
): Promise<RingContextResult> {
  const [deviceId, ip] = await Promise.all([requestDeviceId(), requestIp()]);

  let identityHash: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;

  try {
    const { data } = await svc
      .from('profiles')
      .select('sa_id_lookup_hash, email, phone')
      .eq('id', patientId)
      .maybeSingle();
    if (data) {
      identityHash = (data.sa_id_lookup_hash as string | null) ?? null;
      email        = (data.email as string | null) ?? null;
      phone        = (data.phone as string | null) ?? null;
    }
  } catch {
    // Degrade to the request-scoped signals alone. See the never-throws
    // note above.
  }

  return {
    identityHash,
    signals: {
      deviceId,
      ip,
      email,
      phone,
      cardFingerprint: extra.cardFingerprint ?? null,
    },
  };
}
