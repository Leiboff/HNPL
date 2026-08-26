import { describe, it, expect } from 'vitest';
import { sumPipelineValue, pipelineValueByStage, weightedPipelineValue, hasEnoughData, MIN_SAMPLE_SIZE } from './pipeline';

describe('sumPipelineValue', () => {
  it('2. equals the sum of member leads, and excludes archived leads', () => {
    const leads = [
      { stage: 'new', estimated_monthly_billings: 1000 },
      { stage: 'contacted', estimated_monthly_billings: 2000 },
      { stage: 'signed', estimated_monthly_billings: 5000, archived_at: '2026-01-01T00:00:00Z' },
    ];
    expect(sumPipelineValue(leads)).toBe(3000);
  });

  it('excludes lost leads', () => {
    const leads = [
      { stage: 'new', estimated_monthly_billings: 1000 },
      { stage: 'lost', estimated_monthly_billings: 9000 },
    ];
    expect(sumPipelineValue(leads)).toBe(1000);
  });

  it('treats a null estimated_monthly_billings as 0, not NaN', () => {
    const leads = [{ stage: 'new', estimated_monthly_billings: null }];
    expect(sumPipelineValue(leads)).toBe(0);
    expect(Number.isNaN(sumPipelineValue(leads))).toBe(false);
  });
});

describe('pipelineValueByStage', () => {
  it('buckets by stage and excludes archived leads', () => {
    const leads = [
      { stage: 'new', estimated_monthly_billings: 1000 },
      { stage: 'new', estimated_monthly_billings: 500 },
      { stage: 'signed', estimated_monthly_billings: 5000, archived_at: '2026-01-01T00:00:00Z' },
    ];
    expect(pipelineValueByStage(leads)).toEqual({ new: 1500 });
  });
});

describe('weightedPipelineValue', () => {
  it('weights by stage close-probability', () => {
    const leads = [
      { stage: 'onboarded', estimated_monthly_billings: 1000 }, // weight 1.0
      { stage: 'new', estimated_monthly_billings: 1000 },       // weight 0.05
    ];
    expect(weightedPipelineValue(leads)).toBeCloseTo(1050, 5);
  });

  it('excludes lost leads entirely, not just weights them to zero implicitly', () => {
    const leads = [{ stage: 'lost', estimated_monthly_billings: 100000 }];
    expect(weightedPipelineValue(leads)).toBe(0);
  });
});

describe('3. adversarial — a KPI with a denominator below 5 renders the not-enough-data state', () => {
  it('below MIN_SAMPLE_SIZE is not enough data', () => {
    for (let n = 0; n < MIN_SAMPLE_SIZE; n++) expect(hasEnoughData(n)).toBe(false);
  });
  it('at or above MIN_SAMPLE_SIZE is enough data', () => {
    expect(hasEnoughData(MIN_SAMPLE_SIZE)).toBe(true);
    expect(hasEnoughData(MIN_SAMPLE_SIZE + 100)).toBe(true);
  });
});
