// ─── Ring detection: the question no other control asks ─────────────────
//
// THE ATTACK THIS EXISTS FOR
//
// Everything upstream verifies a PERSON. The DHA/Datanamix query proves
// the ID number is real and live on the register; liveness proves a
// physical human is present; face match proves that human is the one the
// register has a photograph of. Against a fabricated identity this stack
// is genuinely hard to beat, and it should stay the primary control.
//
// It is also, on its own, completely blind to the attack that actually
// scales here — because the attack does not fabricate anyone.
//
// In the South African market the going rate for renting a real identity
// is a few hundred rand: the holder appears in person, passes liveness,
// passes face match, signs, takes the cash, and walks. Every check we run
// returns green, correctly. Run it forty times and the operator has forty
// verified borrowers, forty credit limits, and one afternoon's work. The
// individual-verification stack cannot refuse any of them, because there
// is nothing wrong with any of them individually. That is the definition
// of the gap: the fraud is in the RELATIONSHIP between the applications,
// and relationships are not on any single application's record.
//
// So this module asks the only question that can see it: what else does
// this applicant share with everyone who came before?
//
// ─── WHY THIS IS NOT SIMPLY "SHARED DEVICE = FRAUD" ────────────────────
//
// Because in this market that rule would be wrong far more often than it
// is right, and wrong in a direction that matters.
//
// Smartphone sharing is ordinary here, not exceptional. One handset
// serves a household; a grandmother's phone is used by three adult
// children; a spouse with the data bundle applies on behalf of the one
// without. A rule that flags the second identity on a device would fire
// overwhelmingly on families — and the consequence of firing is that
// someone gets refused medical credit at the counter, in front of a
// receptionist, with no explanation they can act on. That is a real harm,
// it lands hardest on exactly the low-income patients this product is for,
// and it is invisible in aggregate metrics because the refused patient
// simply leaves.
//
// Three design commitments follow, and they are the substance of this
// module:
//
//   1. GENEROUS PER-KIND TOLERANCES. Sharing is priced as normal up to a
//      threshold set from how households actually behave, not from what
//      is convenient to compute. Two, three, four identities on a device
//      is a family. Nine is not a family.
//
//   2. CORROBORATION BEFORE CONSEQUENCE. No single kind of link, at any
//      volume, can reach the blocking band alone. A ring is cheap to spot
//      precisely because it leaks on several independent axes at once —
//      one device AND one card AND one hour. A household leaks on one.
//      Requiring two independent kinds is what separates them, and it is
//      enforced structurally below rather than left to threshold tuning.
//
//   3. TIME CLUSTERING IS THE DISCRIMINATOR. A family accumulates on a
//      device over months. An operator works through a stack of rented
//      IDs in an afternoon. Identical link counts mean very different
//      things at those two tempos, so recency multiplies rather than
//      merely adds.
//
// ─── WHAT THE OUTPUT IS ALLOWED TO DO ──────────────────────────────────
//
// 'review' and 'block' are recommendations about CREDIT, and nothing else.
// They must never be wired to delete an account, refuse authentication,
// or interrupt care. A patient who trips this still has their account,
// their history, and every route to a human. The worst outcome this module
// is permitted to cause is "this plan needs a person to approve it".
//
// PURE. Every fact arrives as an argument; the fetching lives in
// lib/security/identitySignals.ts. Keeping the decision separate from the
// query is what makes each threshold below testable against the exact
// household-versus-ring case that justifies it.

import type { CorrelationKind } from './correlationKeys';
import { saIdSequence } from '@/lib/validation/saId';

/**
 * One correlation key, and who else is standing on it.
 *
 * `distinctIdentities` counts DISTINCT VERIFIED IDENTITIES — distinct
 * sa_id_lookup_hash values — not distinct accounts, and not distinct
 * sessions. That distinction is load-bearing in both directions:
 *
 *   • counting accounts would let one person with three abandoned signups
 *     look like a three-person ring;
 *   • counting sessions would let one patient who reconnects on hotel wifi
 *     look like a hundred.
 *
 * The applicant themselves is EXCLUDED from the count by the caller, so
 * `0` means "nobody else here" and the numbers below read as "other
 * people", which is what the thresholds are reasoned about in.
 */
export type IdentityLink = {
  kind: CorrelationKind;
  /** Other distinct verified identities sharing this key, all time. */
  distinctIdentities: number;
  /**
   * How many of those first appeared inside the recency window
   * (RECENT_WINDOW_HOURS). The tempo signal — see commitment 3 above.
   */
  recentIdentities: number;
};

export type RingSignal = {
  code:   string;
  weight: number;
  detail: string;
};

export type RingVerdict =
  /** Nothing to say. Proceed normally. */
  | 'clear'
  /** Log and watch. NO user-visible consequence, deliberately. */
  | 'watch'
  /** A human approves this plan before credit is committed. */
  | 'review'
  /** Refuse the credit claim. Account, login and existing plans untouched. */
  | 'block';

export type RingAssessment = {
  score:   number;
  verdict: RingVerdict;
  signals: RingSignal[];
  /** Distinct link kinds that contributed. Drives the corroboration rule. */
  corroboratingKinds: number;
};

/** Identities appearing within this many hours of each other are "clustered". */
export const RECENT_WINDOW_HOURS = 24;

export const RING_WATCH_SCORE  = 40;
export const RING_REVIEW_SCORE = 70;
export const RING_BLOCK_SCORE  = 110;

/**
 * Per-kind tolerance and weight.
 *
 * `free` is how many other identities may share this key before it says
 * anything at all — the household allowance. `perExcess` is what each
 * identity beyond that is worth. `cap` bounds any single kind's
 * contribution so that one very noisy key (a carrier NAT, a clinic's guest
 * wifi) cannot dominate the score by itself.
 *
 * The numbers, and why each is what it is:
 *
 * device  — free: 4. A shared household handset, sized for the largest
 *           ordinary case rather than the median one, because the cost of
 *           being wrong falls on families. Beyond four, weight is high:
 *           a device is a real, physical thing an operator has to buy and
 *           carry, so genuine excess here is meaningful.
 *
 * card    — free: 2. Strongest signal in the set, with one caveat that
 *           has to be stated because it changes what a match means.
 *
 *           A shared card is a real financial relationship — and a parent
 *           paying a child's first instalment is exactly that
 *           relationship, and common, hence a non-zero allowance. Its
 *           value against a ring is that it survives the attacker
 *           re-entering the same card under a different name.
 *
 *           THE CAVEAT: this is NOT an issuer fingerprint. Peach does not
 *           expose one, so payment_methods.signature is synthesised by
 *           lib/payments/peach/saveCardForPatient.ts as
 *           brand:last4:expiry. That is roughly two million buckets, not
 *           one per card, so two unrelated patients CAN collide — a VISA
 *           ending 1234 expiring 05/2028 is not a rare object.
 *
 *           This is precisely why the allowance is 2 rather than 0.
 *           Incidental collisions arrive one at a time; a ring arrives
 *           with a tempo and on other axes too, and the corroboration
 *           rule below means a card match alone never decides anything.
 *           If a true issuer fingerprint becomes available, this key gets
 *           stronger and the allowance can drop.
 *
 * phone   — free: 2. A household landline or a shared handset number.
 *           Moderate weight: phone reuse is common and cheap to rotate.
 *
 * email   — free: 1. Alias-normalised, so this fires on gmail-dot and
 *           +tag farming, which has no innocent explanation at volume —
 *           but two family members genuinely do share one mailbox, so the
 *           allowance is one rather than zero.
 *
 * ip      — free: 6, low weight. A single address is reassigned constantly
 *           on mobile networks; matching on it is weak evidence of
 *           anything.
 *
 * subnet  — free: 12, lowest weight, hard cap. The noisiest key here by a
 *           wide margin. A hospital waiting room, a university, a
 *           workplace, or carrier-grade NAT can legitimately place
 *           hundreds of unrelated patients in one /24. It is retained
 *           because it CORROBORATES — "same device and same network" is
 *           worth more than "same device" — and for no other purpose. It
 *           can never be sufficient alone; see the corroboration rule.
 */
const KIND_POLICY: Record<CorrelationKind, { free: number; perExcess: number; cap: number }> = {
  device: { free: 4,  perExcess: 18, cap: 72 },
  card:   { free: 2,  perExcess: 22, cap: 66 },
  phone:  { free: 2,  perExcess: 14, cap: 42 },
  email:  { free: 1,  perExcess: 16, cap: 48 },
  ip:     { free: 6,  perExcess: 6,  cap: 24 },
  subnet: { free: 12, perExcess: 3,  cap: 15 },
};

/**
 * Kinds too noisy to ever stand alone. A verdict above 'watch' requires at
 * least one contributing kind from OUTSIDE this set — see the
 * corroboration rule in assessRing.
 *
 * Their caps are also sized so that the two of them TOGETHER, fully
 * saturated and time-clustered, still land below RING_REVIEW_SCORE:
 * (24 + 15) * 1.6 = 62, against a review bar of 70. So network-only
 * evidence tops out inside the log-only band by arithmetic as well as by
 * the corroboration rule — belt and braces, because this is the case
 * (a carrier NAT, a hospital guest network) most likely to accumulate
 * enormous counts in normal operation. Pinned by the 400-identity NAT
 * test.
 */
const NEVER_SUFFICIENT_ALONE: ReadonlySet<CorrelationKind> = new Set<CorrelationKind>(['ip', 'subnet']);

/**
 * Multiplier applied when a kind's links are time-clustered.
 *
 * Commitment 3, made concrete. If most of the excess identities on a key
 * appeared inside RECENT_WINDOW_HOURS, the sharing has a tempo no
 * household produces. The multiplier is applied to that kind's points, so
 * clustering amplifies real signal rather than manufacturing it from
 * nothing: a kind that is inside its free allowance scores zero, and zero
 * times anything is still zero. A ring cannot slip under a threshold by
 * being fast.
 */
const CLUSTER_MULTIPLIER = 1.6;

export type RingObservation = {
  links: IdentityLink[];
  /**
   * Verified identities on this applicant's links whose SA ID sequence
   * numbers sit within a few of each other.
   *
   * Positions 7–10 of an SA ID are assigned in issue order, so two
   * genuinely unrelated South Africans effectively never hold adjacent
   * sequences — but a batch of numbers generated by a script, or a stack
   * of documents issued together at one office on one day, do. On its own
   * this is ambiguous (siblings registered together legitimately land
   * close), which is why it is scored as corroboration and not as a kind
   * that can stand alone.
   */
  sequentialIdNeighbours?: number;
  /**
   * True when every plan across the linked identities was billed by ONE
   * practice.
   *
   * The collusion case: a practice that records bills for rented
   * identities is paid 94% upfront, and the payout is the exfiltration
   * channel. Concentration is not itself proof — a rural town has one
   * clinic, and its patients legitimately share it — so like the sequence
   * signal it corroborates rather than decides.
   */
  singlePracticeConcentration?: boolean;
};

export function assessRing(observation: RingObservation): RingAssessment {
  const signals: RingSignal[] = [];
  const contributingKinds = new Set<CorrelationKind>();

  for (const link of observation.links) {
    const policy = KIND_POLICY[link.kind];
    if (!policy) continue;

    const excess = link.distinctIdentities - policy.free;
    if (excess <= 0) continue;

    // Clustered when MOST of the excess arrived inside the window. Compared
    // against excess rather than against the total, so a long-standing
    // family device that picks up one recent guest is not reclassified as
    // a burst.
    const clustered = link.recentIdentities > 0 && link.recentIdentities >= excess;

    // ─── Cap the VOLUME, then apply the TEMPO ──────────────────────────
    //
    // Order matters here, and getting it backwards is a silent failure.
    //
    // Capping after multiplying — min(excess * per * cluster, cap) — reads
    // fine and is wrong: any kind whose count already exceeds its cap is
    // pinned at the cap either way, so the multiplier cancels out entirely.
    // Clustering would then be invisible for exactly the cases it exists to
    // sharpen. Nine rented identities on a device in one afternoon would
    // score identically to eight family members over two years, because
    // both sit at the device cap. The adversarial test
    // 'escalates a fast burst above the same count spread over months'
    // pins this; it failed against the multiply-then-cap version.
    //
    // The cap bounds how much the COUNT alone may be worth — that is what
    // stops one noisy key dominating. Tempo is separate evidence about the
    // same links, so it scales the capped figure rather than being
    // swallowed by it.
    const base = Math.min(excess * policy.perExcess, policy.cap);
    const weight = Math.round(base * (clustered ? CLUSTER_MULTIPLIER : 1));
    if (weight <= 0) continue;

    contributingKinds.add(link.kind);
    signals.push({
      code: `link_${link.kind}`,
      weight,
      detail:
        `${link.distinctIdentities} other verified identities share this ${link.kind} ` +
        `(allowance ${policy.free}${clustered ? `; ${link.recentIdentities} within ${RECENT_WINDOW_HOURS}h` : ''})`,
    });
  }

  // ─── Corroborating signals ────────────────────────────────────────────
  //
  // Neither of these is a correlation KIND — they describe the shape of
  // the group rather than a key it stands on — so neither registers in
  // contributingKinds, and neither can satisfy the corroboration rule.
  // They sharpen a picture that the links already drew.
  if (typeof observation.sequentialIdNeighbours === 'number' && observation.sequentialIdNeighbours > 0) {
    signals.push({
      code: 'sequential_sa_ids',
      weight: Math.min(observation.sequentialIdNeighbours * 12, 36),
      detail: `${observation.sequentialIdNeighbours} linked identities hold near-adjacent SA ID sequence numbers`,
    });
  }

  if (observation.singlePracticeConcentration) {
    signals.push({
      code: 'single_practice_concentration',
      weight: 20,
      detail: 'every plan across the linked identities was billed by one practice',
    });
  }

  const score = signals.reduce((total, s) => total + s.weight, 0);

  return {
    score,
    verdict: verdictFor(score, contributingKinds),
    signals,
    corroboratingKinds: contributingKinds.size,
  };
}

/**
 * Score plus the corroboration rule.
 *
 * THE RULE: a verdict above 'watch' requires either two distinct
 * contributing kinds, or one contributing kind that is not in
 * NEVER_SUFFICIENT_ALONE.
 *
 * Why it is structural and not another threshold: the failure mode it
 * prevents is a single noisy key — one carrier NAT, one clinic guest
 * network — accumulating enough volume to clear a score bar on its own and
 * refusing credit to every patient behind it. No choice of weights fixes
 * that, because the weight that stops a 500-identity NAT also stops a
 * genuine 9-identity device ring. Separating "how much evidence" from "how
 * many independent sources" is what lets both be sized honestly.
 *
 * A capped, weak, lone kind therefore tops out at 'watch' — which logs and
 * does nothing to the patient — no matter how large its count grows.
 */
function verdictFor(score: number, kinds: Set<CorrelationKind>): RingVerdict {
  const corroborated =
    kinds.size >= 2 ||
    [...kinds].some((k) => !NEVER_SUFFICIENT_ALONE.has(k));

  if (!corroborated) return score >= RING_WATCH_SCORE ? 'watch' : 'clear';

  if (score >= RING_BLOCK_SCORE)  return 'block';
  if (score >= RING_REVIEW_SCORE) return 'review';
  if (score >= RING_WATCH_SCORE)  return 'watch';
  return 'clear';
}

/**
 * Do two SA ID numbers sit close enough in issue order to be worth noting?
 *
 * Compares the birth date (positions 1–6) AND the sequence (7–10): two
 * people born on different days with nearby sequences is meaningless,
 * because the sequence counter is scoped per birth date. Same date plus
 * adjacent sequence is the batch signature.
 *
 * Takes plaintext IDs, so it runs ONLY where those are already in hand —
 * inside the verification path, never against the ledger, which holds
 * hashes precisely so that this comparison is impossible there.
 */
export function saIdSequenceAdjacent(a: string, b: string, tolerance = 3): boolean {
  // Shape and sequence both come from lib/validation/saId.ts — the one
  // module allowed to hold the 13-digit regex, an invariant pinned by
  // lib/validation/regression.test.ts.
  const seqA = saIdSequence(a);
  const seqB = saIdSequence(b);
  if (seqA === null || seqB === null) return false;
  if (a === b) return false;
  // The sequence counter is scoped per birth date, so proximity across
  // different dates means nothing.
  if (a.slice(0, 6) !== b.slice(0, 6)) return false;
  return Math.abs(seqA - seqB) <= tolerance;
}
