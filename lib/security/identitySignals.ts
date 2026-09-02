// SERVER-ONLY. Never import in a client component.
//
// ─── The I/O half of ring detection ─────────────────────────────────────
//
// identityGraph.ts decides; correlationKeys.ts hashes; this module is the
// only thing that talks to the database. The split is not ceremony: it is
// what lets every threshold in identityGraph be tested against the exact
// household-versus-ring case that justifies it, with no fixtures and no
// database.
//
// Two entry points:
//
//   recordIdentitySignals  — write what this request revealed. Called on
//                            signup, identity verification and checkout.
//   assessApplicantRing    — read the links back and score them. Called at
//                            the credit gate.
//
// ─── FAILURE POSTURE, WHICH IS DIFFERENT FOR THE TWO ───────────────────
//
// Recording FAILS OPEN and silently. It runs on the signup path, and a
// ledger write that cannot complete must cost us a data point, never cost
// a patient their account. Every error is swallowed here and at the RPC
// (see 0136's EXCEPTION handler).
//
// Assessment fails open too, and that deserves a harder look, because it
// is the choice that lets an attacker who can break the ledger walk
// through the gate. It is still right, for this control, at this maturity:
//
//   • it is not the only control, or even the primary one. The registry
//     query, liveness, face match, the one-ID-one-account index and the
//     per-profile credit limit all still run, and all still refuse;
//   • it is brand new and unproven in production. A control that has never
//     been calibrated against real traffic should not be the thing that
//     takes the whole product down when its query plan regresses;
//   • the failure it would cause is total. Every patient at every
//     practice, refused at the counter, for a fraud control they have
//     never heard of.
//
// The honest cost is stated rather than hidden: an attacker who can cause
// this query to fail can suppress ring detection. That is an acceptable
// trade for a first deployment and a bad one for a mature deployment, so
// it is written down here as the thing to revisit — with the trigger for
// revisiting being real calibration data, not a hunch. `degraded: true` on
// the assessment exists so that the day it flips, the alerting is already
// in place to tell the difference between "no ring" and "we could not
// look".

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { correlationKey, type CorrelationKind } from './correlationKeys';
import {
  assessRing,
  RECENT_WINDOW_HOURS,
  type IdentityLink,
  type PracticeConcentration,
  type RingAssessment,
} from './identityGraph';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

function svc(): Svc {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('identity-signals: service credentials unavailable');
  return createServiceClient(url, key, { auth: { persistSession: false } });
}

/**
 * The raw, unhashed observations from one request.
 *
 * Values arrive in plaintext and are hashed HERE, on the way in. That
 * ordering is deliberate and worth keeping: callers never hold a
 * correlation hash, so no call site can accidentally log one, persist one
 * somewhere unaudited, or send one to a vendor.
 *
 * Every field is optional; absent fields produce no row, and a key that
 * cannot be normalised (a malformed IP, a +tag-only email) produces no row
 * either. An absent signal must never become a SHARED signal — see the
 * blank-input note in correlationKeys.correlationKey.
 */
export type RawSignals = {
  deviceId?: string | null;
  ip?:       string | null;
  email?:    string | null;
  phone?:    string | null;
  /** The payment provider's card fingerprint. Never a PAN. */
  cardFingerprint?: string | null;
};

/** Where the observation came from. Recorded for investigation. */
export type SignalSurface = 'signup' | 'identity' | 'checkout' | 'accept_plan';

type KeyedSignal = { kind: CorrelationKind; hash: string };

/**
 * Turn raw observations into keyed signals.
 *
 * Note `ip` produces TWO signals — the exact address and its /24 or /48.
 * They are different keys with very different weights in identityGraph
 * (an address is reassigned constantly; the network is what an attacker
 * has to actually leave), so both are recorded.
 *
 * Exported for the tests, which need to assert that no raw value ever
 * survives into a hash, and that a malformed input yields nothing rather
 * than a shared empty-string key.
 */
export function keySignals(raw: RawSignals): KeyedSignal[] {
  const candidates: Array<[CorrelationKind, string | null | undefined]> = [
    ['device', raw.deviceId],
    ['ip',     raw.ip],
    ['subnet', raw.ip],
    ['email',  raw.email],
    ['phone',  raw.phone],
    ['card',   raw.cardFingerprint],
  ];

  const out: KeyedSignal[] = [];
  for (const [kind, value] of candidates) {
    let hash: string | null = null;
    try {
      hash = correlationKey(kind, value);
    } catch (err) {
      // A missing or malformed CORRELATION_HMAC_KEY throws. Absent key,
      // absent signal — never a silent downgrade to an unkeyed hash, which
      // would turn the ledger into the brute-forceable thing 0136's header
      // rules out.
      warnKeyUnavailable(err);
      return [];
    }
    if (hash) out.push({ kind, hash });
  }
  return out;
}

/**
 * Say so, loudly, once per process, when the key is missing.
 *
 * WHY THIS EXISTS AS ITS OWN FUNCTION
 *
 * Without the key this whole subsystem degrades to a no-op: nothing is
 * recorded, every assessment returns a degraded 'clear', and signups and
 * checkouts carry on exactly as before. That is the correct failure
 * posture — a fraud control must not be able to take down the product —
 * but it is also indistinguishable, from the outside, from a control that
 * is working and finding nothing.
 *
 * A control that is off and silent about it is worse than one that was
 * never built, because it is trusted. So the degraded state announces
 * itself.
 *
 * Once per process rather than per call: this sits on the signup and
 * checkout paths, and a per-call error would bury the signal it is trying
 * to raise.
 */
let keyWarningIssued = false;
function warnKeyUnavailable(err: unknown): void {
  if (keyWarningIssued) return;
  keyWarningIssued = true;
  console.error(
    '[identity-signals] ALERT correlation key unavailable — ring detection is OFF. ' +
    'No signals will be recorded and every assessment will return a degraded clear. ' +
    'Set CORRELATION_HMAC_KEY (32 bytes, base64). See docs/BOT-AND-SYNTHETIC-IDENTITY-DEFENCE.md.',
    { message: err instanceof Error ? err.message : 'unknown' },
  );
}

/** Test seam: lets a test observe the once-per-process warning. */
export function __resetKeyWarningForTests(): void {
  keyWarningIssued = false;
}

/**
 * Append this request's observations to the ledger. Best-effort: never
 * throws, never blocks, returns how many rows it managed to write.
 *
 * `identityHash` is profiles.sa_id_lookup_hash, or null before the patient
 * has been verified. Null-identity rows are counted toward nobody (0136),
 * so an unverified signup can seed its own later assessment without being
 * able to inflate anyone else's.
 */
export async function recordIdentitySignals(input: {
  profileId:     string;
  identityHash?: string | null;
  surface:       SignalSurface;
  raw:           RawSignals;
  client?:       Svc;
}): Promise<number> {
  const signals = keySignals(input.raw);
  if (signals.length === 0) return 0;

  let client: Svc;
  try {
    client = input.client ?? svc();
  } catch {
    return 0;
  }

  let written = 0;
  await Promise.all(
    signals.map(async ({ kind, hash }) => {
      try {
        const { error } = await client.rpc('record_identity_signal', {
          p_profile_id:    input.profileId,
          p_identity_hash: input.identityHash ?? null,
          p_kind:          kind,
          p_signal_hash:   hash,
          p_surface:       input.surface,
        });
        if (!error) written += 1;
      } catch {
        // Swallowed by design — see the failure posture note above.
      }
    }),
  );

  return written;
}

/**
 * Attach a newly verified identity to everything this profile recorded
 * before it had one.
 *
 * Called from the Didit webhook at the moment sa_id_lookup_hash is
 * written. Best-effort and idempotent — see migration 0137 for why the
 * promotion, rather than recording the pending hash at submit time, is
 * what keeps "a non-null identity_hash means a verified person" true.
 */
export async function promoteIdentitySignals(input: {
  profileId:    string;
  identityHash: string;
  client?:      Svc;
}): Promise<number> {
  let client: Svc;
  try {
    client = input.client ?? svc();
  } catch {
    return 0;
  }

  try {
    const { data, error } = await client.rpc('promote_identity_signals', {
      p_profile_id:    input.profileId,
      p_identity_hash: input.identityHash,
    });
    if (error) {
      console.error('[identity-signals] promotion failed', { code: error.code, message: error.message });
      return 0;
    }
    return Number(data) || 0;
  } catch (err) {
    console.error('[identity-signals] promotion threw', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return 0;
  }
}

export type ApplicantRingAssessment = RingAssessment & {
  /**
   * True when the links could not be read and the assessment is therefore
   * a default 'clear' rather than an observed one.
   *
   * The distinction that alerting depends on: "we looked and found no
   * ring" and "we could not look" are the same verdict and must never be
   * the same log line.
   */
  degraded: boolean;
};

/**
 * Score this applicant against everyone who shares their signals.
 *
 * Fails open to a degraded 'clear' — see the posture note at the top of
 * this file for why, and for what that concedes.
 */
export async function assessApplicantRing(input: {
  identityHash: string;
  raw:          RawSignals;
  client?:      Svc;
}): Promise<ApplicantRingAssessment> {
  const degradedClear = (): ApplicantRingAssessment => ({
    score: 0, verdict: 'clear', signals: [], corroboratingKinds: 0, degraded: true,
  });

  const signals = keySignals(input.raw);
  if (signals.length === 0) return degradedClear();

  let client: Svc;
  try {
    client = input.client ?? svc();
  } catch {
    return degradedClear();
  }

  let rows: Array<{ kind: string; distinct_identities: number; recent_identities: number }>;
  try {
    const { data, error } = await client.rpc('count_identity_links', {
      p_identity_hash: input.identityHash,
      p_kinds:         signals.map((s) => s.kind),
      p_hashes:        signals.map((s) => s.hash),
      p_recent_hours:  RECENT_WINDOW_HOURS,
    });
    if (error) {
      console.error('[identity-signals] link count failed — assessing as degraded clear', {
        code: error.code, message: error.message,
      });
      return degradedClear();
    }
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[identity-signals] link count threw — assessing as degraded clear', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return degradedClear();
  }

  const links: IdentityLink[] = rows
    .filter((r): r is typeof r & { kind: CorrelationKind } => isCorrelationKind(r.kind))
    .map((r) => ({
      kind:               r.kind,
      distinctIdentities: Number(r.distinct_identities) || 0,
      recentIdentities:   Number(r.recent_identities)   || 0,
    }));

  // Practice concentration is a SECOND query rather than a join onto the
  // first, because the two answer different questions and one of them can
  // fail without spoiling the other: link counts come from the ledger
  // alone, while this one reaches into `plans`. A concentration read that
  // fails leaves the link-based verdict intact and merely unsharpened.
  const concentration = await readPracticeConcentration(client, input.identityHash, signals);

  const assessment = assessRing({ links, practiceConcentration: concentration });

  return { ...assessment, degraded: false };
}

/**
 * Where the linked identities' plans were billed. Returns undefined when
 * the question could not be answered — distinct from "answered, and they
 * are spread across many practices", which is a real finding.
 */
async function readPracticeConcentration(
  client: Svc,
  identityHash: string,
  signals: KeyedSignal[],
): Promise<PracticeConcentration | undefined> {
  try {
    const { data, error } = await client.rpc('linked_practice_concentration', {
      p_identity_hash: identityHash,
      p_kinds:         signals.map((s) => s.kind),
      p_hashes:        signals.map((s) => s.hash),
    });
    if (error) {
      console.error('[identity-signals] practice concentration failed', {
        code: error.code, message: error.message,
      });
      return undefined;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return undefined;
    return {
      linkedIdentities:  Number(row.linked_identities)  || 0,
      linkedPlans:       Number(row.linked_plans)       || 0,
      distinctPractices: Number(row.distinct_practices) || 0,
    };
  } catch (err) {
    console.error('[identity-signals] practice concentration threw', {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return undefined;
  }
}

const CORRELATION_KINDS: ReadonlySet<string> = new Set([
  'device', 'ip', 'subnet', 'email', 'phone', 'card',
]);

function isCorrelationKind(value: string): value is CorrelationKind {
  return CORRELATION_KINDS.has(value);
}
