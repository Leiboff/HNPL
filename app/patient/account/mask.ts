// ─── Masking for the account identity row ────────────────────────────────
//
// The identity row prints the account's email under the patient's name, so
// it is legible over a stranger's shoulder on a taxi. Masking it keeps the
// row's job — "yes, this is my account" — while removing most of what a
// shoulder-surfer could use.
//
// The rule is "enough to recognise, not enough to reuse": the first two
// characters, the domain, and dots for the rest. Short local parts keep one
// character rather than none, because a fully masked address is no longer
// recognisable and the row stops doing its job.

/** `thandi@example.co.za` → `th···@example.co.za`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  // Not an address we recognise — mask the whole thing rather than
  // guessing at its shape and leaking the part we guessed wrong about.
  if (at <= 0) return '···';
  const local  = email.slice(0, at);
  const domain = email.slice(at);
  const keep   = local.length > 2 ? 2 : 1;
  return `${local.slice(0, keep)}···${domain}`;
}
