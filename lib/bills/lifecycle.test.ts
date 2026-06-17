import { describe, it, expect } from 'vitest';
import {
  deriveBillLifecycleStatus,
  billLifecycleChip,
} from './lifecycle';

// ─── Bill lifecycle helper — single source of truth ───────────────────────
//
// The helper is THE single source of truth for the four practice-facing
// lifecycle labels (Sent / Viewed / Paid / Expired). Every surface
// (BillsBlock, BillWaitingPanel, CSV / PDF export) reads through it,
// so the rules locked in here are load-bearing.
//
// These tests pin three things that have already bitten us once on
// adjacent features:
//
//   1. The "paid" label wins over EVERYTHING else once the plan moves
//      to active / completed / defaulted. A practice-side display that
//      regressed to 'expired' for a defaulted plan would be wrong —
//      the practice has been paid, the collection risk is HNPL's.
//   2. An invitation past expires_at is "expired" — UNLESS the plan
//      has already gone active (in which case rule #1 wins).
//   3. For Scenario A (existing patient, NO invitation row), the
//      lifecycle still progresses Sent → Viewed → Paid correctly,
//      driven purely off plan.status, with no viewed_at signal.

const NOW = new Date('2026-06-17T10:00:00Z');
const PAST_EXPIRY   = new Date('2026-06-10T00:00:00Z').toISOString();
const FUTURE_EXPIRY = new Date('2026-06-24T00:00:00Z').toISOString();
const SOME_VIEWED   = new Date('2026-06-16T15:00:00Z').toISOString();

describe('deriveBillLifecycleStatus', () => {
  describe('Paid wins over everything else', () => {
    it.each([
      ['active'    as const],
      ['completed' as const],
      ['defaulted' as const],
    ])('planStatus=%s → paid', (planStatus) => {
      expect(
        deriveBillLifecycleStatus({
          planStatus,
          invitationViewedAt:   null,
          invitationAcceptedAt: null,
          invitationExpiresAt:  PAST_EXPIRY,
          now: NOW,
        }),
      ).toBe('paid');
    });

    it('paid even when the invitation row is past expiry (the plan flag wins)', () => {
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'active',
          invitationViewedAt:   null,
          invitationAcceptedAt: null,
          invitationExpiresAt:  PAST_EXPIRY,
          now: NOW,
        }),
      ).toBe('paid');
    });
  });

  describe('Cancelled / declined plans → expired', () => {
    it.each([['cancelled' as const], ['declined' as const]])(
      'planStatus=%s → expired',
      (planStatus) => {
        expect(
          deriveBillLifecycleStatus({
            planStatus,
            invitationViewedAt:   SOME_VIEWED,
            invitationAcceptedAt: null,
            invitationExpiresAt:  FUTURE_EXPIRY,
            now: NOW,
          }),
        ).toBe('expired');
      },
    );
  });

  describe('Invitation past expiry without acceptance → expired', () => {
    it('pending_acceptance + expires_at in the past + never accepted → expired', () => {
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'pending_acceptance',
          invitationViewedAt:   SOME_VIEWED,
          invitationAcceptedAt: null,
          invitationExpiresAt:  PAST_EXPIRY,
          now: NOW,
        }),
      ).toBe('expired');
    });

    it('expired ignored once accepted_at is set (paid path may still resolve via plan.status)', () => {
      // accepted_at set + plan still pending_first_payment ≠ "expired"
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'pending_first_payment',
          invitationViewedAt:   SOME_VIEWED,
          invitationAcceptedAt: SOME_VIEWED,
          invitationExpiresAt:  PAST_EXPIRY,
          now: NOW,
        }),
      ).toBe('viewed');
    });
  });

  describe('Viewed', () => {
    it('Scenario B: invitation.viewed_at set, link not yet expired → viewed', () => {
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'pending_acceptance',
          invitationViewedAt:   SOME_VIEWED,
          invitationAcceptedAt: null,
          invitationExpiresAt:  FUTURE_EXPIRY,
          now: NOW,
        }),
      ).toBe('viewed');
    });

    it('Scenario A: no invitation row, plan moved past pending_acceptance → viewed', () => {
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'pending_first_payment',
          invitationViewedAt:   null,
          invitationAcceptedAt: null,
          invitationExpiresAt:  null,
          now: NOW,
        }),
      ).toBe('viewed');
    });
  });

  describe('Sent (the default)', () => {
    it('Scenario B: invitation row exists, never opened, not expired → sent', () => {
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'pending_acceptance',
          invitationViewedAt:   null,
          invitationAcceptedAt: null,
          invitationExpiresAt:  FUTURE_EXPIRY,
          now: NOW,
        }),
      ).toBe('sent');
    });

    it('Scenario A: no invitation row, plan still pending_acceptance → sent', () => {
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'pending_acceptance',
          invitationViewedAt:   null,
          invitationAcceptedAt: null,
          invitationExpiresAt:  null,
          now: NOW,
        }),
      ).toBe('sent');
    });
  });

  describe('Date inputs', () => {
    it('accepts Date objects as well as ISO strings', () => {
      expect(
        deriveBillLifecycleStatus({
          planStatus:           'pending_acceptance',
          invitationViewedAt:   new Date('2026-06-16T15:00:00Z'),
          invitationAcceptedAt: null,
          invitationExpiresAt:  new Date('2026-06-24T00:00:00Z'),
          now: NOW,
        }),
      ).toBe('viewed');
    });
  });
});

describe('billLifecycleChip', () => {
  it('returns the four expected labels', () => {
    expect(billLifecycleChip('sent').label).toBe('Sent');
    expect(billLifecycleChip('viewed').label).toBe('Viewed');
    expect(billLifecycleChip('paid').label).toBe('Paid');
    expect(billLifecycleChip('expired').label).toBe('Expired');
  });

  it('every variant carries non-empty hint copy (used as the tooltip + aria-label)', () => {
    for (const s of ['sent', 'viewed', 'paid', 'expired'] as const) {
      expect(billLifecycleChip(s).hint.length).toBeGreaterThan(0);
    }
  });
});
