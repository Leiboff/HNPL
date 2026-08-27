import { describe, it, expect } from 'vitest';
import { deriveLeadInterest, isMissingDecisionMaker, type ContactForInterest } from './interest';

const c = (interest: ContactForInterest['interest'], is_decision_maker = false): ContactForInterest =>
  ({ interest, is_decision_maker });

describe('deriveLeadInterest', () => {
  it('returns "unknown" for no contacts', () => {
    expect(deriveLeadInterest([])).toBe('unknown');
  });

  it('returns "unknown" when no contact has a value set', () => {
    expect(deriveLeadInterest([c('unknown'), c('unknown', true)])).toBe('unknown');
  });

  it('prefers decision-maker interest over a hotter non-decision-maker', () => {
    const contacts = [c('hot', false), c('warm', true)];
    expect(deriveLeadInterest(contacts)).toBe('warm');
  });

  it('picks the hottest among multiple decision makers', () => {
    const contacts = [c('cold', true), c('hot', true), c('warm', true)];
    expect(deriveLeadInterest(contacts)).toBe('hot');
  });

  it('falls back to hottest overall when there is no decision maker', () => {
    const contacts = [c('cold', false), c('hot', false)];
    expect(deriveLeadInterest(contacts)).toBe('hot');
  });

  it('ignores non-decision-maker contacts entirely once a decision maker exists', () => {
    const contacts = [c('hot', false), c('unknown', true)];
    expect(deriveLeadInterest(contacts)).toBe('unknown');
  });
});

describe('isMissingDecisionMaker', () => {
  it('is false before agreement_sent even with no decision maker', () => {
    expect(isMissingDecisionMaker('contacted', [])).toBe(false);
    expect(isMissingDecisionMaker('demo_done', [{ is_decision_maker: false }])).toBe(false);
  });

  it('is true at agreement_sent with no decision-maker contact', () => {
    expect(isMissingDecisionMaker('agreement_sent', [{ is_decision_maker: false }])).toBe(true);
  });

  it('is false at agreement_sent once a decision maker is on file', () => {
    expect(isMissingDecisionMaker('agreement_sent', [{ is_decision_maker: true }])).toBe(false);
  });

  it('is false for terminal stages (signed / onboarded / lost) — matches the isMissingNextAction exclusion', () => {
    for (const stage of ['signed', 'onboarded', 'lost']) {
      expect(isMissingDecisionMaker(stage, [{ is_decision_maker: false }])).toBe(false);
    }
  });

  it('is false for nurture — its position in STAGES is not "further along the funnel"', () => {
    expect(isMissingDecisionMaker('nurture', [{ is_decision_maker: false }])).toBe(false);
  });
});
