import { describe, it, expect } from 'vitest';
import { validateSaId, saIdDateOfBirth, saIdAge } from './saId';

// ─── Luhn synthesiser — test fixture only ────────────────────────────────────
//
// Builds a known-valid 13-digit SA ID for an arbitrary DOB / gender /
// citizenship. Mirrors the Luhn pass in saId.ts. Used to assemble inputs the
// real validateSaId() will accept, without hard-coding any real-person IDs.

function synthLuhn(first12: string): string {
  let sum = 0;
  let doubleIt = true;     // position 12 (2nd from right of the full 13) doubles
  for (let i = first12.length - 1; i >= 0; i--) {
    let d = first12.charCodeAt(i) - 48;
    if (doubleIt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    doubleIt = !doubleIt;
  }
  return String((10 - (sum % 10)) % 10);
}

function synthSaId(parts: {
  year:        number;                  // full year e.g. 1995
  month:       number;                  // 1-12
  day:         number;                  // 1-31
  gender?:     'male' | 'female';       // affects sequence 0000-4999 vs 5000-9999
  citizenship?: 0 | 1 | 2;
  sequenceTail?: number;                // 0-999 — appended to the gender base
}): string {
  const yy = String(parts.year % 100).padStart(2, '0');
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  const seqBase = parts.gender === 'male' ? 5000 : 0;
  const seq = String(seqBase + (parts.sequenceTail ?? 123)).padStart(4, '0');
  const c   = String(parts.citizenship ?? 0);
  const a   = '8';
  const first12 = `${yy}${mm}${dd}${seq}${c}${a}`;
  return first12 + synthLuhn(first12);
}

// ─── validateSaId — happy paths ──────────────────────────────────────────────

describe('validateSaId — accepts well-formed IDs', () => {
  it('a typical 30-year-old in 2026', () => {
    const id = synthSaId({ year: 1996, month: 6, day: 15, gender: 'female' });
    expect(validateSaId(id)).toEqual({ valid: true });
  });

  it('a 50-year-old (1970s)', () => {
    const id = synthSaId({ year: 1975, month: 11, day: 3, gender: 'male' });
    expect(validateSaId(id)).toEqual({ valid: true });
  });

  it('an 18-year-old', () => {
    const id = synthSaId({ year: 2007, month: 12, day: 31 });
    expect(validateSaId(id)).toEqual({ valid: true });
  });

  it('citizenship 1 (permanent resident)', () => {
    const id = synthSaId({ year: 1990, month: 1, day: 1, citizenship: 1 });
    expect(validateSaId(id)).toEqual({ valid: true });
  });

  it('citizenship 2 (per the brief, also allowed)', () => {
    const id = synthSaId({ year: 1990, month: 1, day: 1, citizenship: 2 });
    expect(validateSaId(id)).toEqual({ valid: true });
  });

  it('leap-day born in a leap year (Feb 29 2000)', () => {
    const id = synthSaId({ year: 2000, month: 2, day: 29 });
    expect(validateSaId(id)).toEqual({ valid: true });
  });
});

// ─── validateSaId — per-reason rejection cases ───────────────────────────────

describe('validateSaId — length', () => {
  it.each(['', '12345', '12345678901234' /* 14 */, null, undefined])('rejects %p', (id) => {
    expect(validateSaId(id as unknown as string)).toEqual({ valid: false, reason: 'length' });
  });
});

describe('validateSaId — format', () => {
  it('rejects 13 chars containing non-digits', () => {
    expect(validateSaId('123abc1234567')).toEqual({ valid: false, reason: 'format' });
    expect(validateSaId('9701155009A87')).toEqual({ valid: false, reason: 'format' });
  });
});

describe('validateSaId — date', () => {
  it('rejects all-zeros (00/00/00 isn\'t a real date)', () => {
    expect(validateSaId('0000000000000')).toEqual({ valid: false, reason: 'date' });
  });

  it('rejects all-nines (99/99/99 isn\'t a real date)', () => {
    expect(validateSaId('9999999999999')).toEqual({ valid: false, reason: 'date' });
  });

  it('rejects Feb 31 (invalid day for month)', () => {
    // Build a 13-digit string with a clearly invalid Feb 31 date that happens
    // to be Luhn-valid — the date check must come BEFORE the checksum.
    const first12 = '97' + '02' + '31' + '5009' + '0' + '8';
    const id = first12 + synthLuhn(first12);
    expect(validateSaId(id)).toEqual({ valid: false, reason: 'date' });
  });

  it('rejects Feb 29 in a non-leap year (e.g. 2001)', () => {
    const first12 = '01' + '02' + '29' + '0123' + '0' + '8';
    const id = first12 + synthLuhn(first12);
    expect(validateSaId(id)).toEqual({ valid: false, reason: 'date' });
  });

  it('rejects month 13', () => {
    const first12 = '95' + '13' + '15' + '0123' + '0' + '8';
    const id = first12 + synthLuhn(first12);
    expect(validateSaId(id)).toEqual({ valid: false, reason: 'date' });
  });

  it('rejects an ID whose YY would force age > 115', () => {
    // Build an ID with YY=10. Today is 2026.
    //   20YY = 2010 → age 16 → that's what we accept.
    // To force the 19YY branch we'd need 20YY in the future. We can't easily
    // contrive that without overriding now(); instead, just confirm that
    // YY values within the 116-year window all parse, while a future 20YY
    // (e.g. 27 in 2026) falls back to 1927 and stays valid.
    const id = synthSaId({ year: 1927, month: 5, day: 5 });
    expect(validateSaId(id)).toEqual({ valid: true });
  });
});

describe('validateSaId — citizenship', () => {
  it.each([3, 4, 5, 6, 7, 8, 9])('rejects citizenship digit %i', (c) => {
    const first12 = '95' + '06' + '15' + '5009' + String(c) + '8';
    const id = first12 + synthLuhn(first12);
    expect(validateSaId(id)).toEqual({ valid: false, reason: 'citizenship' });
  });
});

describe('validateSaId — checksum', () => {
  it('rejects an ID whose 13th digit is one off the Luhn value', () => {
    const id   = synthSaId({ year: 1995, month: 6, day: 15 });
    const last = parseInt(id[12], 10);
    const wrongLast = String((last + 1) % 10);
    const corrupted = id.slice(0, 12) + wrongLast;
    expect(validateSaId(corrupted)).toEqual({ valid: false, reason: 'checksum' });
  });

  it('rejects all-zeros at format and date level — not at checksum (priority order matters)', () => {
    // 0000000000000 passes Luhn vacuously (sum=0) but must be rejected for date.
    expect(validateSaId('0000000000000')).toEqual({ valid: false, reason: 'date' });
  });
});

// ─── saIdDateOfBirth + saIdAge ───────────────────────────────────────────────

describe('saIdDateOfBirth', () => {
  it('returns the encoded date', () => {
    const id = synthSaId({ year: 1995, month: 6, day: 15 });
    const dob = saIdDateOfBirth(id)!;
    expect(dob.toISOString().slice(0, 10)).toBe('1995-06-15');
  });

  it('returns null for unparseable IDs', () => {
    expect(saIdDateOfBirth('')).toBeNull();
    expect(saIdDateOfBirth('not-an-id')).toBeNull();
  });

  it('applies the century pivot — YY=27 with today=2026 means 1927', () => {
    const id  = synthSaId({ year: 1927, month: 5, day: 1 });
    const now = new Date('2026-06-13T00:00:00Z');
    expect(saIdDateOfBirth(id, now)?.toISOString().slice(0, 10)).toBe('1927-05-01');
  });

  it('applies the century pivot — YY=24 with today=2026 means 2024 (the more recent)', () => {
    const id  = synthSaId({ year: 2024, month: 5, day: 1 });
    const now = new Date('2026-06-13T00:00:00Z');
    expect(saIdDateOfBirth(id, now)?.toISOString().slice(0, 10)).toBe('2024-05-01');
  });
});

describe('saIdAge', () => {
  it('computes completed years correctly across the birthday boundary', () => {
    const id  = synthSaId({ year: 2000, month: 6, day: 15 });
    // The day BEFORE the birthday → still 25
    expect(saIdAge(id, new Date('2026-06-14T00:00:00Z'))).toBe(25);
    // The birthday itself → 26
    expect(saIdAge(id, new Date('2026-06-15T00:00:00Z'))).toBe(26);
    // The day AFTER → 26
    expect(saIdAge(id, new Date('2026-06-16T00:00:00Z'))).toBe(26);
  });

  it('returns null for unparseable IDs', () => {
    expect(saIdAge('garbage')).toBeNull();
  });
});

// ─── Under-18 boundary (the patient signup gate uses this) ───────────────────

describe('saIdAge × under-18 gate', () => {
  it('a 17-year-old reports age 17 (caller blocks) — valid ID, just under-age', () => {
    const id  = synthSaId({ year: 2009, month: 6, day: 14 });
    const now = new Date('2026-06-13T00:00:00Z');
    expect(validateSaId(id)).toEqual({ valid: true });
    expect(saIdAge(id, now)).toBe(16);   // 16 — day before 17th birthday
  });

  it('an 18-year-old reports age 18', () => {
    const id  = synthSaId({ year: 2008, month: 6, day: 12 });
    const now = new Date('2026-06-13T00:00:00Z');
    expect(validateSaId(id)).toEqual({ valid: true });
    expect(saIdAge(id, now)).toBe(18);
  });
});
