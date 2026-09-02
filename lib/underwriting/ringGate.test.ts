import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── The gate, not the scorer ───────────────────────────────────────────
//
// identityGraph.test.ts proves the thresholds are right. This file proves
// the gate is actually WIRED — which is the failure this codebase has
// already had once: audit F-10 found approved_credit_limit written,
// displayed, and read by no gate anywhere. A scorer nothing calls is
// decoration, so these tests assert the call and its consequences.

const assessApplicantRing = vi.fn();
const recordIdentitySignals = vi.fn();

vi.mock('@/lib/security/identitySignals', () => ({
  assessApplicantRing:   (...args: unknown[]) => assessApplicantRing(...args),
  recordIdentitySignals: (...args: unknown[]) => recordIdentitySignals(...args),
}));

import { claimCreditForPlan, CLAIM_MESSAGES } from './claimCredit';

const clear  = { score: 0,   verdict: 'clear'  as const, signals: [], corroboratingKinds: 0, degraded: false };
const review = { score: 80,  verdict: 'review' as const, signals: [], corroboratingKinds: 2, degraded: false };
const block  = { score: 150, verdict: 'block'  as const, signals: [], corroboratingKinds: 2, degraded: false };

/**
 * A service client that fails the FIRST read claimCreditForPlan does.
 *
 * That is enough for these tests: it means a claim which reaches the
 * headroom read returns a benign 'unavailable', so "did the ring gate
 * refuse?" is unambiguous — 'ring_blocked' can only come from the gate,
 * and anything else means the gate let the claim past.
 */
const svcThatCannotRead = () => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: { message: 'unavailable' } }),
        in:          async () => ({ data: null, error: { message: 'unavailable' } }),
      }),
    }),
  }),
  rpc: async () => ({ data: null, error: { message: 'unavailable' } }),
});

const baseInput = {
  planId:         'plan-1',
  patientId:      'patient-1',
  planType:       2 as const,
  totalAmount:    1000,
  salaryDay:      25,
  expectedStatus: 'pending_acceptance' as const,
  termsVersion:   'v1',
  privacyVersion: 'v1',
  ring: {
    identityHash: 'identity-hash-abc',
    signals: { deviceId: 'dev-1', ip: '196.25.1.7', email: 'a@b.com', phone: '+27821234567', cardFingerprint: null },
  },
};

beforeEach(() => {
  assessApplicantRing.mockReset();
  recordIdentitySignals.mockReset().mockResolvedValue(1);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the gate is wired', () => {
  it('refuses a blocked claim before spending a read or taking the lock', async () => {
    assessApplicantRing.mockResolvedValue(block);
    const svc = svcThatCannotRead();
    const rpc = vi.spyOn(svc, 'rpc');

    const result = await claimCreditForPlan(svc, baseInput);

    expect(result).toMatchObject({ ok: false, reason: 'ring_blocked', message: CLAIM_MESSAGES.ring_blocked });
    // Nothing was spent: no RPC, so no lock and no schedule.
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not record a refused claim — an attacker must not seed the ledger', async () => {
    assessApplicantRing.mockResolvedValue(block);
    await claimCreditForPlan(svcThatCannotRead(), baseInput);
    expect(recordIdentitySignals).not.toHaveBeenCalled();
  });

  it('assesses the applicant with the identity and signals it was given', async () => {
    assessApplicantRing.mockResolvedValue(clear);
    await claimCreditForPlan(svcThatCannotRead(), baseInput);
    expect(assessApplicantRing).toHaveBeenCalledWith(
      expect.objectContaining({ identityHash: 'identity-hash-abc', raw: baseInput.ring.signals }),
    );
  });
});

describe('phase 1 boundary: block refuses, review does not', () => {
  it('lets a review verdict through — there is no plan-review queue yet', async () => {
    assessApplicantRing.mockResolvedValue(review);
    const result = await claimCreditForPlan(svcThatCannotRead(), baseInput);
    // Reaches the headroom read and fails there, benignly — the point is
    // that it is NOT ring_blocked.
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).not.toBe('ring_blocked');
  });

  it('still records and logs a review verdict so the queue can be sized', async () => {
    assessApplicantRing.mockResolvedValue(review);
    await claimCreditForPlan(svcThatCannotRead(), baseInput);
    expect(console.warn).toHaveBeenCalled();
    expect(recordIdentitySignals).toHaveBeenCalled();
  });
});

describe('a fraud control never breaks checkout', () => {
  it('lets the claim proceed when assessment throws', async () => {
    assessApplicantRing.mockRejectedValue(new Error('database on fire'));
    const result = await claimCreditForPlan(svcThatCannotRead(), baseInput);
    if (!result.ok) expect(result.reason).not.toBe('ring_blocked');
  });

  it('abstains rather than assessing when there is no verified identity', async () => {
    const result = await claimCreditForPlan(svcThatCannotRead(), {
      ...baseInput,
      ring: { identityHash: null, signals: baseInput.ring.signals },
    });
    expect(assessApplicantRing).not.toHaveBeenCalled();
    if (!result.ok) expect(result.reason).not.toBe('ring_blocked');
  });
});

describe('recording happens after assessment, never before', () => {
  it('assesses first so an applicant is never counted against themselves', async () => {
    const order: string[] = [];
    assessApplicantRing.mockImplementation(async () => { order.push('assess'); return clear; });
    recordIdentitySignals.mockImplementation(async () => { order.push('record'); return 1; });

    await claimCreditForPlan(svcThatCannotRead(), baseInput);

    expect(order).toEqual(['assess', 'record']);
  });

  it('records the applicant so the NEXT ring member has something to match', async () => {
    assessApplicantRing.mockResolvedValue(clear);
    await claimCreditForPlan(svcThatCannotRead(), baseInput);
    expect(recordIdentitySignals).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId:    'patient-1',
        identityHash: 'identity-hash-abc',
        surface:      'accept_plan',
      }),
    );
  });
});
