export const DEFAULT_FACE_MATCH_APPROVE_MIN = 70;
export const DEFAULT_FACE_MATCH_REVIEW_MIN = 45;

export type FaceMatchThresholds = {
  approveMin: number;
  reviewMin: number;
};

export type FaceMatchThresholdResult =
  | { ok: true; thresholds: FaceMatchThresholds }
  | { ok: false; reason: string };

function parseThreshold(name: string, raw: string | undefined, fallback: number): number | string {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return `${name} must be a decimal number`;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return `${name} must be between 0 and 100`;
  }
  return parsed;
}

/** Validate the deployment policy before a face score can approve identity. */
export function resolveFaceMatchThresholds(
  env: Record<string, string | undefined> = process.env,
): FaceMatchThresholdResult {
  const approve = parseThreshold(
    'DHA_FACE_MATCH_APPROVE_MIN',
    env.DHA_FACE_MATCH_APPROVE_MIN,
    DEFAULT_FACE_MATCH_APPROVE_MIN,
  );
  if (typeof approve === 'string') return { ok: false, reason: approve };

  const review = parseThreshold(
    'DHA_FACE_MATCH_REVIEW_MIN',
    env.DHA_FACE_MATCH_REVIEW_MIN,
    DEFAULT_FACE_MATCH_REVIEW_MIN,
  );
  if (typeof review === 'string') return { ok: false, reason: review };

  if (review > approve) {
    return {
      ok: false,
      reason: 'DHA_FACE_MATCH_REVIEW_MIN must not exceed DHA_FACE_MATCH_APPROVE_MIN',
    };
  }

  return { ok: true, thresholds: { approveMin: approve, reviewMin: review } };
}
