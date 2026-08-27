import { describe, it, expect } from 'vitest';
import { computeLeadScore, type LeadScoreInput } from './priorityScore';

const NOW = new Date('2026-08-26T12:00:00Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

const BASE: LeadScoreInput = {
  stage: 'contacted',
  estimatedMonthlyBillings: null,
  nextFollowUpAt: null,
  lastStageChangeAt: null,
  lastActivityAt: null,
  hasUnansweredReply: false,
  distanceKm: null,
};

describe('8. the score module is pure — same inputs, same output, no clock/network reads', () => {
  it('is deterministic across repeated calls with identical input', () => {
    const input: LeadScoreInput = { ...BASE, nextFollowUpAt: iso(2), estimatedMonthlyBillings: 45000 };
    const a = computeLeadScore(input, NOW);
    const b = computeLeadScore(input, NOW);
    expect(a).toEqual(b);
  });

  it('property: for 500 randomized inputs, calling twice with the same (input, now) always agrees', () => {
    const stages = ['new', 'contacted', 'meeting_scheduled', 'demo_done', 'agreement_sent', 'signed', 'onboarded', 'lost'];
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    for (let i = 0; i < 500; i++) {
      const input: LeadScoreInput = {
        stage: stages[Math.floor(rand() * stages.length)],
        estimatedMonthlyBillings: rand() < 0.5 ? null : Math.floor(rand() * 200_000),
        nextFollowUpAt: rand() < 0.5 ? null : iso(Math.floor(rand() * 20) - 10),
        lastStageChangeAt: rand() < 0.5 ? null : iso(Math.floor(rand() * 60)),
        lastActivityAt: rand() < 0.5 ? null : iso(Math.floor(rand() * 30)),
        hasUnansweredReply: rand() < 0.5,
        distanceKm: rand() < 0.5 ? null : rand() * 50,
      };
      const now = new Date(NOW.getTime() + Math.floor(rand() * 1000) * 1000);
      const a = computeLeadScore(input, now);
      const b = computeLeadScore(input, now);
      expect(a).toEqual(b);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
      expect(a.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('9. every rendered score has a non-empty reason string', () => {
  it('a lead with no signal at all renders a defensible reason, not an empty string', () => {
    const result = computeLeadScore(BASE, NOW);
    expect(result.reason).not.toBe('');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.score).toBe(0);
  });

  it('a terminal-stage lead (lost) still gets a non-empty reason', () => {
    const result = computeLeadScore({ ...BASE, stage: 'lost' }, NOW);
    expect(result.reason).not.toBe('');
    expect(result.score).toBe(0);
  });

  it('an overdue follow-up produces both a positive score and a matching reason', () => {
    const result = computeLeadScore({ ...BASE, nextFollowUpAt: iso(3) }, NOW);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reason).toMatch(/overdue/i);
  });

  it('an unanswered reply is reflected in the reason when it is the dominant signal', () => {
    const result = computeLeadScore({ ...BASE, hasUnansweredReply: true }, NOW);
    expect(result.reason).toMatch(/reply/i);
  });

  it('the highest-weighted signal wins the reason when multiple signals are present', () => {
    // overdue (40) beats nearby (10)
    const result = computeLeadScore({ ...BASE, nextFollowUpAt: iso(5), distanceKm: 1 }, NOW);
    expect(result.reason).toMatch(/overdue/i);
  });

  it('score is capped at 100 even when every signal fires', () => {
    const result = computeLeadScore({
      stage: 'demo_done',
      estimatedMonthlyBillings: 500_000,
      nextFollowUpAt: iso(30),
      lastStageChangeAt: iso(90),
      lastActivityAt: iso(1),
      hasUnansweredReply: true,
      distanceKm: 0.5,
    }, NOW);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
