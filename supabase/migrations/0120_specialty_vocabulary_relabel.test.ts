import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SPECIALTIES, normaliseSpecialty } from '../../lib/specialties';

// ─── Source-pin tests for 0120 — specialty vocabulary relabel ─────────
//
// The migration relabels stored specialty values onto the register in
// lib/specialties.ts. Two things have to stay true, and neither is
// checkable from a live DB in unit tests:
//
//   1. Every target it writes is an actual register entry — otherwise
//      the migration invents a specialty that no dropdown offers.
//   2. It agrees with normaliseSpecialty(), which does the same job for
//      bulk imports. If the two drift, the same practice reaching us by
//      CSV and by signup ends up labelled two different ways.
//
// So we parse the mapping out of the SQL and check it against the TS.

const SRC = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0120_specialty_vocabulary_relabel.sql'),
  'utf8',
);

/** The VALUES rows of the INSERT INTO specialty_relabel statement. */
function parseMapping(): Array<[string, string]> {
  const block = SRC.split('INSERT INTO specialty_relabel')[1]?.split(';')[0] ?? '';
  return Array.from(block.matchAll(/\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g))
    .map(m => [m[1], m[2]] as [string, string]);
}

describe('0120 — the mapping itself', () => {
  const mapping = parseMapping();

  it('maps the whole pre-2026-08 vocabulary that has an equivalent', () => {
    const olds = mapping.map(([o]) => o);
    for (const legacy of ['General Practice', 'Dentistry', 'Physiotherapy', 'Optometry', 'Psychology']) {
      expect(olds).toContain(legacy);
    }
    // …and the older /practice/setup list's divergent labels.
    for (const legacy of ['General Practitioner', 'Dentist', 'Gynaecologist', 'Specialist Physician']) {
      expect(olds).toContain(legacy);
    }
  });

  it('only ever writes a real register entry', () => {
    for (const [, target] of mapping) {
      expect(SPECIALTIES).toContain(target);
    }
  });

  it('agrees with normaliseSpecialty, so CSV and signup label alike', () => {
    for (const [old, target] of mapping) {
      expect(normaliseSpecialty(old)).toBe(target);
    }
  });

  it('leaves the values with no honest equivalent alone', () => {
    const olds = mapping.map(([o]) => o);
    // A pharmacist is not a Pharmacotherapist; "Specialist Medicine"
    // could be any of a dozen entries. Guessing would put a wrong
    // specialty on a real practitioner.
    for (const kept of ['Nursing', 'Pharmacy', 'Specialist Medicine', 'Other']) {
      expect(olds).not.toContain(kept);
      expect(normaliseSpecialty(kept)).toBe(kept);
    }
  });

  it('maps each stored value to exactly one target', () => {
    const olds = mapping.map(([o]) => o);
    expect(new Set(olds).size).toBe(olds.length);
  });
});

describe('0120 — coverage and safety', () => {
  it('updates every column in the schema that stores a specialty', () => {
    for (const stmt of [
      /UPDATE practices p\s+SET specialty =/,
      /UPDATE practices p\s+SET admin_specialty =/,
      /UPDATE practice_members m\s+SET specialty =/,
      /UPDATE practice_invitations i\s+SET specialty =/,
      /UPDATE crm_leads l\s+SET specialty =/,
    ]) {
      expect(SRC).toMatch(stmt);
    }
  });

  it('matches whole stored values only — never a LIKE or a prefix', () => {
    // A substring match would rewrite "Paediatric Dentistry" or
    // "Sports Physiotherapy Clinic" into the wrong specialty.
    expect(SRC).not.toMatch(/\bLIKE\b/i);
    expect(SRC).not.toMatch(/\bILIKE\b/i);
    const equalities = Array.from(SRC.matchAll(/WHERE\s+\w+\.(\w+)\s*=\s*r\.old_value/g));
    expect(equalities).toHaveLength(5);
  });

  it('is re-runnable: the temp table is dropped and targets are already canonical', () => {
    expect(SRC).toMatch(/CREATE TEMP TABLE specialty_relabel/);
    expect(SRC).toMatch(/DROP TABLE specialty_relabel/);
    // A second run finds nothing to do because no target is also a key.
    const mapping = parseMapping();
    const olds = new Set(mapping.map(([o]) => o));
    for (const [, target] of mapping) expect(olds.has(target)).toBe(false);
  });
});
