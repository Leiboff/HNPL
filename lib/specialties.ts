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
// losing information — this only upgrades labels we can confidently map
// onto a canonical value that means the SAME thing (e.g. "GP" really is
// "General Practice"). It deliberately does NOT bucket distinct medical
// specialties (dermatology, cardiology, psychiatry, orthopaedics, ...)
// under the generic "Specialist Medicine" value — a dermatologist and a
// cardiologist are not the same specialty, and collapsing them loses
// exactly the detail a lead list needs. Anything that isn't one of the
// unambiguous synonyms below is kept exactly as the source wrote it.
const SPECIALTY_SYNONYMS: Array<{ match: RegExp; value: Specialty }> = [
  { match: /\b(gp|general practi(?:ce|tioner)|family (?:medicine|physician))\b/i, value: 'General Practice' },
  { match: /\bdent(?:ist|istry)\b/i,                                              value: 'Dentistry' },
  { match: /\bphysio(?:therapy|therapist)?\b/i,                                   value: 'Physiotherapy' },
  { match: /\boptomet(?:ry|rist)\b/i,                                             value: 'Optometry' },
  { match: /\bpsycholog(?:y|ist)\b/i,                                             value: 'Psychology' },
  { match: /\bnurs(?:e|ing)\b/i,                                                  value: 'Nursing' },
  { match: /\bpharmac(?:y|ist)\b/i,                                               value: 'Pharmacy' },
];

export function normaliseSpecialty(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  for (const { match, value } of SPECIALTY_SYNONYMS) {
    if (match.test(t)) return value;
  }
  return t; // Unrecognised (or a specific specialty, e.g. "Dermatologist") — keep it verbatim.
}
