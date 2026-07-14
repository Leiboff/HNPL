// ─── Public lead capture — per-IP rate limit (in-memory) ─────────────
//
// Lives outside any `'use server'` module because Next.js requires that
// server-action files export ONLY async functions. The action imports
// checkAndRecord() and uses it; tests import resetForTests() to isolate
// buckets between cases.
//
// State is per-instance and best-effort. Multi-instance Vercel serves
// mean an attacker on a low-QPS deploy could bypass by hitting
// different lambdas, but the intent is defence-in-depth against casual
// abuse, not a hard admission gate.

const RATE_LIMIT_MAX       = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;   // 1 h

const rateBuckets = new Map<string, number[]>();

/** Returns true if the IP is within budget (and records the hit);
 *  false if the IP has exhausted its window budget. */
export function checkAndRecord(ip: string, now: number = Date.now()): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const existing = rateBuckets.get(ip) ?? [];
  const fresh = existing.filter(t => t > cutoff);
  if (fresh.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return true;
}

export function resetForTests(): void {
  rateBuckets.clear();
}

export const PUBLIC_LEAD_RATE_LIMIT_MAX       = RATE_LIMIT_MAX;
export const PUBLIC_LEAD_RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MS;
