/**
 * Email validation. The regex is the only one in the codebase — every
 * caller (signup flows, login, anywhere a user enters their email) should
 * import from here. A source-text regression test bans copying the raw
 * regex outside this module.
 *
 * Validation is deliberately loose (RFC 5321 strict-mode emails are not a
 * useful UX gate). It rejects obviously malformed input — empty string,
 * missing @, no dot in the host part — and accepts everything else.
 * Confirmation email round-trip is the authoritative check.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(input: string | null | undefined): boolean {
  if (typeof input !== 'string') return false;
  if (input.length === 0 || input.length > 254) return false;
  return EMAIL_RE.test(input);
}

/**
 * Extract the local-part (before the @) of an email. Returns null for
 * inputs that don't look like an email. Used by passwordGuard to reject
 * passwords that contain a recognisable chunk of the user's own email.
 */
export function emailLocalPart(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const at = input.indexOf('@');
  if (at <= 0) return null;
  return input.slice(0, at).toLowerCase();
}
