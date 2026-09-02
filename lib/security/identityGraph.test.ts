import { describe, it, expect } from 'vitest';
import {
  assessRing,
  saIdSequenceAdjacent,
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

  it('adds the collusion signals without letting them decide alone', () => {
    const shapeOnly = assess({
      links: [],
      sequentialIdNeighbours: 3,
      singlePracticeConcentration: true,
    });
    // Neither shape signal is a correlation KIND, so corroboration is
    // unsatisfied and the verdict cannot exceed watch.
    expect(shapeOnly.corroboratingKinds).toBe(0);
    expect(['clear', 'watch']).toContain(shapeOnly.verdict);

    const withLinks = assess({
      links: [link('device', 8, 8), link('card', 5, 5)],
      sequentialIdNeighbours: 3,
      singlePracticeConcentration: true,
    });
    expect(withLinks.score).toBeGreaterThan(shapeOnly.score);
    expect(withLinks.verdict).toBe('block');
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

describe('saIdSequenceAdjacent', () => {
  it('flags adjacent sequences on the same birth date', () => {
    expect(saIdSequenceAdjacent('9001015000081', '9001015001080')).toBe(true); // 5000 vs 5001
    expect(saIdSequenceAdjacent('9001015000081', '9001015002083')).toBe(true); // 5000 vs 5002, within 3
    expect(saIdSequenceAdjacent('9001015000081', '9001015009087')).toBe(false); // 5000 vs 5009, outside
  });

  it('does not flag the same ID against itself', () => {
    expect(saIdSequenceAdjacent('9001015000081', '9001015000081')).toBe(false);
  });

  it('does not flag nearby sequences on DIFFERENT birth dates', () => {
    // The sequence counter is scoped per birth date, so proximity across
    // dates is meaningless. Missing this would flag unrelated strangers.
    expect(saIdSequenceAdjacent('9001015000081', '9203115001085')).toBe(false);
  });

  it('rejects malformed input rather than throwing', () => {
    expect(saIdSequenceAdjacent('', '9001015000081')).toBe(false);
    expect(saIdSequenceAdjacent('abc', 'def')).toBe(false);
    expect(saIdSequenceAdjacent('900101500008', '9001015000081')).toBe(false);
  });
});
