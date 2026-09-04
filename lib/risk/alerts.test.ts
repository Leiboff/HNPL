import { describe, it, expect } from 'vitest';
import { alertsFor, classifyReason } from './alerts';

// ─── Naming the alerts ──────────────────────────────────────────────────────
//
// The audit asks for merchant velocity alerts, identity velocity alerts and
// duplicate instrument/device/identity alerts by name. This is where those
// names exist in code, so the alert, the runbook section and the finding all
// use one word for one thing.
//
// The classification is not cosmetic: the METRIC matters as much as the
// dimension. A device seen forty times by one account is volume; a device
// seen by four ACCOUNTS is the duplicate-device finding. Collapsing the two
// is how a queue fills with noise and the one real link is missed.

describe('classifyReason', () => {
  it('separates a duplicate device from device volume', () => {
    expect(classifyReason('signup', { rule: 'device', metric: 'accounts' }).name).toBe('duplicate_device');
    expect(classifyReason('signup', { rule: 'device', metric: 'events' }).name).toBe('network_velocity');
  });

  it('separates a duplicate instrument from card volume', () => {
    expect(classifyReason('plan_acceptance', { rule: 'card', metric: 'accounts' }).name).toBe('duplicate_instrument');
    expect(classifyReason('card_payment',    { rule: 'card', metric: 'events'   }).name).toBe('merchant_velocity');
  });

  it('names a duplicate identity for both the SA ID and the KYC session', () => {
    expect(classifyReason('kyc_session', { rule: 'identity',    metric: 'accounts' }).name).toBe('duplicate_identity');
    expect(classifyReason('kyc_session', { rule: 'kyc_session', metric: 'accounts' }).name).toBe('duplicate_identity');
  });

  it('treats phone, email and mailbox domain as identity velocity', () => {
    for (const rule of ['phone', 'email', 'email_domain']) {
      expect(classifyReason('signup', { rule, metric: 'events' }).name).toBe('identity_velocity');
    }
  });

  it('treats practice, brand, provider and payout account as merchant velocity', () => {
    for (const rule of ['practice', 'practice_group', 'provider', 'bank_account']) {
      expect(classifyReason('counter_session', { rule, metric: 'events' }).name).toBe('merchant_velocity');
    }
  });

  it('gives the customer-merchant edge its own name', () => {
    expect(classifyReason('plan_acceptance', { rule: 'customer_merchant', metric: 'events' }).name)
      .toBe('customer_merchant_link');
  });

  it('names the platform-level outcomes', () => {
    expect(classifyReason('kyc_session',     { rule: 'budget' }).name).toBe('budget_exhausted');
    expect(classifyReason('signup',          { rule: 'kill_switch' }).name).toBe('kill_switch');
    expect(classifyReason('plan_acceptance', { rule: 'block' }).name).toBe('standing_block');
    expect(classifyReason('payout_release',  { rule: 'dependency_unavailable' }).name).toBe('control_unavailable');
  });

  it('falls back to "other" rather than mislabelling something new', () => {
    expect(classifyReason('signup', { rule: 'something_new' }).name).toBe('other');
  });
});

describe('severity', () => {
  it('pages only on unambiguous ring evidence and platform-level stops', () => {
    for (const reason of [
      { rule: 'identity', metric: 'accounts' },
      { rule: 'card',     metric: 'accounts' },
      { rule: 'budget' },
      { rule: 'kill_switch' },
      { rule: 'dependency_unavailable' },
    ]) {
      expect(classifyReason('plan_acceptance', reason).severity, JSON.stringify(reason)).toBe('page');
    }
  });

  it('does not page on a busy practice or a busy network', () => {
    // An alert that pages on a busy dental practice will be muted within a
    // week — and the duplicate-identity page will be muted along with it.
    expect(classifyReason('counter_session', { rule: 'practice', metric: 'events' }).severity).toBe('ticket');
    expect(classifyReason('signup',          { rule: 'subnet',   metric: 'events' }).severity).toBe('ticket');
    expect(classifyReason('signup',          { rule: 'device',   metric: 'accounts' }).severity).toBe('ticket');
  });
});

describe('alertsFor', () => {
  it('de-duplicates by name so one decision does not raise five copies', () => {
    const alerts = alertsFor('plan_acceptance', [
      { rule: 'card', metric: 'accounts' },
      { rule: 'card', metric: 'accounts' },
      { rule: 'identity', metric: 'accounts' },
    ]);
    expect(alerts.map((a) => a.name).sort()).toEqual(['duplicate_identity', 'duplicate_instrument']);
  });

  it('keeps the more severe instance when one name arrives at two severities', () => {
    // A page must never be downgraded by a later ticket-level reason that
    // happens to classify the same way.
    const alerts = alertsFor('plan_acceptance', [
      { rule: 'card', metric: 'events' },     // merchant_velocity, ticket
      { rule: 'card', metric: 'accounts' },   // duplicate_instrument, page
    ]);
    expect(alerts.find((a) => a.name === 'duplicate_instrument')?.severity).toBe('page');
  });

  it('returns nothing for a decision with no reasons', () => {
    expect(alertsFor('signup', [])).toEqual([]);
  });
});
