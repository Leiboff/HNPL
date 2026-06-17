import crypto from 'crypto';

// ─── Internal-plumbing temp password generator ────────────────────────────
//
// Returns a high-entropy string we hand to Supabase's admin auth API
// (`auth.admin.createUser` / `auth.admin.updateUserById`) when we need
// to establish a session for a freshly-created account WITHOUT asking
// the user for a password yet. The patient sets their REAL password
// later (at /checkout/[token]/done → finalizePassword), which
// overwrites this entirely.
//
// THIS PASSWORD IS NEVER SHOWN TO A USER. It is plumbing only.
//
// WHY THIS HELPER EXISTS
//   Supabase's admin auth endpoints enforce the project's
//   password-policy requirements (lowercase / uppercase / digits /
//   symbols, depending on the setting) on whatever password the call
//   passes — even when the admin API is called server-side with the
//   service-role key. There is no documented bypass.
//
//   A pure `randomBytes(24).toString('base64url')` produces 32 chars
//   from [A-Za-z0-9_-]. The probabilities of failing each tier of
//   Supabase's policy on a single throw:
//
//     • "letters_digits_symbols" — needs at least one ASCII symbol
//       (Supabase's symbol set is !@#$%^&*…+-=_…). `_` and `-` ARE
//       symbols in that set, but ~36% of randomBytes(24) outputs
//       happen to contain neither, so they fail.
//     • "letters_digits"          — needs ≥1 digit. ~0.5% fail rate.
//     • "lower_upper_letters_digits" — same digit requirement; ~0.5%.
//
//   Combined: on a strict project policy, roughly one in three new
//   checkout patients hit a `weak_password` error mid-flow, with the
//   auth user half-created.
//
// HOW WE FIX IT
//   Prepend a fixed prefix that satisfies every Supabase policy tier
//   simultaneously (one lowercase, one uppercase, one digit, one
//   ASCII symbol), then append 24 random bytes of base64url for
//   192 bits of entropy. The fixed prefix is fine — security here
//   is "no attacker can guess this within the ~30s it exists", and
//   192 bits of entropy is comically more than enough.
//
//   The temp password is overwritten the moment the patient lands on
//   /done and calls finalizePassword, so it never reaches storage in
//   any usable form for an external attacker either.

const TEMP_PASSWORD_RANDOM_BYTES = 24;

// One char from each of the four character classes any Supabase
// "Required characters" preset can demand. Order is irrelevant — the
// policy checks for *presence*, not position.
const POLICY_GUARANTEE_PREFIX = 'Aa1!';

export function generateTempPassword(): string {
  const random = crypto.randomBytes(TEMP_PASSWORD_RANDOM_BYTES).toString('base64url');
  return `${POLICY_GUARANTEE_PREFIX}${random}`;
}
