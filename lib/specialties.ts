// ─── Specialty vocabulary — shared across practice-signup, members,
//    branches, and the CRM lead form. Free text in the DB; this list
//    is the UI dropdown only. Kept in sync with the constant that
//    previously lived in app/practice/members/AddMemberForm.tsx.
//
//    IMPORTANT: order matters — this is the display order. Adding a
//    new value here should also be reflected in the CSV import
//    template header commentary in lib/crm/csv.ts.

export const SPECIALTIES = [
  'General Practice',
  'Dentistry',
  'Physiotherapy',
  'Optometry',
  'Specialist Medicine',
  'Psychology',
  'Nursing',
  'Pharmacy',
  'Other',
] as const;

export type Specialty = (typeof SPECIALTIES)[number];

export function isKnownSpecialty(s: string | null | undefined): s is Specialty {
  if (!s) return false;
  return (SPECIALTIES as readonly string[]).includes(s);
}

// ─── Free-text specialty normalisation for bulk imports ─────────────────
//
// Import sources use directory-style labels ("General Practitioner
// (GP)", "GP", "Dentist") rather than our canonical SPECIALTIES values.
// specialty stays free text in the DB (see migration 0069) so an
// unmatched label is kept verbatim rather than forced into "Other" and
// losing information — this only upgrades labels we can confidently map.
// Order matters: more specific patterns (GP) are checked before the
// broad "Specialist Medicine" catch-all so e.g. "family physician"
// resolves to General Practice, not Specialist Medicine.
const SPECIALTY_SYNONYMS: Array<{ match: RegExp; value: Specialty }> = [
  { match: /\b(gp|general practi(?:ce|tioner)|family (?:medicine|physician))\b/i, value: 'General Practice' },
  { match: /\bdent(?:ist|istry)\b/i,                                              value: 'Dentistry' },
  { match: /\bphysio(?:therapy|therapist)?\b/i,                                   value: 'Physiotherapy' },
  { match: /\boptomet(?:ry|rist)\b/i,                                             value: 'Optometry' },
  { match: /\bpsycholog(?:y|ist)\b/i,                                             value: 'Psychology' },
  { match: /\bnurs(?:e|ing)\b/i,                                                  value: 'Nursing' },
  { match: /\bpharmac(?:y|ist)\b/i,                                               value: 'Pharmacy' },
  {
    // NOTE: cardiolog/dermatolog/gynaecolog are prefixes ("...ist"/"...y"),
    // not whole words — each needs its own suffix alternation so the
    // trailing \b lands after the real word ending, not mid-word.
    match: /\b(specialist|surgeon|physician|cardiolog(?:y|ist)|orthop(?:a|e)dic|pa?edia?tric|gyn(?:a|e)colog(?:y|ist)|dermatolog(?:y|ist)|psychiatr(?:y|ist))\b/i,
    value: 'Specialist Medicine',
  },
];

export function normaliseSpecialty(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  for (const { match, value } of SPECIALTY_SYNONYMS) {
    if (match.test(t)) return value;
  }
  return t; // Unrecognised — keep the original text rather than lose it.
}
