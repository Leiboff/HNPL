import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveNudgeTarget, STEP_LABEL, type ClaimedNudgeRow } from './nudgeCohort';
import { stripComments } from '@/lib/testing/stripComments';
import type { OnboardingFlags } from '@/lib/featureFlags';

// ─── The nudge cohort ───────────────────────────────────────────────────
//
// The rule is "no forward progress", not "signed up a while ago". The
// obvious version — email confirmed N minutes ago and onboarding not
// finished — describes a large number of patients who are actively
// working: the phone step is an SMS round trip, and the identity step
// redirects OFF-SITE to Didit for a ceremony that resolves by webhook,
// during which the patient is not on our site at all. These tests pin the
// parts of that reasoning which are expressible in code.

const FLAGS: OnboardingFlags = { creditCheck: false } as OnboardingFlags;

function row(over: Partial<ClaimedNudgeRow> = {}): ClaimedNudgeRow {
  return {
    id:                   'user-1',
    email:                'patient@example.com',
    first_name:           'Thandi',
    nudge_number:         1,
    phone_verified_at:    null,
    sa_id_number:         null,
    salary_day:           null,
    salary_amount:        null,
    credit_check_status:  null,
    liveness_verified_at: null,
    ...over,
  };
}

describe('resolveNudgeTarget', () => {
  it('names the step the patient actually stopped at', () => {
    const target = resolveNudgeTarget(row(), FLAGS);
    expect(target?.step).toBe('phone');
    expect(target?.stepLabel).toBe(STEP_LABEL['phone']);
  });

  it('moves along the flow as the patient completes steps', () => {
    const afterPhone = resolveNudgeTarget(
      row({ phone_verified_at: '2026-08-01T10:00:00Z' }), FLAGS);
    expect(afterPhone?.step).toBe('salary');

    const afterSalary = resolveNudgeTarget(
      row({ phone_verified_at: '2026-08-01T10:00:00Z', salary_day: 25, salary_amount: 18000 }),
      FLAGS);
    expect(afterSalary?.step).toBe('identity');
  });

  it('returns null for a patient who finished between the claim and the send', () => {
    // The claim already counted the nudge against them, and that is the
    // right trade — but the email must not go out. "You didn't finish your
    // application" landing on someone who just did is the expensive error.
    const done = resolveNudgeTarget(
      row({
        phone_verified_at:    '2026-08-01T10:00:00Z',
        salary_day:           25,
        salary_amount:        18000,
        sa_id_number:         '9001015800085',
        liveness_verified_at: '2026-08-01T10:05:00Z',
      }),
      FLAGS,
    );
    expect(done).toBeNull();
  });

  it('carries the nudge number through, so copy 2 can differ from copy 1', () => {
    expect(resolveNudgeTarget(row({ nudge_number: 2 }), FLAGS)?.nudgeNumber).toBe(2);
  });

  it('has patient-facing wording for every step — no internal ids in an inbox', () => {
    for (const [step, label] of Object.entries(STEP_LABEL)) {
      expect(label, step).not.toMatch(/-/);           // 'credit-check' reads as a rejection
      expect(label.length, step).toBeGreaterThan(8);
    }
  });

  it('tolerates a missing first name rather than greeting nobody', () => {
    const target = resolveNudgeTarget(row({ first_name: null }), FLAGS);
    expect(target).not.toBeNull();
    expect(target?.firstName).toBeNull();
  });
});

describe('the step machine is not duplicated in SQL', () => {
  const sql = stripComments(
    readFileSync('supabase/migrations/0120_onboarding_nudge.sql', 'utf8'),
    { sql: true },
  );

  it('the claim returns FLAGS, never a step name', () => {
    // Migration 0066 already carries a partial copy of the step logic.
    // A second one would drift from lib/onboarding/state.ts, which is the
    // only place that decides what "the next step" means.
    expect(sql).toMatch(/RETURNS TABLE/);
    expect(sql).not.toMatch(/'verify-email'|'credit-check'|next_step/);
  });

  it('excludes an identity session that is still in flight', () => {
    // 'pending' and 'in_review' mean the patient is verifying RIGHT NOW,
    // off-site. 'abandoned', 'expired' and 'declined' are terminal and must
    // NOT shield them from a nudge.
    expect(sql).toMatch(/NOT IN \('pending', 'in_review'\)/);
    expect(sql).not.toMatch(/NOT IN \([^)]*'abandoned'/);
  });

  it('caps the ladder at two and requires recorded T&C acceptance', () => {
    expect(sql).toMatch(/onboarding_nudge_count < 2/);
    expect(sql).toMatch(/terms_accepted_at IS NOT NULL/);
  });

  it('excludes the pre-existing back catalogue via a NULL progress mark', () => {
    // Shipping this must not mail every abandoned signup ever created. The
    // progress column is only set by the triggers in this migration, so
    // rows that predate it stay out.
    expect(sql).toMatch(/onboarding_last_progress_at IS NOT NULL/);
  });

  it('claims atomically, so two overlapping runs cannot both send', () => {
    expect(sql).toMatch(/FOR UPDATE OF p SKIP LOCKED/);
    expect(sql).toMatch(/onboarding_nudge_count\s*=\s*p\.onboarding_nudge_count \+ 1/);
  });

  it('is service-role only — it hands back addresses and causes mail', () => {
    expect(sql).toMatch(/REVOKE ALL\s+ON FUNCTION public\.claim_onboarding_nudges\(INT, INT, INT\) FROM PUBLIC/);
    expect(sql).toMatch(/FROM anon/);
    expect(sql).toMatch(/FROM authenticated/);
    expect(sql).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.claim_onboarding_nudges\(INT, INT, INT\) TO\s+service_role/);
  });

  it('the progress trigger watches every column the state machine reads', () => {
    // If a sixth step lands and its column is not here, its patients look
    // idle the moment they complete it.
    for (const col of [
      'phone_verified_at', 'sa_id_number', 'salary_day', 'salary_amount',
      'credit_check_status', 'liveness_verified_at', 'identity_verification_status',
    ]) {
      expect(sql, col).toMatch(new RegExp(`NEW\\.${col}`));
      expect(sql, col).toMatch(new RegExp(`OLD\\.${col}`));
    }
  });

  it('salary_day is returned as INTEGER — a SMALLINT would fail at call time', () => {
    // profiles.salary_day is int4. A RETURNS TABLE column that disagrees
    // raises "structure of query does not match function result type", and
    // only at call time, so a type test is the only place to catch it
    // without a database.
    expect(sql).toMatch(/salary_day\s+INTEGER/);
    expect(sql).not.toMatch(/salary_day\s+SMALLINT/);
  });
});
