import { describe, it, expect } from 'vitest';
import { isValidEmail, emailLocalPart } from './email';

describe('isValidEmail', () => {
  it.each([
    'jane@example.com',
    'jane.doe@example.co.za',
    'jane+tag@example.com',
    'a@b.cd',
    '123@example.io',
  ])('accepts %s', (e) => {
    expect(isValidEmail(e)).toBe(true);
  });

  it.each([
    '',
    'not-an-email',
    'jane@',
    '@example.com',
    'jane@example',     // no dot in host
    'jane @example.com', // contains whitespace
    'jane@exam ple.com',
    'jane\t@example.com',
  ])('rejects %p', (e) => {
    expect(isValidEmail(e)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(123 as unknown as string)).toBe(false);
  });

  it('rejects addresses over 254 chars', () => {
    const longLocal = 'a'.repeat(250);
    expect(isValidEmail(`${longLocal}@x.io`)).toBe(false);
  });
});

describe('emailLocalPart', () => {
  it('returns the lowercased local-part before @', () => {
    expect(emailLocalPart('Jane.Doe@Example.com')).toBe('jane.doe');
  });

  it('returns null for inputs without @', () => {
    expect(emailLocalPart('not-an-email')).toBeNull();
    expect(emailLocalPart('')).toBeNull();
    expect(emailLocalPart(null)).toBeNull();
    expect(emailLocalPart(undefined)).toBeNull();
  });

  it('returns null when local part is empty', () => {
    expect(emailLocalPart('@example.com')).toBeNull();
  });
});
