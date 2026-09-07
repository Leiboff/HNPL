import { describe, expect, it } from 'vitest';
import { resolveFaceMatchThresholds } from './faceMatchPolicy';

describe('resolveFaceMatchThresholds', () => {
  it('uses the reviewed defaults when both settings are absent', () => {
    expect(resolveFaceMatchThresholds({})).toEqual({
      ok: true,
      thresholds: { approveMin: 70, reviewMin: 45 },
    });
  });

  it.each(['', '70%', 'NaN', 'Infinity', '-1', '101'])('fails closed for invalid approval threshold %j', (value) => {
    expect(resolveFaceMatchThresholds({ DHA_FACE_MATCH_APPROVE_MIN: value }).ok).toBe(false);
  });

  it.each(['', 'forty-five', 'NaN', '-0.1', '100.1'])('fails closed for invalid review threshold %j', (value) => {
    expect(resolveFaceMatchThresholds({ DHA_FACE_MATCH_REVIEW_MIN: value }).ok).toBe(false);
  });

  it('rejects reversed thresholds', () => {
    expect(resolveFaceMatchThresholds({
      DHA_FACE_MATCH_APPROVE_MIN: '60',
      DHA_FACE_MATCH_REVIEW_MIN: '61',
    })).toEqual({
      ok: false,
      reason: 'DHA_FACE_MATCH_REVIEW_MIN must not exceed DHA_FACE_MATCH_APPROVE_MIN',
    });
  });

  it('accepts ordered boundary values', () => {
    expect(resolveFaceMatchThresholds({
      DHA_FACE_MATCH_APPROVE_MIN: '100',
      DHA_FACE_MATCH_REVIEW_MIN: '0',
    })).toEqual({ ok: true, thresholds: { approveMin: 100, reviewMin: 0 } });
  });
});
