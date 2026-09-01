// ─── Specialty vocabulary — shared across practice-signup, members,
//    branches, the public practice-lead form, and the CRM lead form.
//    Free text in the DB; this list is the UI dropdown only.
//
//    The vocabulary is the HPCSA-style register of practitioner titles
//    (an "Anaesthetist", not "Anaesthetics") so one value labels both a
//    lead and a signed-up practitioner without translation. It is the
//    SINGLE source — every specialty dropdown in the app imports from
//    here. Do not re-declare a local list in a form: two surfaces
//    offering different specialties is the bug this module exists to
//    prevent.
//
//    IMPORTANT: order matters — this is the display order, strict A→Z
//    over the whole list (so "General Surgeon" sits with the other
//    "General …" titles under G, not under S). SPECIALTY_LETTER_GROUPS
//    below derives the <optgroup> headings from it.
//
//    Bulk imports do NOT validate against this list — specialty is free
//    text in the DB. They run their input through normaliseSpecialty
//    below (app/crm/import/actions.ts, quickActions.ts), which upgrades
//    the labels it recognises and keeps the rest verbatim.
//
//    The PATIENT portal does NOT read this list. Its "Browse by
//    specialty" landing is inventory-driven (lib/practitioner/
//    categories.ts) — only a specialty with ≥1 live practitioner is
//    rendered there, so a vocabulary entry nobody has signed up under
//    never reaches a patient.

export const SPECIALTIES = [
  'Anaesthetist',
  'Art Therapist',
  'Biokineticist',
  'Cardiologist',
  'Cardiothoracic Surgeon',
  'Chiropractor',
  'Clinical Haematologist',
  'Community Health Specialist',
  'Dental Therapist',
  'Dermatologist',
  'Diagnostic Radiologist',
  'Dietitian',
  'Emergency Medicine Specialist',
  'Gastroenterologist',
  'General Dental Practitioner',
  'General Medical Practitioner (GP)',
  'General Surgeon',
  'Hearing Aid Acoustician',
  'Homeopath',
  'Maxillofacial and Oral Surgeon',
  'Medical Oncologist',
  'Naturopath',
  'Neurologist',
  'Nuclear Medicine Physician',
  'Obstetrician and Gynaecologist',
  'Occupational Health Specialist',
  'Occupational Therapist',
  'Ophthalmologist',
  'Optical Dispenser',
  'Optometrist',
  'Oral Hygienist',
  'Oral Pathologist',
  'Orthodontist',
  'Orthopaedic Surgeon',
  'Orthotist and Prosthetist',
  'Otorhinolaryngologist (ENT Specialist)',
  'Paediatric Cardiologist',
  'Paediatrician',
  'Pathologist',
  'Periodontist',
  'Pharmacotherapist',
  'Physician',
  'Physiotherapist',
  'Plastic and Reconstructive Surgeon',
  'Podiatrist',
  'Prosthodontist',
  'Psychiatrist',
  'Psychologist',
  'Psychometrist',
  'Pulmonologist',
  'Radiation Oncologist',
  'Radiographer',
  'Registered Counsellor',
  'Rheumatologist',
  'Social Worker',
  'Specialist Family Physician',
  'Speech Therapist and Audiologist',
  'Therapeutic Aromatherapist',
  'Therapeutic Reflexologist',
  'Urologist',
] as const;

export type Specialty = (typeof SPECIALTIES)[number];

export function isKnownSpecialty(s: string | null | undefined): s is Specialty {
  if (!s) return false;
  return (SPECIALTIES as readonly string[]).includes(s);
}

// ─── Letter groups for the dropdowns ───────────────────────────────────
//
// 60 flat <option>s is a wall of text; grouping them under their
// initial letter (the shape the vocabulary was handed to us in) makes a
// long list scannable. Derived, never hand-maintained — a new entry in
// SPECIALTIES lands in the right group automatically, and a new initial
// letter creates its own group.

export type SpecialtyLetterGroup = {
  letter:      string;
  specialties: readonly Specialty[];
};

export const SPECIALTY_LETTER_GROUPS: readonly SpecialtyLetterGroup[] = (() => {
  const groups: SpecialtyLetterGroup[] = [];
  for (const s of SPECIALTIES) {
    const letter = s[0].toUpperCase();
    const last   = groups[groups.length - 1];
    if (last && last.letter === letter) (last.specialties as Specialty[]).push(s);
    else groups.push({ letter, specialties: [s] });
  }
  return groups;
})();

// ─── Free-text specialty normalisation for bulk imports ─────────────────
//
// Import sources (and our own pre-2026-08 vocabulary, which used
// discipline names like "Dentistry" rather than practitioner titles)
// write labels that mean a canonical value without matching one.
// specialty stays free text in the DB (see migration 0069) so an
// unmatched label is kept verbatim rather than forced into a bucket and
// losing information — this only upgrades labels we can confidently map
// onto a canonical value that means the SAME thing.
//
// It deliberately does NOT collapse distinct specialties onto a nearby
// one: "Nursing", "Pharmacy" and "Specialist Medicine" have no
// equivalent in the register (a pharmacist is not a Pharmacotherapist,
// and "Specialist Medicine" could be any of a dozen entries), so they
// are kept exactly as the source wrote them rather than guessed at.
const SPECIALTY_SYNONYMS: Array<{ match: RegExp; value: Specialty }> = [
  // Our own former vocabulary + the directory labels that mean the same thing.
  { match: /\b(gp|g\.p\.|general (?:medical )?practi(?:ce|tioner))\b/i, value: 'General Medical Practitioner (GP)' },
  { match: /\bfamily (?:medicine|physician|practitioner)\b/i,           value: 'Specialist Family Physician' },
  { match: /\bspecialist physician\b/i,                                  value: 'Physician' },
  { match: /\b(dentist|dentistry|dental practitioner)\b/i,              value: 'General Dental Practitioner' },
  { match: /\bphysio(?:therapy|therapist)?\b/i,                         value: 'Physiotherapist' },
  { match: /\boptomet(?:ry|rist)\b/i,                                   value: 'Optometrist' },
  { match: /\bpsycholog(?:y|ist)\b/i,                                   value: 'Psychologist' },
  // Common spelling variants + abbreviations of register entries.
  { match: /\ban(?:a)?esth(?:etist|esiolog(?:y|ist))\b/i,               value: 'Anaesthetist' },
  { match: /\bp(?:a)?ediatrician\b/i,                                   value: 'Paediatrician' },
  { match: /\borthop(?:a)?edic surgeon\b/i,                             value: 'Orthopaedic Surgeon' },
  { match: /\b(ent|otorhinolaryngolog(?:y|ist)|otolaryngolog(?:y|ist))\b/i, value: 'Otorhinolaryngologist (ENT Specialist)' },
  { match: /\b(ob[\s/-]?gyn|obstetrician|gyn(?:a)?ecologist)\b/i,       value: 'Obstetrician and Gynaecologist' },
  { match: /\bdietici?an\b/i,                                           value: 'Dietitian' },
  { match: /\bplastic surgeon\b/i,                                      value: 'Plastic and Reconstructive Surgeon' },
  { match: /\bh(?:a)?ematologist\b/i,                                    value: 'Clinical Haematologist' },
  { match: /\bradiologist\b/i,                                          value: 'Diagnostic Radiologist' },
  { match: /\b(speech therapist|audiologist)\b/i,                       value: 'Speech Therapist and Audiologist' },
];

export function normaliseSpecialty(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;

  // An exact register entry in the wrong case is still that entry.
  const exact = (SPECIALTIES as readonly string[]).find(s => s.toLowerCase() === t.toLowerCase());
  if (exact) return exact;

  for (const { match, value } of SPECIALTY_SYNONYMS) {
    if (match.test(t)) return value;
  }
  return t; // Unrecognised — keep it verbatim rather than guess.
}
