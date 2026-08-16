import { describe, it, expect } from 'vitest';
import {
  billMatchFailureFor,
  BILL_MATCH_COPY,
  type BillMatchFailure,
} from './billMatchCopy';
import type { ClaimOutcome } from '@/lib/checkout/claimSessionPlan';

// ─── Every bucket is REACHABLE ───────────────────────────────────────────
//
// An unreachable-but-permitted state is the trap this codebase has now hit
// twice — the 'declined' checkout stage, and a CHECK constraint admitting a
// value nothing could produce. A copy bucket nothing can select is the same
// bug wearing different clothes: it reads as covered, reviews as thorough,
// and can never appear in front of a patient.
//
// So each one is proven by CALLING the mapper, not by finding its name in
// the source. The exhaustive sweep at the bottom then proves the converse —
// that the buckets which exist are exactly the buckets the mapper emits.
//
// The fourth argument arrived with migration 0098: an emailed bill now
// carries the practice's SA ID, so the claim runs for invitations too and
// 'unclaimed_invitation' narrowed from "unbound invitation" to "invitation
// with NO ID on it". That is a real, permanent state — rows issued before
// 0098 — and the test below pins it through exactly that input, so if the
// last legacy invitation expires and someone decides the bucket is dead,
// they have to argue with a failing test rather than a hunch.

type Refusal = ClaimOutcome['reason'] | null;

const REFUSALS: Refusal[] = [
  null, 'already_bound', 'no_profile_id', 'id_mismatch', 'decrypt_failed', 'write_failed',
];

describe('each bucket has at least one input that produces it', () => {
  const cases: Array<[BillMatchFailure, Refusal, 'invitation' | 'session', boolean, boolean]> = [
    // reason, kind, planIsBound, tokenCarriesId
    //
    // The signed-in patient's account holds a different ID from the bill's.
    ['id_mismatch',          'id_mismatch',   'session',    false, true],
    // Their account has no ID at all — the biggest bucket after the cleanup.
    ['no_account_id',        'no_profile_id', 'session',    false, true],
    // Unreadable ciphertext or a failed write. Never the patient's fault.
    ['our_fault',            'decrypt_failed','session',    false, true],
    // An emailed bill already bound to a real account, opened by someone else.
    ['different_account',    null,            'invitation', true,  true],
    // An emailed bill from BEFORE 0098: no ID on it, so nothing to claim
    // against. The only remaining route to this bucket.
    ['unclaimed_invitation', null,            'invitation', false, false],
  ];

  it.each(cases)('%s', (expected, reason, kind, bound, carriesId) => {
    expect(billMatchFailureFor(reason, kind, bound, carriesId)).toBe(expected);
  });

  it('all five are covered by the table above — no bucket is left unproven', () => {
    const proven = new Set(cases.map(([bucket]) => bucket));
    expect([...proven].sort()).toEqual(Object.keys(BILL_MATCH_COPY).sort());
  });
});

describe('0098 changed who lands where, and that is the point', () => {
  it('an invitation WITH an ID no longer reaches unclaimed_invitation', () => {
    // It goes through the claim instead, so a claim-reason bucket answers.
    // This is the retired dead end: a patient who signed up organically
    // after being emailed a bill used to be told to ask reception about a
    // bill that was provably theirs.
    for (const reason of REFUSALS) {
      expect(billMatchFailureFor(reason, 'invitation', false, true)).not.toBe('unclaimed_invitation');
    }
  });

  it('a session token can NEVER reach unclaimed_invitation — its ID column is NOT NULL', () => {
    for (const reason of REFUSALS) {
      for (const bound of [true, false]) {
        expect(billMatchFailureFor(reason, 'session', bound, true)).not.toBe('unclaimed_invitation');
      }
    }
  });

  it('a bound invitation stays different_account regardless of whether it carries an ID', () => {
    // The re-check: 0098 does not touch this arm. Bound means a real
    // account owns the bill, which is what makes "sign in with it" a step
    // that exists.
    for (const carriesId of [true, false]) {
      expect(billMatchFailureFor(null, 'invitation', true, carriesId)).toBe('different_account');
    }
  });
});

describe('the two invitation arms are genuinely different advice', () => {
  it('bound → sign into the other account; no-ID → there is no other account', () => {
    const bound   = BILL_MATCH_COPY[billMatchFailureFor(null, 'invitation', true,  true)];
    const noId    = BILL_MATCH_COPY[billMatchFailureFor(null, 'invitation', false, false)];

    expect(bound.next).toMatch(/sign in with/i);
    // The whole point of the split: telling this person to sign into an
    // account that does not exist is the wall the bucket split was built to
    // stop building.
    expect(noId.next).not.toMatch(/sign in with/i);
    expect(noId.next).toMatch(/ask reception/i);
    expect(bound.heading).not.toBe(noId.heading);
  });
});

describe('the mapper is total, and emits nothing that has no copy', () => {
  it('every (reason × kind × bound × carriesId) combination lands on a bucket that has copy', () => {
    let seen = 0;
    for (const reason of REFUSALS) {
      for (const kind of ['invitation', 'session'] as const) {
        for (const bound of [true, false]) {
          for (const carriesId of [true, false]) {
            const bucket = billMatchFailureFor(reason, kind, bound, carriesId);
            expect(BILL_MATCH_COPY[bucket]).toBeTruthy();
            seen += 1;
          }
        }
      }
    }
    expect(seen).toBe(REFUSALS.length * 2 * 2 * 2);
  });

  it('the set of buckets the mapper can EMIT equals the set that has copy', () => {
    // The converse of reachability. If someone adds a bucket and forgets to
    // route to it, this fails — which is the whole point.
    const emitted = new Set<BillMatchFailure>();
    for (const reason of REFUSALS) {
      for (const kind of ['invitation', 'session'] as const) {
        for (const bound of [true, false]) {
          for (const carriesId of [true, false]) emitted.add(billMatchFailureFor(reason, kind, bound, carriesId));
        }
      }
    }
    expect([...emitted].sort()).toEqual(Object.keys(BILL_MATCH_COPY).sort());
  });
});

describe('no bucket leaks anything about another account', () => {
  it('the copy is static text with no interpolation', () => {
    for (const [bucket, copy] of Object.entries(BILL_MATCH_COPY)) {
      for (const line of [copy.heading, copy.body, copy.next]) {
        expect(line, bucket).not.toMatch(/\$\{/);
        expect(line, bucket).not.toMatch(/@/);        // no email address, ever
      }
    }
  });

  it('every bucket gives a heading, a statement and a next step', () => {
    for (const [bucket, copy] of Object.entries(BILL_MATCH_COPY)) {
      expect(copy.heading.length, bucket).toBeGreaterThan(10);
      expect(copy.body.length,    bucket).toBeGreaterThan(20);
      expect(copy.next.length,    bucket).toBeGreaterThan(20);
    }
  });
});
