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
