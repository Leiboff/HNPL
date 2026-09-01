import { describe, it, expect } from 'vitest';
import {
  isKnownSpecialty,
  normaliseSpecialty,
  SPECIALTIES,
  SPECIALTY_LETTER_GROUPS,
} from './specialties';

describe('SPECIALTIES', () => {
  it('carries the full register handed over by the business (60 entries)', () => {
    expect(SPECIALTIES).toHaveLength(60);
  });

  it('has no duplicates', () => {
    expect(new Set(SPECIALTIES).size).toBe(SPECIALTIES.length);
  });

  it('is strict A→Z, so every dropdown is scannable', () => {
    const sorted = [...SPECIALTIES].sort((a, b) => a.localeCompare(b));
    expect([...SPECIALTIES]).toEqual(sorted);
  });

  it('uses practitioner titles, not discipline names', () => {
    // One value has to label both a lead and a signed-up practitioner.
    // "Dentistry" (the old vocabulary) reads wrong on a person.
    expect(SPECIALTIES).toContain('General Dental Practitioner');
    expect(SPECIALTIES).toContain('Physiotherapist');
    expect(SPECIALTIES).not.toContain('Dentistry');
    expect(SPECIALTIES).not.toContain('Physiotherapy');
  });

  it('spot-checks entries from each end of the register', () => {
    expect(SPECIALTIES[0]).toBe('Anaesthetist');
    expect(SPECIALTIES[SPECIALTIES.length - 1]).toBe('Urologist');
    expect(SPECIALTIES).toContain('Otorhinolaryngologist (ENT Specialist)');
    expect(SPECIALTIES).toContain('General Medical Practitioner (GP)');
    expect(SPECIALTIES).toContain('Speech Therapist and Audiologist');
  });
});

describe('SPECIALTY_LETTER_GROUPS', () => {
  it('covers every specialty exactly once, in list order', () => {
    expect(SPECIALTY_LETTER_GROUPS.flatMap(g => [...g.specialties])).toEqual([...SPECIALTIES]);
  });

  it('emits one group per initial letter, with matching members', () => {
    const letters = SPECIALTY_LETTER_GROUPS.map(g => g.letter);
    expect(new Set(letters).size).toBe(letters.length);
    for (const { letter, specialties } of SPECIALTY_LETTER_GROUPS) {
      for (const s of specialties) expect(s[0].toUpperCase()).toBe(letter);
    }
  });

  it('groups the "General …" titles together under G rather than by suffix', () => {
    const g = SPECIALTY_LETTER_GROUPS.find(x => x.letter === 'G')!;
    expect(g.specialties).toContain('General Surgeon');
    expect(g.specialties).toContain('General Dental Practitioner');
  });
});

describe('isKnownSpecialty', () => {
  it('accepts exact canonical values', () => {
    for (const s of SPECIALTIES) expect(isKnownSpecialty(s)).toBe(true);
  });
  it('rejects free text and empty input', () => {
    expect(isKnownSpecialty('Cardiology')).toBe(false);
    expect(isKnownSpecialty('Dentistry')).toBe(false);
    expect(isKnownSpecialty(null)).toBe(false);
    expect(isKnownSpecialty(undefined)).toBe(false);
    expect(isKnownSpecialty('')).toBe(false);
  });
});

describe('normaliseSpecialty', () => {
  it('canonicalises the case of an exact register entry', () => {
    expect(normaliseSpecialty('cardiologist')).toBe('Cardiologist');
    expect(normaliseSpecialty('  PODIATRIST  ')).toBe('Podiatrist');
  });

  it('maps common directory-style GP labels', () => {
    expect(normaliseSpecialty('General Practitioner (GP)')).toBe('General Medical Practitioner (GP)');
    expect(normaliseSpecialty('GP')).toBe('General Medical Practitioner (GP)');
    expect(normaliseSpecialty('General Practice')).toBe('General Medical Practitioner (GP)');
  });

  it('maps family-medicine labels onto the registered specialist title', () => {
    expect(normaliseSpecialty('Family Physician')).toBe('Specialist Family Physician');
    expect(normaliseSpecialty('Family Medicine')).toBe('Specialist Family Physician');
  });

  it('upgrades our own pre-2026-08 discipline names to practitioner titles', () => {
    // Old rows say "Dentistry"; the register says "General Dental
    // Practitioner". Two labels for one specialty would show up as two
    // separate tiles on the patient portal.
    expect(normaliseSpecialty('Dentistry')).toBe('General Dental Practitioner');
    expect(normaliseSpecialty('Physiotherapy')).toBe('Physiotherapist');
    expect(normaliseSpecialty('Optometry')).toBe('Optometrist');
    expect(normaliseSpecialty('Psychology')).toBe('Psychologist');
  });

  it('maps the directory-style practitioner labels for those disciplines too', () => {
    expect(normaliseSpecialty('Dentist')).toBe('General Dental Practitioner');
    expect(normaliseSpecialty('Physiotherapist')).toBe('Physiotherapist');
    expect(normaliseSpecialty('Optometrist')).toBe('Optometrist');
    expect(normaliseSpecialty('Psychologist')).toBe('Psychologist');
  });

  it('absorbs spelling variants and abbreviations of register entries', () => {
    expect(normaliseSpecialty('Anesthetist')).toBe('Anaesthetist');
    expect(normaliseSpecialty('Anesthesiologist')).toBe('Anaesthetist');
    expect(normaliseSpecialty('Pediatrician')).toBe('Paediatrician');
    expect(normaliseSpecialty('Orthopedic Surgeon')).toBe('Orthopaedic Surgeon');
    expect(normaliseSpecialty('ENT')).toBe('Otorhinolaryngologist (ENT Specialist)');
    expect(normaliseSpecialty('Gynaecologist')).toBe('Obstetrician and Gynaecologist');
    expect(normaliseSpecialty('OB/GYN')).toBe('Obstetrician and Gynaecologist');
    expect(normaliseSpecialty('Dietician')).toBe('Dietitian');
    expect(normaliseSpecialty('Plastic Surgeon')).toBe('Plastic and Reconstructive Surgeon');
    expect(normaliseSpecialty('Haematologist')).toBe('Clinical Haematologist');
    expect(normaliseSpecialty('Radiologist')).toBe('Diagnostic Radiologist');
    expect(normaliseSpecialty('Audiologist')).toBe('Speech Therapist and Audiologist');
  });

  it('keeps old vocabulary values with no register equivalent verbatim', () => {
    // A pharmacist is not a Pharmacotherapist, and "Specialist
    // Medicine" could be any of a dozen entries — guessing would put a
    // wrong specialty on a real practitioner, so these stay as written
    // until a human relabels them.
    expect(normaliseSpecialty('Nursing')).toBe('Nursing');
    expect(normaliseSpecialty('Pharmacy')).toBe('Pharmacy');
    expect(normaliseSpecialty('Specialist Medicine')).toBe('Specialist Medicine');
    expect(normaliseSpecialty('Other')).toBe('Other');
  });

  it('keeps an unrecognised label verbatim rather than forcing it into a bucket', () => {
    expect(normaliseSpecialty('Sports Medicine Physician')).toBe('Sports Medicine Physician');
  });

  it('returns null for empty/whitespace/nullish input', () => {
    expect(normaliseSpecialty('')).toBeNull();
    expect(normaliseSpecialty('   ')).toBeNull();
    expect(normaliseSpecialty(null)).toBeNull();
    expect(normaliseSpecialty(undefined)).toBeNull();
  });
});
