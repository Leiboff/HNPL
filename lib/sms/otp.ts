import crypto from 'crypto';

// ─── Phone-OTP helpers ───────────────────────────────────────────────────
//
// Two pure server-side primitives shared by the request + verify paths:
//   • generateOtpCode() — cryptographically-random 6-digit code.
//   • hashOtpCode(code) — SHA-256(code + PHONE_OTP_PEPPER).
//
// The CODE NEVER LEAVES THE SERVER. The action passes the hash to
// prepare_phone_verification, and only the hash is stored at rest. The
// plaintext exists only in the local action variable + the outbound
// SMS body.
//
// Why a pepper, not a per-row salt:
//   The thing we're defending against is a database leak of code_hash
//   values. A per-row salt + scrypt would be appropriate if the codes
//   were long-lived secrets. They aren't — codes are 6 digits and
//   expire in 10 minutes. A pepper held outside the DB is the right
//   trade-off: it raises offline-attack cost without overcomplicating
//   the SQL.

const CODE_LENGTH = 6;

export function generateOtpCode(): string {
  // crypto.randomInt is bias-free across [0, max). 1_000_000 gives us
  // a uniform draw of every six-digit code including those starting
  // with zeros — which Math.random().toString().slice(...) would have
  // skewed against.
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(CODE_LENGTH, '0');
}

export function hashOtpCode(code: string): string {
  const pepper = process.env.PHONE_OTP_PEPPER;
  if (!pepper) {
    // Fail loudly — a missing pepper means EVERY hash collapses to
    // the same SHA-256(code) digest, which is trivially crackable.
    // Better to crash the action than silently store crackable hashes.
    throw new Error('PHONE_OTP_PEPPER is not set');
  }
  // Plain SHA-256(code + pepper) per the approved spec. HMAC would be
  // marginally better cryptographically but the spec is explicit and
  // a 64-char pepper is plenty of resistance for a 6-digit secret.
  return crypto
    .createHash('sha256')
    .update(code + pepper)
    .digest('hex');
}
