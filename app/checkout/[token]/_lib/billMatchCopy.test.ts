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

type Refusal = ClaimOutcome['reason'] | null;

const REFUSALS: Refusal[] = [
  null, 'already_bound', 'no_profile_id', 'id_mismatch', 'decrypt_failed', 'write_failed',
];

describe('each bucket has at least one input that produces it', () => {
  const cases: Array<[BillMatchFailure, Refusal, 'invitation' | 'session', boolean]> = [
    // The signed-in patient's account holds a different ID from the bill's.
    ['id_mismatch',          'id_mismatch',   'session',    false],
    // Their account has no ID at all — the biggest bucket after the cleanup.
    ['no_account_id',        'no_profile_id', 'session',    false],
    // Unreadable ciphertext or a failed write. Never the patient's fault.
    ['our_fault',            'decrypt_failed','session',    false],
    // An emailed bill already bound to a real account, opened by someone else.
    ['different_account',    null,            'invitation', true],
    // An emailed bill bound to nobody, opened by someone else. Re-derived
    // when every bill gained an ID; before that it was folded into
    // different_account and got advice that cannot work here.
    ['unclaimed_invitation', null,            'invitation', false],
  ];

  it.each(cases)('%s', (expected, reason, kind, bound) => {
    expect(billMatchFailureFor(reason, kind, bound)).toBe(expected);
  });

  it('all five are covered by the table above — no bucket is left unproven', () => {
    const proven = new Set(cases.map(([bucket]) => bucket));
    expect([...proven].sort()).toEqual(Object.keys(BILL_MATCH_COPY).sort());
  });
});

describe('the two invitation arms are genuinely different advice', () => {
  it('bound → sign into the other account; unbound → there is no other account', () => {
    const bound   = BILL_MATCH_COPY[billMatchFailureFor(null, 'invitation', true)];
    const unbound = BILL_MATCH_COPY[billMatchFailureFor(null, 'invitation', false)];

    expect(bound.next).toMatch(/sign in with/i);
    // The whole point of the split: telling this person to sign into an
    // account that does not exist is the wall the four-bucket version was
    // built to stop building.
    expect(unbound.next).not.toMatch(/sign in with/i);
    expect(unbound.next).toMatch(/ask reception/i);
    expect(bound.heading).not.toBe(unbound.heading);
  });
});

describe('the mapper is total, and emits nothing that has no copy', () => {
  it('every (reason × kind × bound) combination lands on a bucket that has copy', () => {
    let seen = 0;
    for (const reason of REFUSALS) {
      for (const kind of ['invitation', 'session'] as const) {
        for (const bound of [true, false]) {
          const bucket = billMatchFailureFor(reason, kind, bound);
          expect(BILL_MATCH_COPY[bucket]).toBeTruthy();
          seen += 1;
        }
      }
    }
    expect(seen).toBe(REFUSALS.length * 2 * 2);
  });

  it('the set of buckets the mapper can EMIT equals the set that has copy', () => {
    // The converse of reachability. If someone adds a bucket and forgets to
    // route to it, this fails — which is the whole point.
    const emitted = new Set<BillMatchFailure>();
    for (const reason of REFUSALS) {
      for (const kind of ['invitation', 'session'] as const) {
        for (const bound of [true, false]) emitted.add(billMatchFailureFor(reason, kind, bound));
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
