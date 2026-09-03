import { describe, it, expect } from 'vitest';
import { diffFactorSnapshots, type FactorSnapshotRow } from './mfaFactorDiff';

// ─── Named test 9 (core) — a factor removed out-of-band is detected ────
//
// The self-service audit hooks cannot see a factor deleted with the
// service-role admin API, because that never touches the app. The
// scheduled diff is what catches it: the factor is in the previous
// snapshot (state table) and gone from the live one, so the diff yields a
// 'mfa_factor_disappeared' event, which the cron writes to
// admin_audit_log. The DB half (the CHECK accepts 'auth_factor', the row
// lands) is proved in the pglite test; this proves the decision.

const f = (id: string, user: string, status = 'verified'): FactorSnapshotRow => ({
  factor_id: id, user_id: user, factor_type: 'totp', status,
});

describe('diffFactorSnapshots', () => {
  it('[named 9] a verified factor present-then-absent → disappeared event', () => {
    const previous = [f('fac-1', 'admin-1')];
    const current: FactorSnapshotRow[] = []; // service-role unenrol removed it
    const events = diffFactorSnapshots(previous, current);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'mfa_factor_disappeared',
      userId: 'admin-1',
      factorId: 'fac-1',
      fromStatus: 'verified',
      toStatus: null,
    });
  });

  it('a brand-new factor → appeared event', () => {
    const events = diffFactorSnapshots([], [f('fac-2', 'sales-1', 'unverified')]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'mfa_factor_appeared', toStatus: 'unverified' });
  });

  it('unverified → verified on the same id → status_changed event', () => {
    const events = diffFactorSnapshots(
      [f('fac-3', 'admin-1', 'unverified')],
      [f('fac-3', 'admin-1', 'verified')],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'mfa_factor_status_changed', fromStatus: 'unverified', toStatus: 'verified',
    });
  });

  it('no change → no events (the quiet steady state)', () => {
    const same = [f('fac-1', 'admin-1'), f('fac-2', 'sales-1')];
    expect(diffFactorSnapshots(same, same)).toEqual([]);
  });

  it('a mixed run is ordered appeared, then changed, then disappeared', () => {
    const previous = [f('gone', 'u1'), f('chg', 'u2', 'unverified')];
    const current  = [f('new', 'u3'), f('chg', 'u2', 'verified')];
    const events = diffFactorSnapshots(previous, current);
    expect(events.map((e) => e.action)).toEqual([
      'mfa_factor_appeared', 'mfa_factor_status_changed', 'mfa_factor_disappeared',
    ]);
  });
});
