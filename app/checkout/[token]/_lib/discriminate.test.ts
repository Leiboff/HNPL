import { describe, it, expect } from 'vitest';
import {
  discriminateExistingUser,
  type ExistingAuthUser,
  type DiscriminationResult,
} from './discriminate';

// ─── Discriminator — the rule that fixes decline-retry + abandon-resume ───
//
// Each test maps to a concrete operational scenario. The proof of the
// commit-blocker fix is the "decline-retry" case: BEFORE this change,
// the second pass through initiateCheckout saw a confirmed user
// (because email_confirm: true had just set it) and rejected. AFTER:
// plan ownership trumps the confirmed flag and reuse fires.

const USER_A: ExistingAuthUser = {
  id:                 'a1111111-1111-1111-1111-111111111111',
  email_confirmed_at: '2026-06-15T10:00:00Z',
};
const USER_B: ExistingAuthUser = {
  id:                 'b2222222-2222-2222-2222-222222222222',
  email_confirmed_at: '2026-06-15T10:00:00Z',
};
const UNCONFIRMED_USER: ExistingAuthUser = {
  id:                 'c3333333-3333-3333-3333-333333333333',
  email_confirmed_at: null,
};

describe('discriminateExistingUser — no existing auth row', () => {
  it('returns create-new (fresh patient, first attempt)', () => {
    const out = discriminateExistingUser(null, null);
    expect(out).toEqual({ action: 'create-new' });
  });

  it('returns create-new even when plan happens to have a stale patient_id (defensive)', () => {
    // Shouldn't happen in practice — if no auth row exists for the
    // invitation's email, the plan can't be bound to that user. But
    // we don't crash if data is inconsistent.
    const out = discriminateExistingUser(null, 'd4444444-4444-4444-4444-444444444444');
    expect(out).toEqual({ action: 'create-new' });
  });
});

describe('discriminateExistingUser — returning checkout patient (decline-retry / abandon-resume)', () => {
  it('reuses when plan.patient_id matches the existing confirmed user — the decline-retry happy path', () => {
    // The user was created on the first pass with email_confirm: true,
    // and the plan was bound to them in step 6 of initiateCheckout
    // BEFORE the Peach call. On retry, the plan still points at
    // them; reuse cleanly.
    const out = discriminateExistingUser(USER_A, USER_A.id);
    expect(out).toEqual({ action: 'reuse', userId: USER_A.id });
  });

  it('reuses identically for a returning unconfirmed orphan whose plan is bound', () => {
    // Edge: an AUTH_ONLY orphan from an even earlier botched flow that
    // somehow already has the plan bound. Treat the same as the normal
    // returning patient.
    const out = discriminateExistingUser(
      UNCONFIRMED_USER,
      UNCONFIRMED_USER.id,
    );
    expect(out).toEqual({ action: 'reuse', userId: UNCONFIRMED_USER.id });
  });
});

describe('discriminateExistingUser — organic-account email collision (#6 race)', () => {
  it('rejects when confirmed user exists but plan binds to a different user', () => {
    // The race the previous report flagged: patient confirmed an
    // organic account between bill creation and link click. The plan
    // from this invitation was bound to USER_B (the original target —
    // or in the new-patient case, null), but USER_A is the confirmed
    // organic account. Reject with login guidance.
    const out = discriminateExistingUser(USER_A, USER_B.id);
    expect(out).toEqual({ action: 'reject-organic-collision', existingUserId: USER_A.id });
  });

  it('rejects when confirmed user exists and plan is unbound (new-patient flow that hit an organic email after the fact)', () => {
    // The plan was created on the new-patient fork (patient_id = null)
    // but in the meantime an organic confirmed user appeared at this
    // email. Reject so the patient logs in to their organic account
    // and the bill flows through the existing-patient dashboard path.
    const out = discriminateExistingUser(USER_A, null);
    expect(out).toEqual({ action: 'reject-organic-collision', existingUserId: USER_A.id });
  });
});

describe('discriminateExistingUser — unconfirmed orphan with unbound plan', () => {
  it('reuses the dormant orphan (AUTH_ONLY case)', () => {
    // findExistingAuthUser specifically catches AUTH_ONLY orphans (an
    // auth.users row with no matching profile, no confirmed email).
    // Nothing recognises this email as a "real" account yet — let
    // initiateCheckout adopt the orphan and bind the plan.
    const out = discriminateExistingUser(UNCONFIRMED_USER, null);
    expect(out).toEqual({ action: 'reuse', userId: UNCONFIRMED_USER.id });
  });
});

describe('discriminateExistingUser — DiscriminationResult union covers every path', () => {
  it('every observed return value is one of the three documented actions', () => {
    // Belt-and-braces: exhaustively call the matrix and assert every
    // result is one of the typed actions. Anything sneaking in
    // outside the union would surface here.
    const matrix: Array<DiscriminationResult> = [
      discriminateExistingUser(null, null),
      discriminateExistingUser(null, USER_A.id),
      discriminateExistingUser(USER_A, USER_A.id),
      discriminateExistingUser(USER_A, USER_B.id),
      discriminateExistingUser(USER_A, null),
      discriminateExistingUser(UNCONFIRMED_USER, UNCONFIRMED_USER.id),
      discriminateExistingUser(UNCONFIRMED_USER, null),
    ];
    for (const r of matrix) {
      expect(['create-new', 'reuse', 'reject-organic-collision']).toContain(r.action);
    }
  });
});
