import { describe, it, expect } from 'vitest';
import { isKnownSpecialty, normaliseSpecialty, SPECIALTIES } from './specialties';

describe('isKnownSpecialty', () => {
  it('accepts exact canonical values', () => {
    for (const s of SPECIALTIES) expect(isKnownSpecialty(s)).toBe(true);
  });
  it('rejects free text and empty input', () => {
    expect(isKnownSpecialty('General Practitioner (GP)')).toBe(false);
    expect(isKnownSpecialty(null)).toBe(false);
    expect(isKnownSpecialty(undefined)).toBe(false);
    expect(isKnownSpecialty('')).toBe(false);
  });
});

describe('normaliseSpecialty', () => {
  it('maps common directory-style GP labels', () => {
    expect(normaliseSpecialty('General Practitioner (GP)')).toBe('General Practice');
    expect(normaliseSpecialty('GP')).toBe('General Practice');
    expect(normaliseSpecialty('Family Physician')).toBe('General Practice');
  });

  it('maps dentistry, physio, optometry, psychology, nursing, pharmacy variants', () => {
    expect(normaliseSpecialty('Dentist')).toBe('Dentistry');
    expect(normaliseSpecialty('Physiotherapist')).toBe('Physiotherapy');
    expect(normaliseSpecialty('Optometrist')).toBe('Optometry');
    expect(normaliseSpecialty('Psychologist')).toBe('Psychology');
    expect(normaliseSpecialty('Registered Nurse')).toBe('Nursing');
    expect(normaliseSpecialty('Pharmacist')).toBe('Pharmacy');
  });

  it('keeps distinct medical specialties verbatim rather than bucketing them under Specialist Medicine', () => {
    // A dermatologist and a cardiologist are not the same specialty —
    // collapsing them into one generic label loses exactly the detail
    // a lead list needs, so none of these get remapped.
    expect(normaliseSpecialty('Dermatologist')).toBe('Dermatologist');
    expect(normaliseSpecialty('Cardiologist')).toBe('Cardiologist');
    expect(normaliseSpecialty('Orthopaedic Surgeon')).toBe('Orthopaedic Surgeon');
    expect(normaliseSpecialty('Psychiatrist')).toBe('Psychiatrist');
    expect(normaliseSpecialty('Psychologist')).toBe('Psychology'); // still a real synonym
  });

  it('keeps an unrecognised label verbatim rather than forcing it to Other', () => {
    expect(normaliseSpecialty('Podiatrist')).toBe('Podiatrist');
  });

  it('returns null for empty/whitespace/nullish input', () => {
    expect(normaliseSpecialty('')).toBeNull();
    expect(normaliseSpecialty('   ')).toBeNull();
    expect(normaliseSpecialty(null)).toBeNull();
    expect(normaliseSpecialty(undefined)).toBeNull();
  });
});
