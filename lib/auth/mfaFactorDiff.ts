// ─── Diffing two auth.mfa_factors snapshots ────────────────────────────
//
// The pure core of the scheduled factor audit (item F). Given the factors
// the previous run recorded and the factors live now, it decides which
// admin_audit_log rows to write. Kept pure and side-effect-free so the
// decision — which is the security-relevant part — is unit-testable
// without a database, a cron, or a clock.
//
// It answers three questions per factor:
//   • appeared     — a factor id in `current` that `previous` never saw.
//                    A verified appearance on a privileged account is an
//                    enrolment; an appearance the app did not record is
//                    the interesting case.
//   • disappeared  — a factor id `previous` had that `current` lacks. This
//                    is the one the self-service audit CANNOT catch: a
//                    factor removed with the service-role admin API never
//                    touches the app. Named test 9 turns on exactly this.
//   • status change — same id, status moved (e.g. unverified → verified).

export type FactorSnapshotRow = {
  factor_id:   string;
  user_id:     string;
  factor_type: string;
  status:      string;
};

export type FactorDiffEvent = {
  action:
    | 'mfa_factor_appeared'
    | 'mfa_factor_disappeared'
    | 'mfa_factor_status_changed';
  userId:      string;
  factorId:    string;
  factorType:  string;
  fromStatus:  string | null;
  toStatus:    string | null;
};

/**
 * Compare a previous snapshot (the state table) against the live one and
 * return the changes, in a stable order (appeared, then status-changed,
 * then disappeared; each sorted by factor id) so the output is
 * deterministic for tests and for a human reading the log.
 */
export function diffFactorSnapshots(
  previous: readonly FactorSnapshotRow[],
  current:  readonly FactorSnapshotRow[],
): FactorDiffEvent[] {
  const prevById = new Map(previous.map((r) => [r.factor_id, r]));
  const currById = new Map(current.map((r) => [r.factor_id, r]));

  const appeared:  FactorDiffEvent[] = [];
  const changed:   FactorDiffEvent[] = [];
  const gone:      FactorDiffEvent[] = [];

  for (const row of current) {
    const before = prevById.get(row.factor_id);
    if (!before) {
      appeared.push({
        action:     'mfa_factor_appeared',
        userId:     row.user_id,
        factorId:   row.factor_id,
        factorType: row.factor_type,
        fromStatus: null,
        toStatus:   row.status,
      });
    } else if (before.status !== row.status) {
      changed.push({
        action:     'mfa_factor_status_changed',
        userId:     row.user_id,
        factorId:   row.factor_id,
        factorType: row.factor_type,
        fromStatus: before.status,
        toStatus:   row.status,
      });
    }
  }

  for (const row of previous) {
    if (!currById.has(row.factor_id)) {
      gone.push({
        action:     'mfa_factor_disappeared',
        userId:     row.user_id,
        factorId:   row.factor_id,
        factorType: row.factor_type,
        fromStatus: row.status,
        toStatus:   null,
      });
    }
  }

  const byId = (a: FactorDiffEvent, b: FactorDiffEvent) => a.factorId.localeCompare(b.factorId);
  appeared.sort(byId);
  changed.sort(byId);
  gone.sort(byId);
  return [...appeared, ...changed, ...gone];
}
