import { describe, it, expect } from 'vitest';
import {
  assessBotSignals,
  BOT_AUTOMATED_SCORE,
  BOT_SUSPECT_SCORE,
  type BotObservation,
} from './botSignals';

// The asymmetry that shapes every case below: a bot that gets through
// meets the registry check, the biometric check and the ring analysis
// behind this, and is refused there. A real patient wrongly refused at the
// front door meets nothing — they are simply gone. So the tests for "a
// human is never called automated" are the strict ones.

const human: BotObservation = {
  honeypot: '',
  dwellMs: 24_000,
  interactionCount: 61,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  timezone: 'Africa/Johannesburg',
  formTokenValid: true,
};

describe('real people are not refused', () => {
  it('clears an ordinary mobile signup', () => {
    const result = assessBotSignals(human);
    expect(result.verdict).toBe('human');
    expect(result.score).toBe(0);
  });

  it('clears a fast autofill user — quick, but with real interaction', () => {
    const result = assessBotSignals({ ...human, dwellMs: 4_000, interactionCount: 3 });
    expect(result.verdict).toBe('human');
  });

  it('does not refuse a privacy-hardened browser that strips its timezone', () => {
    // A single soft signal must never reach the refusal band on its own.
    const result = assessBotSignals({ ...human, timezone: '' });
    expect(result.verdict).not.toBe('automated');
  });

  it('does not refuse an unrecognised future browser', () => {
    const result = assessBotSignals({
      ...human,
      userAgent: 'Mozilla/5.0 (Unknown 1.0) AppleWebKit/999.1 SomeNewBrowser/3.0',
    });
    expect(result.verdict).toBe('human');
  });

  it('never refuses on any one soft signal alone', () => {
    const soft: Array<Partial<BotObservation>> = [
      { dwellMs: 200 },
      { interactionCount: 0 },
      { userAgent: '' },
      { userAgent: 'curl/8.4.0' },
      { formTokenValid: false },
      { timezone: '' },
    ];
    for (const one of soft) {
      const result = assessBotSignals({ ...human, ...one });
      expect(result.score, JSON.stringify(one)).toBeLessThan(BOT_AUTOMATED_SCORE);
    }
  });
});

describe('cheap automation is refused', () => {
  it('refuses on the honeypot alone', () => {
    // The one rule permitted to be decisive by itself.
    const result = assessBotSignals({ ...human, honeypot: 'https://spam.example' });
    expect(result.verdict).toBe('automated');
    expect(result.signals.map((s) => s.code)).toContain('honeypot_filled');
  });

  it('refuses a bare scripted POST — no token, no UA, no interaction', () => {
    const result = assessBotSignals({
      honeypot: '',
      dwellMs: null,
      interactionCount: 0,
      userAgent: 'python-requests/2.31.0',
      timezone: '',
      formTokenValid: false,
    });
    expect(result.verdict).toBe('automated');
  });

  it('refuses a default headless build', () => {
    const result = assessBotSignals({
      ...human,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36',
      dwellMs: 300,
      interactionCount: 0,
    });
    expect(result.verdict).toBe('automated');
  });

  it('puts a driven-but-plausible browser in the step-up band, not the refusal band', () => {
    // The realistic attacker: a real Chrome under automation, paced to
    // look human, but filling fields programmatically. We expect friction,
    // not refusal — refusing this confidently would mean refusing screen
    // readers and password managers too.
    const result = assessBotSignals({ ...human, interactionCount: 0, dwellMs: 3_000 });
    expect(result.score).toBeGreaterThanOrEqual(BOT_SUSPECT_SCORE);
    expect(result.verdict).toBe('suspect');
  });
});

describe('absent signals are handled honestly', () => {
  it('scores an empty observation as human rather than throwing', () => {
    // Every field undefined = a caller that has not been wired up yet.
    // That must not refuse anyone.
    const result = assessBotSignals({});
    expect(result.verdict).toBe('human');
    expect(result.score).toBe(0);
  });

  it('does not treat a missing dwell as a fast dwell', () => {
    const missing = assessBotSignals({ ...human, dwellMs: null });
    expect(missing.signals.map((s) => s.code)).not.toContain('submitted_impossibly_fast');
  });

  it('reports every signal it fired, for the log', () => {
    const result = assessBotSignals({
      honeypot: 'x', dwellMs: 5, interactionCount: 0, userAgent: 'curl/8', timezone: '', formTokenValid: false,
    });
    const codes = result.signals.map((s) => s.code);
    expect(codes).toEqual(expect.arrayContaining([
      'honeypot_filled', 'submitted_impossibly_fast', 'submitted_without_interaction',
      'ua_non_browser', 'form_token_missing', 'timezone_missing',
    ]));
    // Nothing in a detail string may echo user input back into the logs.
    for (const s of result.signals) expect(s.detail).not.toContain('curl');
  });
});
