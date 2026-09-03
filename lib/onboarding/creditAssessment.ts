// SERVER-ONLY. Never import in a client component.
//
// ─── Glue between the onboarding actions and the assessment pipeline ────
//
// The pipeline (lib/underwriting/pipeline.ts) is pure sequencing over
// injected clients. This module supplies the real clients, the persistence
// and the patient-facing copy, so the server actions stay readable.
//
// ─── THE COPY IS PART OF THE CORRECTNESS ───────────────────────────────
//
// A patient we could not assess must NOT be told they were refused. The
// two messages below are deliberately different, and the pending one
// deliberately invites a retry: it describes a failure on our side, which
// is what it is. Getting this wrong is not a cosmetic bug — it tells
// someone they were rejected for credit when no such decision was made.
//
// No message anywhere in this module contains an income figure, a score,
// a band or a limit. Those are for the assessment log, not the browser.

import { getPersonScore } from '@/lib/experian/scoreClient';
import { doAffordability } from '@/lib/experian/affordabilityClient';
import { scoreFamily, scorecardPreference } from '@/lib/experian/config';
import { hashIdForLookup } from '@/lib/idEncryption';
import {
  gateIdentityOnScore,
  gateAffordabilityOnIdentity,
  type IdentityGateResult,
  type AssessmentResult,
} from '@/lib/underwriting/pipeline';
import { declaredGross, type DeclaredGross } from '@/lib/underwriting/limit';
import type { ScoreGateDecision } from '@/lib/underwriting/scoreGate';
import type { AffordabilityResolution } from '@/lib/underwriting/affordabilityGate';
import type { AssessmentTrigger } from '@/lib/underwriting/assessmentState';
import {
  buildAssessmentRow,
  recordAssessment,
  applyAssessment,
  cooldownForIdHash,
  readSnapshot,
  readScoreSnapshot,
  saveScoreSnapshot,
} from '@/lib/underwriting/assessmentStore';
import { scoreSnapshotOf } from '@/lib/underwriting/scoreGate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

// ── Patient-facing copy ───────────────────────────────────────────────

/** A substantive refusal. Never used for a technical failure. */
export const SCORE_DECLINE_MESSAGE =
  'We\'re not able to offer you a payment plan at the moment. '
  + 'If you think this is wrong, please contact us.';

/**
 * We could not get an answer. NOT a refusal — the wording says so, and
 * says to come back, because nothing about this patient has been decided.
 */
export const ASSESSMENT_PENDING_MESSAGE =
  'We couldn\'t finish your checks just now — this is on our side, not yours. '
  + 'Please try again in a few minutes.';

/** A patient under review, e.g. a bureau dispute on their record. */
export const ASSESSMENT_REVIEW_MESSAGE =
  'We need to take a closer look at your application. '
  + 'We\'ll be in touch shortly — no further action needed from you.';

export function cooldownMessage(until: Date | undefined): string {
  if (!until) {
    return 'We recently assessed an application for this ID number and can\'t run another check yet.';
  }
  const when = until.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  return `We recently assessed an application for this ID number. `
    + `You're welcome to apply again from ${when}.`;
}

// ── The clients, wired ────────────────────────────────────────────────

export type AssessmentContext = {
  svc: Svc;
  userId: string;
  /** Cleaned, checksum-validated SA ID. */
  idNumber: string;
  trigger: AssessmentTrigger;
  now?: Date;
};

function idHash(idNumber: string): string | null {
  try {
    return hashIdForLookup(idNumber);
  } catch {
    // Encryption misconfiguration. The per-account cooldown on the profile
    // still applies; this only loses the cross-account match.
    console.error('[assessment] could not hash the ID for cooldown matching');
    return null;
  }
}

/**
 * Persist one assessment: append the immutable row, then update the
 * profile's current state.
 *
 * Both halves, always — including on a decline and on a pending. The order
 * matters: the log row is written first and its id is what the profile
 * points at, so a profile can never reference an assessment that was not
 * recorded.
 */
async function persist(
  ctx: AssessmentContext,
  parts: {
    scoreDecision: ScoreGateDecision | null;
    resolution: AffordabilityResolution | null;
    limit: Parameters<typeof buildAssessmentRow>[0]['limit'];
    identityFailed?: boolean;
    declaredIncome: number | null;
    scoreSnapshot?: Parameters<typeof buildAssessmentRow>[0]['scoreSnapshot'];
  },
): Promise<void> {
  const now = ctx.now ?? new Date();

  const row = buildAssessmentRow({
    patientId:        ctx.userId,
    saIdLookupHash:   idHash(ctx.idNumber),
    trigger:          ctx.trigger,
    scoreFamilyLabel: scoreFamily().label,
    scoreDecision:    parts.scoreDecision,
    resolution:       parts.resolution,
    limit:            parts.limit,
    identityFailed:   parts.identityFailed,
    declaredIncome:   parts.declaredIncome,
    scoreSnapshot:    parts.scoreSnapshot ?? null,
  });

  const id = await recordAssessment(ctx.svc, row);
  if (id === null) return;   // already logged loudly

  await applyAssessment(ctx.svc, ctx.userId, row, id, now);
}

/**
 * Has this ID been declined recently enough to still be in cooldown?
 *
 * Checks BOTH the ID blind index (catches a re-registration under a new
 * email) and the current profile (catches the ordinary case where the
 * assessment log read fails).
 */
export async function assessmentPrecheck(
  ctx: AssessmentContext,
): Promise<{ blocked: true; reason: string; until?: Date } | { blocked: false }> {
  const now  = ctx.now ?? new Date();
  const hash = idHash(ctx.idNumber);

  if (hash !== null) {
    const until = await cooldownForIdHash(ctx.svc, hash, now);
    if (until !== null) return { blocked: true, reason: 'cooldown', until };
  }

  const snapshot = await readSnapshot(ctx.svc, ctx.userId);
  if (snapshot?.cooldownUntil) {
    const until = new Date(snapshot.cooldownUntil);
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) {
      return { blocked: true, reason: 'cooldown', until };
    }
  }

  return { blocked: false };
}

/**
 * Run the score gate around a billable identity ceremony.
 *
 * `startIdentity` is the caller's own identity work. It is invoked ONLY
 * when the score passes — that is the guarantee this whole arrangement
 * exists to provide, and it is enforced by the pipeline rather than by
 * the caller remembering to check.
 */
export async function gateIdentityOnBureauScore<T>(
  ctx: AssessmentContext,
  startIdentity: () => Promise<T>,
): Promise<IdentityGateResult<T>> {
  const family = scoreFamily();

  const result = await gateIdentityOnScore<T>({
    score:       (id) => getPersonScore(id),
    preference:  scorecardPreference(),
    cards:       family.cards,
    startIdentity,
    precheck:    () => assessmentPrecheck(ctx),
    recordScore: async (decision) => {
      // ─── One row per ASSESSMENT, not one per stage ─────────────────
      //
      // The assessment spans two requests: the score here, the pricing at
      // the affordability step. `credit_assessments` is append-only, so
      // the second cannot amend the first.
      //
      // Writing a row here on a PASS would log every eventually-approved
      // customer as a `pending` assessment — inflating the pending count
      // by one per approval and splitting each assessment across two
      // rows, neither of them complete. So a passing score is carried
      // forward on the profile instead, and the pricing step writes the
      // single row with both halves on it.
      //
      // A TERMINAL score — a decline, or a pending we cannot get past —
      // ends the assessment here, so it writes its row here. Declines
      // especially: they are half the population calibration needs.
      const snapshot = scoreSnapshotOf(decision);

      if (snapshot !== null) {
        await saveScoreSnapshot(ctx.svc, ctx.userId, snapshot);
        return;
      }

      await persist(ctx, {
        scoreDecision: decision,
        resolution: null,
        limit: null,
        declaredIncome: null,
      });
    },
  }, ctx.idNumber);

  return result;
}

/**
 * Run the affordability enquiry and price the limit, once identity has
 * passed. Persists whatever it decides.
 */
export async function assessAffordability(
  ctx: AssessmentContext,
  input: {
    scoreDecision: ScoreGateDecision | null;
    band: Parameters<typeof gateAffordabilityOnIdentity>[1]['scoreBand'];
    identityStatus: () => Promise<'passed' | 'failed' | 'pending'>;
    declaredIncomeRands: number | null;
  },
): Promise<AssessmentResult> {
  const declared: DeclaredGross | null =
    input.declaredIncomeRands !== null && input.declaredIncomeRands > 0
      ? declaredGross(input.declaredIncomeRands)
      : null;

  // The score the identity step left behind, so the row written below is
  // the complete record of one assessment rather than half of one.
  const scoreSnapshot = await readScoreSnapshot(ctx.svc, ctx.userId);

  const result = await gateAffordabilityOnIdentity(
    {
      identityStatus: input.identityStatus,
      affordability:  (id) => doAffordability(id),
    },
    { idNumber: ctx.idNumber, scoreBand: input.band, declared },
  );

  if (result.kind === 'assessed') {
    await persist(ctx, {
      scoreDecision:  input.scoreDecision,
      resolution:     result.resolution,
      limit:          result.limit,
      declaredIncome: input.declaredIncomeRands,
      scoreSnapshot,
    });
  } else if (result.kind === 'pending') {
    await persist(ctx, {
      scoreDecision:  input.scoreDecision,
      resolution:     { kind: 'pending', detail: result.detail, alert: result.alert },
      limit:          null,
      declaredIncome: input.declaredIncomeRands,
      scoreSnapshot,
    });
  } else {
    // identity_not_passed. Recorded as an identity-gate stop rather than a
    // decline of the applicant's affordability, which was never measured.
    await persist(ctx, {
      scoreDecision:  input.scoreDecision,
      resolution:     null,
      limit:          null,
      identityFailed: result.status === 'failed',
      declaredIncome: input.declaredIncomeRands,
      scoreSnapshot,
    });
  }

  return result;
}

// ─── The plan-request entry point ──────────────────────────────────────
//
// Called before a plan is claimed. In the overwhelmingly common case — a
// patient with a valid, unexpired limit taking another plan — it makes NO
// bureau call and returns immediately. That is the point of a standing
// limit: individual plans draw against it, they do not re-buy it.
//
// The billable path is reached only on a re-assessment trigger, and the
// score gate still guards the affordability spend inside it, so a patient
// whose band has dropped is refused having spent one enquiry rather than
// two.

import { handlePlanRequest } from '@/lib/underwriting/pipeline';
import { scoreFamily as _scoreFamily } from '@/lib/experian/config';

export type AssessmentCurrency =
  | { ok: true; limit: number | null; reassessed: boolean }
  | { ok: false; error: string };

/**
 * Make sure the patient's limit is current enough to lend against.
 *
 * `requestedIncrease` and `adminTriggered` force a re-assessment even on a
 * valid limit — they are the other two triggers, sharing this one path.
 */
export async function ensureAssessmentCurrent(
  ctx: AssessmentContext,
  opts: { requestedIncrease?: boolean; adminTriggered?: boolean; declaredIncomeRands?: number | null } = {},
): Promise<AssessmentCurrency> {
  const now = ctx.now ?? new Date();

  const snapshot = await readSnapshot(ctx.svc, ctx.userId);
  if (snapshot === null) {
    // Could not read the patient's state. Not permission to proceed — the
    // same posture the exposure read takes, for the same reason.
    return { ok: false, error: ASSESSMENT_PENDING_MESSAGE };
  }

  const declared = opts.declaredIncomeRands ?? null;

  const outcome = await handlePlanRequest(
    {
      score:          (id) => getPersonScore(id),
      affordability:  (id) => doAffordability(id),
      identityStatus: async () => {
        const row = await ctx.svc
          .from('profiles')
          .select('sa_id_number, liveness_verified_at')
          .eq('id', ctx.userId)
          .maybeSingle();
        const p = row.data as { sa_id_number: string | null; liveness_verified_at: string | null } | null;
        return p?.sa_id_number && p.liveness_verified_at ? 'passed' : 'pending';
      },
      preference: scorecardPreference(),
      cards:      _scoreFamily().cards,
    },
    snapshot,
    now,
    {
      idNumber: ctx.idNumber,
      declared: declared !== null && declared > 0 ? declaredGross(declared) : null,
      requestedIncrease: opts.requestedIncrease,
      adminTriggered:    opts.adminTriggered,
    },
  );

  switch (outcome.kind) {
    case 'allowed':
      return { ok: true, limit: outcome.limit, reassessed: false };

    case 'blocked':
      return { ok: false, error: cooldownMessage(outcome.until) };

    case 'pending_assessment':
      return { ok: false, error: ASSESSMENT_PENDING_MESSAGE };

    case 'reassessed': {
      const r = outcome.result;

      if (r.kind === 'declined') {
        await persist(ctx, {
          scoreDecision: r.scoreDecision, resolution: null, limit: null, declaredIncome: declared,
        });
        return { ok: false, error: SCORE_DECLINE_MESSAGE };
      }

      if (r.kind === 'identity_not_passed') {
        return { ok: false, error: 'Please finish verifying your identity first.' };
      }

      if (r.kind === 'pending') {
        await persist(ctx, {
          scoreDecision: null,
          resolution: { kind: 'pending', detail: r.detail, alert: r.alert },
          limit: null,
          declaredIncome: declared,
        });
        return { ok: false, error: ASSESSMENT_PENDING_MESSAGE };
      }

      // Assessed. Persist whatever it decided — including a decline, which
      // sets the cooldown and clears the stale limit.
      await persist(ctx, {
        scoreDecision:  r.scoreDecision,
        // The affordability figures, not null: a re-assessment row with no
        // GMIP or enquiry id is invisible to calibration.
        resolution:     r.resolution,
        limit:          r.limit,
        declaredIncome: declared,
      });

      if (r.limit.decision === 'declined') {
        return { ok: false, error: SCORE_DECLINE_MESSAGE };
      }

      // A REDUCED limit is fine here. Plans already in flight keep running
      // against the limit they were written under; the new figure binds
      // this request and the ones after it.
      return { ok: true, limit: r.limit.limit, reassessed: true };
    }
  }
}
