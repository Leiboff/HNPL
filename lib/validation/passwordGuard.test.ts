import { describe, it, expect } from 'vitest';
import { checkPassword } from './passwordGuard';

describe('checkPassword — email local-part substring', () => {
  it('rejects passwords containing the email local-part case-insensitively', () => {
    expect(checkPassword('Jane12345', 'jane@example.com')).toEqual({
      ok: false, reason: 'contains_email_local_part',
    });
    expect(checkPassword('hello-jane', 'JANE@example.com')).toEqual({
      ok: false, reason: 'contains_email_local_part',
    });
  });

  it('passes when the local-part is shorter than 3 chars (avoid false positives on jp@, etc.)', () => {
    expect(checkPassword('jp12345678', 'jp@example.com')).toEqual({ ok: true });
  });

  it('passes when the email is null / undefined', () => {
    expect(checkPassword('s0me-good-password', null)).toEqual({ ok: true });
    expect(checkPassword('s0me-good-password', undefined)).toEqual({ ok: true });
  });

  it('passes for genuinely-distinct passwords', () => {
    expect(checkPassword('blueGiraffe!', 'jane@example.com')).toEqual({ ok: true });
  });
});

describe('checkPassword — common-passwords list', () => {
  it.each([
    'password',
    'PASSWORD',
    'Password',
    'password123',
    '12345678',
    'qwerty123',
    'letmein1',
    'iloveyou',
    'admin123',
  ])('rejects %s', (p) => {
    expect(checkPassword(p, 'jane@example.com')).toEqual({
      ok: false, reason: 'common_password',
    });
  });

  it('passes for a strong-enough password not on the list', () => {
    expect(checkPassword('plum-fox-hidden-gate', 'jane@example.com')).toEqual({ ok: true });
  });
});

describe('checkPassword — priority order', () => {
  it('email-local-part check beats common-password (more specific)', () => {
    // "passwordjane" matches the email local part AND embeds "password";
    // we expect the more specific reason.
    expect(checkPassword('passwordjane', 'jane@example.com')).toEqual({
      ok: false, reason: 'contains_email_local_part',
    });
  });
});
