// ─── Where a practitioner's NAME lives ────────────────────────────────────
//
// After 0091 a practice_members row holds a practitioner's name in one of two
// places, never both — the CHECK constraint (practice_members_identifiable)
// enforces exactly one home:
//
//   • has a login  → user_id is set, name is on profiles
//   • roster only  → user_id IS NULL, name is on provider_first_name /
//                    provider_last_name
//
// Since 0094 attributes plans to the membership row rather than to a profile,
// every surface that shows "who treated this patient" has to resolve across
// both cases. This module is that resolution, in one place, because six copies
// of a two-branch fallback is six chances for one of them to render a blank
// where a roster practitioner's name should be — and a bill with no
// practitioner on it looks like a data bug to the practice reading it.

/**
 * The shape every caller selects. `profiles` is the PostgREST embed, which
 * arrives as an object or a single-element array depending on how the relation
 * is inferred — both are handled, same as billHelpers does for its embeds.
 */
export type ProfileNameRef = {
  first_name: string | null;
  last_name:  string | null;
};

export type ProviderMemberRef = {
  id:                   string;
  user_id:              string | null;
  provider_first_name:  string | null;
  provider_last_name:   string | null;
  specialty?:           string | null;
  profiles?:            ProfileNameRef | ProfileNameRef[] | null;
};

/** The PostgREST select list these helpers expect. Kept here so a caller
 *  cannot drift from what the resolver reads. */
export const PROVIDER_MEMBER_SELECT =
  'id, user_id, provider_first_name, provider_last_name, specialty, profiles(first_name, last_name)';

function profileOf(ref: ProviderMemberRef): ProfileNameRef | null {
  const p = ref.profiles;
  if (!p) return null;
  return Array.isArray(p) ? (p[0] ?? null) : p;
}

/**
 * Full name — "Naledi Dlamini". Used where the practice is looking at its own
 * team (bill picker, by-doctor breakdowns).
 *
 * Falls back to '—' rather than an empty string: an empty cell reads as a
 * layout bug, a dash reads as "not recorded", and only the second is true.
 */
export function providerMemberName(ref: ProviderMemberRef | null | undefined): string {
  if (!ref) return '—';

  const profile = profileOf(ref);
  const fromProfile = `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim();
  if (fromProfile) return fromProfile;

  const fromRoster = `${ref.provider_first_name ?? ''} ${ref.provider_last_name ?? ''}`.trim();
  if (fromRoster) return fromRoster;

  return '—';
}

/**
 * Whether this membership can be signed into. The roster surface needs it to
 * label an entry, and the invite flow needs it to decide whether a login can
 * still be offered.
 */
export function hasLogin(ref: ProviderMemberRef): boolean {
  return ref.user_id !== null;
}
