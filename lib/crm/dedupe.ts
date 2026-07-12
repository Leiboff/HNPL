// ─── Duplicate detection on lead create ──────────────────────────────
//
// Warn-and-confirm (not hard block): two practitioners at the same
// practice can share a practice line, so we surface the collision but
// let the user proceed.
//
// Match criteria (case-insensitive, whitespace-tolerant on phone):
//   • phone (normalised to digits) matches an existing lead's phone
//   • OR email matches an existing lead's email
//
// The helper here is the pure comparison. Actual DB lookup lives in
// app/crm/leads/actions.ts.

export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, '');
  return digits || null;
}

export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  return t || null;
}

export type DedupeCandidate = {
  id:            string;
  practice_name: string;
  phone:         string | null;
  email:         string | null;
};

/**
 * Return the subset of candidates that collide with `probe` on phone
 * OR email. Empty array = no collision.
 */
export function findLeadCollisions(
  probe:      { phone: string | null; email: string | null },
  candidates: DedupeCandidate[],
): DedupeCandidate[] {
  const probePhone = normalisePhone(probe.phone);
  const probeEmail = normaliseEmail(probe.email);
  if (!probePhone && !probeEmail) return [];
  return candidates.filter(c => {
    const cp = normalisePhone(c.phone);
    const ce = normaliseEmail(c.email);
    if (probePhone && cp && probePhone === cp) return true;
    if (probeEmail && ce && probeEmail === ce) return true;
    return false;
  });
}
