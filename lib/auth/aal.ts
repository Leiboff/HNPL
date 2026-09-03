/**
 * Authenticator Assurance Level (AAL2) enforcement for privileged operations.
 *
 * ─── WHAT THIS EXISTS TO STOP ─────────────────────────────────────────
 *
 * Server-side RBAC answers "is this account allowed to do this?". It does
 * not answer "is this really the account holder?". A stolen admin session
 * passes every RBAC check in this repo, because from the server's point of
 * view it IS the admin — same user id, same `profiles.role = 'admin'`, same
 * everything. The guard in this file is the layer that asks the second
 * question, and it asks it of the SESSION rather than of the account:
 * a second factor must have been presented, recently, in THIS session.
 *
 * That matters most against the exact threat lib/auth/sessionCap.ts
 * documents at length: the @supabase/ssr auth cookie is `httpOnly: false`
 * by design (the browser client has to read it), so an XSS steals a
 * refresh token, not merely an access token. The session cap bounds how
 * long that token stays useful. This bounds what it can DO while it is.
 *
 * ─── WHY THE LIBRARY CALL IS NOT ENOUGH ON ITS OWN ────────────────────
 *
 * This is the finding that shaped the whole module, so it is recorded
 * where the code that works around it lives.
 *
 * `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` reads
 * `payload.aal` and `payload.amr` from a LOCAL, SIGNATURE-UNVERIFIED
 * decode of the access token. Read the shipped implementation
 * (@supabase/auth-js 2.106.0, GoTrueClient.js `_getAuthenticatorAssuranceLevel`):
 *
 *   • The zero-argument form calls `getSession()` — which is the cookie,
 *     and the cookie is attacker-writable — then `decodeJWT()`s it. No
 *     signature check happens anywhere on that path.
 *   • The one-argument form does make a `getUser(jwt)` round trip, but
 *     only to enumerate verified factors for `nextLevel`. `currentLevel`
 *     and `currentAuthenticationMethods` still come from the unverified
 *     local decode.
 *
 * So calling it and trusting the answer would mean a forged cookie
 * decides whether the guard opens — which is the attack, not the defence.
 * `aal: "aal2"` and a fresh `amr` timestamp are two string edits away in
 * a JS-readable cookie.
 *
 * The composition below is therefore mandatory, not stylistic:
 *
 *   1. getRequestUser()  — the existing memoised `auth.getUser()` round
 *                          trip (lib/auth/requestUser.ts). The auth
 *                          server validates the JWT. If this returns a
 *                          user, the token in the cookie is genuine and
 *                          unexpired. Costs nothing extra on any page
 *                          that already ran the authority prelude.
 *   2. auth.getClaims()  — VERIFIED claims. Asymmetric keys verify
 *                          locally via WebCrypto; a symmetric secret
 *                          round-trips to the auth server. Either way the
 *                          signature is checked before we see `aal`/`amr`.
 *   3. mfa.getAuthenticatorAssuranceLevel() — the API this module is
 *                          specified to derive from, called only now that
 *                          (1) and (2) have established the token is real.
 *   4. CROSS-CHECK (3) against (2) and fail closed on ANY disagreement.
 *
 * Step 4 is the part that converts "we called the right function" into
 * "we cannot be lied to". If the unverified decode and the verified
 * claims disagree about `aal` or about the authentication methods, one of
 * them is forged and we do not get to guess which. `level` is forced to
 * `'aal1'` and `malformed` names the reason.
 *
 * ─── FAIL CLOSED, AND WHAT THAT SPECIFICALLY RULES OUT ────────────────
 *
 * Every unreadable, absent, contradictory or future-dated input produces
 * a REFUSAL. It never produces a substituted value.
 *
 * That sentence is doing real work. During the session-lifetime effort a
 * near-identical guard was drafted with a "safe" fallback: on a timestamp
 * that could not be trusted, fall back to an in-memory or recomputed
 * value. The fallback WAS the vulnerability — an attacker who could not
 * forge a plausible timestamp simply forged an implausible one, tripped
 * the fallback, and got the lenient path. A forged-future `amr` timestamp
 * is a hostile input, so it must land on the strictest branch, never the
 * most convenient one. There is no fallback in this file and none may be
 * added.
 *
 * The direction is cheap because the reset mechanism is a re-challenge:
 * `mfa.verify()` mints a NEW access token with a fresh `amr` timestamp.
 * The worst case for a legitimate admin is one extra six-digit code.
 * There is deliberately no step-up token, no "recently stepped up" store
 * and no server-side grace record — a parallel store is a second source
 * of truth about assurance, and the whole point is that the token is the
 * only source.
 *
 * ─── WHY TWO WINDOWS ──────────────────────────────────────────────────
 *
 * `standard` (8 hours) covers a working day: an admin signs in, presents
 * their factor once, and gets on with approving merchants and reading
 * customer records without being interrupted.
 *
 * `critical` (5 minutes) covers the operations where the loss is
 * immediate and irreversible — moving money, redirecting where money
 * goes, and handing out privilege. For those, "you were you eight hours
 * ago" is not an answer; the code must be in the operator's hand right
 * now. Five minutes is long enough to fetch a phone and short enough
 * that a walked-away-from desk is not a payout.
 *
 * This is also the hole the audit names directly: a session that
 * presented a factor ONCE, months ago, at sign-in, is aal2 forever
 * afterwards. `aal2` alone is a statement about enrolment, not about
 * recency. Only the `amr` timestamp carries recency, which is why the
 * freshness check — not the level check — is what stops a replayed
 * aal2 token at the `critical` tier.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { getRequestUser } from './requestUser';

// ─── Windows ──────────────────────────────────────────────────────────

export type AssuranceTier = 'standard' | 'critical';

/** Milliseconds since the second factor was presented, per tier. */
export const ASSURANCE_MAX_AGE_MS: Record<AssuranceTier, number> = {
  standard: 8 * 60 * 60 * 1000,
  critical:      5 * 60 * 1000,
};

/**
 * `amr.method` values that count as a SECOND factor on this project.
 *
 * Deliberately NOT here, and each for a different reason:
 *
 *   • `passkey` — Supabase's `auth.passkey.*` namespace is a FIRST
 *     factor. It issues a session at aal1. Production confirms it:
 *     `auth.mfa_amr_claims` carries `passkey` rows and every one of the
 *     41 live sessions on this project is aal1. Treating it as a second
 *     factor would make the guard open for a single-factor sign-in.
 *   • `password`, `otp`, `oauth`, `magiclink` — first factors.
 *   • `mfa/phone` — SMS is not used as a factor here. SIM-swap fraud is
 *     endemic in South Africa, which makes an SMS second factor weaker
 *     than the password it is supposed to be backing up.
 *
 * `totp` is listed alongside `mfa/totp` because GoTrue's AMR vocabulary
 * carries both spellings (see the AMRMethods union in @supabase/auth-js)
 * and which one a given release writes is not ours to pin.
 */
export const MFA_AMR_METHODS: readonly string[] = ['mfa/totp', 'totp'];

// ─── Shapes ───────────────────────────────────────────────────────────

export type AssuranceLevel = 'aal1' | 'aal2';

/** One parsed `amr` entry. `atMs` is epoch milliseconds. */
export type AssuranceMethod = {
  method: string;
  atMs:   number;
};

/**
 * Why a token could not be trusted. Whenever this is non-null the
 * reported `level` is forced to `'aal1'` — the value is the reason, never
 * a substitute for the missing one.
 */
export type AssuranceMalformation =
  | 'no_session'
  | 'unverified_token'
  | 'claims_mismatch'
  | 'amr_absent'
  | 'amr_untimestamped'
  | 'mfa_timestamp_missing'
  | 'mfa_timestamp_malformed'
  | 'mfa_timestamp_future';

export type SessionAssurance = {
  /** Forced to 'aal1' whenever `malformed` is non-null. */
  level:             AssuranceLevel;
  /** When the second factor was presented. Null unless a trusted one was found. */
  mfaVerifiedAt:     Date | null;
  methods:           readonly AssuranceMethod[];
  /** 'aal2' when the user has at least one VERIFIED factor available. */
  nextLevel:         AssuranceLevel;
  hasVerifiedFactor: boolean;
  malformed:         AssuranceMalformation | null;
};

/** An assurance a caller can rely on: aal1, unusable, and why. */
const UNTRUSTED = (reason: AssuranceMalformation): SessionAssurance => ({
  level:             'aal1',
  mfaVerifiedAt:     null,
  methods:           [],
  nextLevel:         'aal1',
  hasVerifiedFactor: false,
  malformed:         reason,
});

// ─── Pure parsing ─────────────────────────────────────────────────────

/**
 * Normalise `currentAuthenticationMethods` into timestamped entries.
 *
 * Two shapes are possible and the type in @supabase/auth-js admits both:
 * `AMREntry[]` (`{ method, timestamp }`, timestamp in SECONDS) and a bare
 * `string[]` (the RFC-8176 form, which a Custom Access Token Hook can
 * return). The string form carries NO timestamp, so it cannot satisfy a
 * freshness window at all — it is reported as `amr_untimestamped` and
 * fails closed rather than being treated as "now".
 *
 * `issuedAtSec` is the token's own `iat`. It is used for a
 * clock-domain-independent sanity check: GoTrue writes the amr row and
 * THEN mints the token, so an `amr` timestamp later than the token's own
 * issue time is impossible and means the value was tampered with. That
 * check does not depend on our clock agreeing with the auth server's,
 * which the `> now` check does. Both are applied; both fail closed.
 */
export function parseAssuranceMethods(
  raw:         unknown,
  nowMs:       number,
  issuedAtSec: number | null,
): { methods: readonly AssuranceMethod[]; mfaVerifiedAt: Date | null; malformed: AssuranceMalformation | null } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { methods: [], mfaVerifiedAt: null, malformed: 'amr_absent' };
  }

  // The RFC-8176 string form. Timestampless, therefore unusable here.
  if (raw.every((entry) => typeof entry === 'string')) {
    return { methods: [], mfaVerifiedAt: null, malformed: 'amr_untimestamped' };
  }

  const methods: AssuranceMethod[] = [];
  let mfaSeen      = false;
  let mfaAtMs: number | null = null;
  let malformed: AssuranceMalformation | null = null;

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method : null;
    if (!method) continue;

    const isMfa = MFA_AMR_METHODS.includes(method);
    const rawTs = record.timestamp;

    if (typeof rawTs !== 'number' || !Number.isFinite(rawTs)) {
      // A first factor with a junk timestamp is not this guard's business
      // — only the MFA entry's recency is load-bearing.
      if (isMfa) {
        malformed = rawTs === undefined ? 'mfa_timestamp_missing' : 'mfa_timestamp_malformed';
      }
      continue;
    }

    const atMs = rawTs * 1000;
    methods.push({ method, atMs });
    if (!isMfa) continue;

    // ── The hostile-input branch ──────────────────────────────────────
    // Future-dated in EITHER clock domain is tampering, and tampering
    // gets the strict path. Never a clamp, never a recomputed "safe"
    // value — see the module header for why that fallback was the bug.
    if (atMs > nowMs) {
      malformed = 'mfa_timestamp_future';
      continue;
    }
    if (issuedAtSec !== null && Number.isFinite(issuedAtSec) && rawTs > issuedAtSec) {
      malformed = 'mfa_timestamp_future';
      continue;
    }

    // Keep the most recent trustworthy MFA presentation.
    if (mfaAtMs === null || atMs > mfaAtMs) mfaAtMs = atMs;
    mfaSeen = true;
  }

  if (malformed) return { methods, mfaVerifiedAt: null, malformed };
  if (!mfaSeen || mfaAtMs === null) {
    // No MFA entry at all. Not a malformation — an aal1 session looks
    // exactly like this, and it is the ordinary case.
    return { methods, mfaVerifiedAt: null, malformed: null };
  }

  return { methods, mfaVerifiedAt: new Date(mfaAtMs), malformed: null };
}

/**
 * Do the unverified decode and the verified claims agree?
 *
 * Compared: the level, and the multiset of `method` names. Timestamps are
 * deliberately NOT compared field-by-field — both sides read the same
 * token, so a difference there would mean a library bug rather than an
 * attack, and the freshness check below re-reads the value anyway.
 */
export function assuranceClaimsAgree(
  libraryLevel:   unknown,
  libraryMethods: unknown,
  verifiedLevel:  unknown,
  verifiedMethods: unknown,
): boolean {
  if (libraryLevel !== verifiedLevel) return false;

  const names = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'object' && entry !== null) {
          const method = (entry as Record<string, unknown>).method;
          return typeof method === 'string' ? method : null;
        }
        return null;
      })
      .filter((name): name is string => name !== null)
      .sort();
  };

  const a = names(libraryMethods);
  const b = names(verifiedMethods);
  if (a.length !== b.length) return false;
  return a.every((name, i) => name === b[i]);
}

/** Is a presentation recent enough for this tier? Null is never fresh. */
export function assuranceIsFresh(
  mfaVerifiedAt: Date | null,
  nowMs:         number,
  tier:          AssuranceTier,
): boolean {
  if (!mfaVerifiedAt) return false;
  const atMs = mfaVerifiedAt.getTime();
  if (!Number.isFinite(atMs)) return false;
  // Future-dated never reaches here (parseAssuranceMethods refuses it),
  // but the check is repeated rather than assumed — this function is
  // exported and a future caller may not have gone through the parser.
  if (atMs > nowMs) return false;
  return nowMs - atMs < ASSURANCE_MAX_AGE_MS[tier];
}

// ─── The session read ─────────────────────────────────────────────────

/**
 * Read this request's assurance, from a token proven genuine first.
 *
 * Memoised per request for the same reason lib/auth/requestUser.ts is: an
 * admin page runs the layout gate and then several action guards, and
 * each would otherwise repeat the same validation round trips for an
 * answer that cannot change inside one request. `cache()` keys on
 * arguments, so this takes none.
 *
 * NEVER THROWS. A refusal is a value here, matching every other guard in
 * this repo — a server action that throws renders an error boundary
 * instead of telling the operator what to do about it.
 */
export const getSessionAssurance = cache(async (): Promise<SessionAssurance> => {
  // (1) Identity, verified at the auth server. This is the step that makes
  //     everything below meaningful: it proves the cookie's access token
  //     is genuine and unexpired.
  const user = await getRequestUser();
  if (!user) return UNTRUSTED('no_session');

  const supabase = await createClient();

  // (2) Verified claims. Signature checked before we read aal/amr.
  let verifiedClaims: Record<string, unknown> | null = null;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return UNTRUSTED('unverified_token');
    verifiedClaims = data.claims as unknown as Record<string, unknown>;
  } catch {
    return UNTRUSTED('unverified_token');
  }

  // The verified token must describe the user the auth server just
  // confirmed. A mismatch means two different tokens were in play.
  if (verifiedClaims.sub !== user.id) return UNTRUSTED('claims_mismatch');

  // (3) The specified API, called now that the token is known to be real.
  let libraryLevel:   unknown = null;
  let libraryMethods: unknown = null;
  let libraryNext:    unknown = null;
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return UNTRUSTED('unverified_token');
    libraryLevel   = data.currentLevel;
    libraryMethods = data.currentAuthenticationMethods;
    libraryNext    = data.nextLevel;
  } catch {
    return UNTRUSTED('unverified_token');
  }

  // (4) Cross-check. Disagreement means one side is forged, and we do not
  //     get to pick which.
  if (!assuranceClaimsAgree(libraryLevel, libraryMethods, verifiedClaims.aal, verifiedClaims.amr)) {
    return UNTRUSTED('claims_mismatch');
  }

  const issuedAtSec = typeof verifiedClaims.iat === 'number' ? verifiedClaims.iat : null;
  const parsed      = parseAssuranceMethods(libraryMethods, Date.now(), issuedAtSec);

  if (parsed.malformed) {
    // Preserve the methods we could read, for the audit trail, but the
    // level is not negotiable.
    return { ...UNTRUSTED(parsed.malformed), methods: parsed.methods };
  }

  const level:     AssuranceLevel = libraryLevel === 'aal2' ? 'aal2' : 'aal1';
  const nextLevel: AssuranceLevel = libraryNext  === 'aal2' ? 'aal2' : 'aal1';

  // An 'aal2' level with no trustworthy MFA entry in `amr` is
  // self-contradictory. Refuse rather than reconcile.
  if (level === 'aal2' && parsed.mfaVerifiedAt === null) {
    return { ...UNTRUSTED('amr_absent'), methods: parsed.methods };
  }

  return {
    level,
    mfaVerifiedAt:     parsed.mfaVerifiedAt,
    methods:           parsed.methods,
    nextLevel,
    hasVerifiedFactor: nextLevel === 'aal2',
    malformed:         null,
  };
});

// ─── The guard ────────────────────────────────────────────────────────

export type Aal2Refusal =
  /** No session at all. Sign in. */
  | { kind: 'unauthenticated' }
  /** Single-factor session. `canEnrol` false ⇒ no verified factor yet. */
  | { kind: 'aal1'; canEnrol: boolean }
  /** aal2, but the factor was presented too long ago for this tier. */
  | { kind: 'stale'; tier: AssuranceTier; mfaVerifiedAt: Date; maxAgeMs: number }
  /** The token could not be trusted. Never a lenient path. */
  | { kind: 'malformed'; malformation: AssuranceMalformation };

export type Aal2Result =
  | { ok: true;  assurance: SessionAssurance }
  | { ok: false; refusal: Aal2Refusal; error: string };

/** Where a refused caller is sent to fix it. */
export const SECURITY_ROUTE           = '/security';
export const SECURITY_ENROL_ROUTE     = '/security?step=enrol';
export const SECURITY_CHALLENGE_ROUTE = '/security?step=challenge';

/** Operator-facing text. Says what to do, not what went wrong internally. */
function refusalMessage(refusal: Aal2Refusal): string {
  switch (refusal.kind) {
    case 'unauthenticated':
      return 'Your session has ended. Please sign in again.';
    case 'aal1':
      return refusal.canEnrol
        ? 'This action needs two-factor authentication. Enter a code from your authenticator app to continue.'
        : 'This action needs two-factor authentication. Set up an authenticator app under Security to continue.';
    case 'stale':
      return refusal.tier === 'critical'
        ? 'This action needs a fresh two-factor code. Enter the current code from your authenticator app to continue.'
        : 'Your two-factor verification has expired. Enter a code from your authenticator app to continue.';
    case 'malformed':
      return 'Your session could not be verified. Please sign in again.';
  }
}

/**
 * Refuse unless this session is aal2 AND presented its factor recently
 * enough for `tier`.
 *
 * Returns a value; never throws and never redirects. Callers in server
 * actions surface `result.error`; callers in pages redirect to
 * `SECURITY_ROUTE`.
 *
 * MUST be called BEFORE the caller chooses its Supabase client. Fifteen of
 * the sixteen privileged writes in this app run on the service-role
 * client, which bypasses RLS entirely — so for those the app-level guard
 * is the only control there is, and a guard that runs after the write is
 * decided is not a guard. The ordering is asserted structurally in
 * app/privileged-mfa-guard-coverage.test.ts.
 */
export async function requireAAL2(tier: AssuranceTier): Promise<Aal2Result> {
  const assurance = await getSessionAssurance();

  if (assurance.malformed === 'no_session') {
    const refusal: Aal2Refusal = { kind: 'unauthenticated' };
    return { ok: false, refusal, error: refusalMessage(refusal) };
  }

  if (assurance.malformed) {
    const refusal: Aal2Refusal = { kind: 'malformed', malformation: assurance.malformed };
    return { ok: false, refusal, error: refusalMessage(refusal) };
  }

  if (assurance.level !== 'aal2') {
    const refusal: Aal2Refusal = { kind: 'aal1', canEnrol: assurance.hasVerifiedFactor };
    return { ok: false, refusal, error: refusalMessage(refusal) };
  }

  if (!assuranceIsFresh(assurance.mfaVerifiedAt, Date.now(), tier)) {
    // mfaVerifiedAt is non-null here: getSessionAssurance refuses an
    // 'aal2' level with no trustworthy MFA entry.
    const refusal: Aal2Refusal = {
      kind:          'stale',
      tier,
      mfaVerifiedAt: assurance.mfaVerifiedAt as Date,
      maxAgeMs:      ASSURANCE_MAX_AGE_MS[tier],
    };
    return { ok: false, refusal, error: refusalMessage(refusal) };
  }

  return { ok: true, assurance };
}
