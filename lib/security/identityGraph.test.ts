import { describe, it, expect } from 'vitest';
import {
  assessRing,
  RING_BLOCK_SCORE,
  type IdentityLink,
  type RingObservation,
} from './identityGraph';

// ─── The test that matters most is the one about families ───────────────
//
// This module's failure mode is not "a ring got through". It is "a
// household got refused" — a real patient, at a counter, in front of a
// receptionist, declined for medical credit because three people share a
// phone. That outcome is invisible in aggregate (the patient just leaves)
// and lands hardest on exactly the low-income users this product exists
// for, so the household cases below are written first and treated as the
// binding constraint. The ring cases come after.

const link = (kind: IdentityLink['kind'], distinct: number, recent = 0): IdentityLink =>
  ({ kind, distinctIdentities: distinct, recentIdentities: recent });

const assess = (o: Partial<RingObservation> & { links: IdentityLink[] }) => assessRing(o);

describe('households are not rings', () => {
  it('clears a shared household handset — four other identities on one device', () => {
    // A grandmother's phone used by her three adult children. Accumulated
    // over months, so nothing is recent.
    const result = assess({ links: [link('device', 4)] });
    expect(result.verdict).toBe('clear');
    expect(result.score).toBe(0);
  });

  it('clears a parent paying for two children on one card', () => {
    const result = assess({ links: [link('card', 2)] });
    expect(result.verdict).toBe('clear');
  });

  it('clears a couple sharing a phone number and a mailbox', () => {
    const result = assess({ links: [link('phone', 2), link('email', 1)] });
    expect(result.verdict).toBe('clear');
  });

  it('clears a household that shares device, phone and network together', () => {
    // Every axis at once, all within allowance — which is precisely what a
    // family looks like, and why the allowances have to hold jointly and
    // not just one at a time.
    const result = assess({
      links: [link('device', 4), link('phone', 2), link('email', 1), link('ip', 6), link('subnet', 12)],
    });
    expect(result.verdict).toBe('clear');
  });
});

describe('noisy networks can never be sufficient alone', () => {
  it('keeps a 400-identity carrier NAT at watch, never review or block', () => {
    // Carrier-grade NAT, a hospital guest network, a university. Hundreds
    // of genuinely unrelated patients on one /24. This is the case that no
    // choice of weights can fix, which is why the corroboration rule is
    // structural.
    const result = assess({ links: [link('subnet', 400, 400), link('ip', 400, 400)] });
    expect(result.verdict).toBe('watch');
    expect(['review', 'block']).not.toContain(result.verdict);
  });

  it('caps the contribution of each network kind regardless of volume', () => {
    const small = assess({ links: [link('subnet', 50)] });
    const huge  = assess({ links: [link('subnet', 50_000)] });
    expect(huge.score).toBe(small.score); // both pinned at the cap
    expect(huge.verdict).not.toBe('block');
  });

  it('lets a network match corroborate a device match without dominating it', () => {
    const deviceOnly = assess({ links: [link('device', 9)] });
    const withNetwork = assess({ links: [link('device', 9), link('subnet', 40)] });
    expect(withNetwork.score).toBeGreaterThan(deviceOnly.score);
    expect(withNetwork.corroboratingKinds).toBe(2);
  });
});

describe('rings are caught', () => {
  it('blocks nine rented identities on one device and one card in a day', () => {
    // The motivating attack: an operator working a stack of rented IDs
    // through one handset in an afternoon, paying with one card.
    const result = assess({
      links: [link('device', 9, 9), link('card', 8, 8), link('subnet', 9, 9)],
    });
    expect(result.verdict).toBe('block');
    expect(result.score).toBeGreaterThanOrEqual(RING_BLOCK_SCORE);
    expect(result.corroboratingKinds).toBeGreaterThanOrEqual(2);
  });

  it('flags email-alias farming (gmail dots / +tags) for review', () => {
    const result = assess({ links: [link('email', 6, 6), link('device', 6, 6)] });
    expect(['review', 'block']).toContain(result.verdict);
  });

  it('escalates a fast burst above the same count spread over months', () => {
    const slow = assess({ links: [link('device', 8), link('card', 5)] });
    const fast = assess({ links: [link('device', 8, 8), link('card', 5, 5)] });
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it('cannot be evaded by going fast — clustering never manufactures score from nothing', () => {
    // Everything inside allowance, arriving all at once. A busy family
    // afternoon is still a family.
    const result = assess({ links: [link('device', 4, 4), link('card', 2, 2), link('phone', 2, 2)] });
    expect(result.score).toBe(0);
    expect(result.verdict).toBe('clear');
  });

  it('adds the collusion signal without letting it decide alone', () => {
    const shapeOnly = assess({
      links: [],
      practiceConcentration: { linkedIdentities: 9, linkedPlans: 12, distinctPractices: 1 },
    });
    // Concentration is not a correlation KIND, so corroboration is
    // unsatisfied and the verdict cannot exceed watch however stark it is.
    expect(shapeOnly.corroboratingKinds).toBe(0);
    expect(['clear', 'watch']).toContain(shapeOnly.verdict);

    const withLinks = assess({
      links: [link('device', 8, 8), link('card', 5, 5)],
      practiceConcentration: { linkedIdentities: 9, linkedPlans: 12, distinctPractices: 1 },
    });
    expect(withLinks.score).toBeGreaterThan(shapeOnly.score);
    expect(withLinks.verdict).toBe('block');
  });
});

describe('practice concentration', () => {
  // The collusion case: the practice is paid 94% upfront, so a captured
  // practice behind every linked identity is the shape of the attack.
  const conc = (o: Partial<RingObservation['practiceConcentration']> & { linkedIdentities: number; linkedPlans: number; distinctPractices: number }) =>
    assess({ links: [], practiceConcentration: o });

  it('says nothing about a small group at one clinic', () => {
    // Two people who went to the same practice is the overwhelmingly
    // likely innocent outcome, and "100% concentrated" is trivially true
    // for small groups — which is exactly why this is not a boolean.
    expect(conc({ linkedIdentities: 2, linkedPlans: 2, distinctPractices: 1 }).score).toBe(0);
    expect(conc({ linkedIdentities: 3, linkedPlans: 3, distinctPractices: 1 }).score).toBe(0);
  });

  it('scores a large group billed entirely through one practice', () => {
    expect(conc({ linkedIdentities: 9, linkedPlans: 14, distinctPractices: 1 }).score).toBeGreaterThan(0);
  });

  it('scores a heavy skew less than a total one', () => {
    const total = conc({ linkedIdentities: 9, linkedPlans: 12, distinctPractices: 1 });
    const skew  = conc({ linkedIdentities: 9, linkedPlans: 12, distinctPractices: 3 });
    expect(skew.score).toBeGreaterThan(0);
    expect(skew.score).toBeLessThan(total.score);
  });

  it('says nothing when the group is genuinely spread across practices', () => {
    expect(conc({ linkedIdentities: 9, linkedPlans: 12, distinctPractices: 8 }).score).toBe(0);
  });

  it('never lets concentration alone exceed the log-only band', () => {
    const extreme = conc({ linkedIdentities: 500, linkedPlans: 900, distinctPractices: 1 });
    expect(['clear', 'watch']).toContain(extreme.verdict);
  });

  it('distinguishes an unanswerable question from a spread-out answer', () => {
    // undefined = we could not look. Zero score, but not a finding.
    expect(assess({ links: [], practiceConcentration: undefined }).score).toBe(0);
  });
});

describe('assessRing is total', () => {
  it('returns clear for no links at all', () => {
    expect(assess({ links: [] })).toMatchObject({ score: 0, verdict: 'clear', corroboratingKinds: 0 });
  });

  it('ignores an unknown kind rather than throwing', () => {
    const result = assessRing({
      // A kind that is not in the policy table — e.g. a future migration
      // adding one the decision layer has not been taught about yet.
      links: [{ kind: 'bank_account' as IdentityLink['kind'], distinctIdentities: 99, recentIdentities: 99 }],
    });
    expect(result.verdict).toBe('clear');
  });

  it('treats a zero or negative count as no link', () => {
    expect(assess({ links: [link('device', 0), link('card', -1)] }).score).toBe(0);
  });
});

