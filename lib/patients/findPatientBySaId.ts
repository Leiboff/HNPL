import { hashIdForLookup } from '@/lib/idEncryption';

// ─── findPatientBySaId ───────────────────────────────────────────────
//
// SA-ID-keyed counterpart to lib/auth/findExistingAuthUser.ts (which keys
// on email). Restored from commit 61743e5 — reverted by 500fe3b because
// nothing needed it then — now that the signup gate does.
//
// Looks a profile up by the deterministic blind index (migration 0096 +
// hashIdForLookup) rather than decrypting and comparing every
// profiles.sa_id_number row, which is impossible to do in SQL: the
// ciphertext uses a fresh random IV per call, so equality never matches.
//
// Service-role only. sa_id_lookup_hash carries no client-facing SELECT
// policy, and this helper is meant to be called from server actions with
// a service-role client, mirroring findExistingAuthUser's contract.
//
// WHY NOT maybeSingle()
//   The original used it. Under migration 0097 at most one patient row can
//   hold a given hash, so it would be correct — but PostgREST turns a
//   multi-row result into an ERROR, and an ignored error here reads as
//   "no owner found", i.e. the gate would fail OPEN and let a duplicate
//   through in exactly the state where duplicates exist. Taking the first
//   of a limited set fails CLOSED instead, and stays correct if the
//   constraint is ever dropped or scoped differently.
//
// Returns null for "no match" and for "no profile carries a hash yet"
// alike — callers cannot distinguish the two, which matches
// findExistingAuthUser's anti-enumeration posture.

export type PatientBySaId = {
  id:    string;
  email: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export async function findPatientBySaId(
  svc:       Svc,
  saIdPlain: string,
): Promise<PatientBySaId | null> {
  const trimmed = saIdPlain.trim();
  if (!trimmed) return null;

  const hash = hashIdForLookup(trimmed);

  const { data, error } = await svc
    .from('profiles')
    .select('id, email')
    .eq('sa_id_lookup_hash', hash)
    .eq('role', 'patient')
    .order('created_at', { ascending: true })
    .limit(2);

  // A read failure is NOT "nobody owns this ID". Surface it as a throw so
  // the caller's own error path runs, rather than silently permitting a
  // registration the gate was supposed to refuse.
  if (error) {
    throw new Error(`findPatientBySaId: profile lookup failed — ${error.message ?? String(error)}`);
  }

  const rows = (data ?? []) as Array<{ id: string; email: string | null }>;
  const first = rows[0];
  if (!first?.id) return null;

  return { id: first.id, email: (first.email as string | null) ?? null };
}
