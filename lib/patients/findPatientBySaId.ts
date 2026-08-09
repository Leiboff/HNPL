import { hashIdForLookup } from '@/lib/idEncryption';

// ─── findPatientBySaId ───────────────────────────────────────────────
//
// SA-ID-keyed counterpart to lib/auth/findExistingAuthUser.ts (which
// keys on email). Looks up an existing profile by the deterministic
// blind-index hash (see migration 0085 + hashIdForLookup) rather than
// decrypting and comparing every profiles.sa_id_number row.
//
// Service-role only — the hash column carries no client-facing SELECT
// policy, and this helper is meant to be called from server actions
// with a service-role client, mirroring findExistingAuthUser's
// contract.
//
// Returns null for both "no match" and "no profile has a hash yet"
// (legacy rows created before migration 0085 are simply unfindable by
// ID until backfilled) — callers cannot distinguish the two, matching
// findExistingAuthUser's anti-enumeration posture.

export type PatientBySaId = {
  id:    string;
  email: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export async function findPatientBySaId(
  svc:       Svc,
  saIdPlain: string,
): Promise<PatientBySaId | null> {
  const hash = hashIdForLookup(saIdPlain);

  const { data: profile } = await svc
    .from('profiles')
    .select('id, email')
    .eq('sa_id_lookup_hash', hash)
    .eq('role', 'patient')
    .maybeSingle();

  if (!profile?.id) return null;

  return {
    id:    profile.id as string,
    email: profile.email as string,
  };
}
