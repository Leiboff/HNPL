import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import {
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  REFERRAL_CODE_PATTERN,
  generateReferralCode,
  normaliseReferralCode,
  isWellFormedReferralCode,
} from './code';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0145_referrals_foundation.sql'),
  'utf8',
);

describe('the alphabet excludes exactly the characters that get misread', () => {
  it('has no I, L, O, U, 0 or 1', () => {
    for (const c of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(REFERRAL_CODE_ALPHABET, `'${c}' is in the alphabet`).not.toContain(c);
    }
  });

  it('is 30 distinct upper-case characters', () => {
    expect(new Set(REFERRAL_CODE_ALPHABET).size).toBe(30);
    expect(REFERRAL_CODE_ALPHABET).toBe(REFERRAL_CODE_ALPHABET.toUpperCase());
  });
});

describe('the SQL CHECK and the TypeScript alphabet are the same alphabet', () => {
  // Two definitions is a drift risk, accepted because the database cannot
  // check a code against the application by reading it (same reasoning as
  // 0134's rate-limit buckets). This test is what makes the duplication safe:
  // a character added on one side and not the other fails here rather than
  // producing codes the database refuses to store.
  it('every character the generator can emit is accepted by the CHECK', () => {
    const sql = stripComments(MIG, { sql: true });
    const match = sql.match(/CHECK \(code ~ '\^\[([^\]]+)\]\{(\d+)\}\$'\)/);
    expect(match, 'the code CHECK constraint is no longer where this test looks').toBeTruthy();

    const [, sqlClass, sqlLength] = match!;
    expect(Number(sqlLength)).toBe(REFERRAL_CODE_LENGTH);

    // The SQL class is written with a range (2-9) where the TypeScript
    // alphabet spells the digits out, so it is expanded rather than compared
    // as text — comparing the strings would fail on a formatting difference
    // and pass on a real one.
    const expanded = expandCharClass(sqlClass);
    expect(new Set(expanded)).toEqual(new Set(REFERRAL_CODE_ALPHABET));
  });
});

/** Expand a POSIX-ish character class body ("ABC2-9") into its members. */
function expandCharClass(body: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i + 1] === '-' && body[i + 2]) {
      for (let c = body.charCodeAt(i); c <= body.charCodeAt(i + 2); c++) {
        out.push(String.fromCharCode(c));
      }
      i += 2;
      continue;
    }
    out.push(body[i]);
  }
  return out;
}

describe('generateReferralCode', () => {
  it('always produces a code the pattern accepts', () => {
    for (let i = 0; i < 500; i++) {
      expect(REFERRAL_CODE_PATTERN.test(generateReferralCode())).toBe(true);
    }
  });

  it('does not repeat itself', () => {
    // Not a randomness test — a broken generator returning a constant, or one
    // seeded per call, is the failure this catches. 500 draws from 30^8 have
    // a collision probability around 1e-7.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateReferralCode());
    expect(seen.size).toBe(500);
  });

  it('uses the whole alphabet, not a prefix of it', () => {
    // A modulo bug or an off-by-one on the index bound would silently confine
    // output to part of the set. Over 4000 characters every one of 30 should
    // appear; the chance any single character is missing is ~1e-59.
    const used = new Set<string>();
    for (let i = 0; i < 500; i++) for (const c of generateReferralCode()) used.add(c);
    expect(used.size).toBe(REFERRAL_CODE_ALPHABET.length);
  });
});

describe('normaliseReferralCode — what a person actually types', () => {
  it('accepts the code as issued', () => {
    expect(normaliseReferralCode('A2C4K9PT')).toBe('A2C4K9PT');
  });

  it('accepts lower case, whitespace and grouping dashes', () => {
    expect(normaliseReferralCode('  a2c4k9pt ')).toBe('A2C4K9PT');
    expect(normaliseReferralCode('A2C4-K9PT')).toBe('A2C4K9PT');
    expect(normaliseReferralCode('a2c4 k9pt')).toBe('A2C4K9PT');
  });

  it('refuses a code containing an excluded character rather than guessing', () => {
    // The dangerous alternative: mapping O→0 or I→1 "helpfully". Those
    // characters are not in the alphabet, so the input is a typo — and a
    // silent correction would resolve to a DIFFERENT valid code belonging to
    // somebody else, crediting the wrong person.
    expect(normaliseReferralCode('A2C4K9PO')).toBeNull();
    expect(normaliseReferralCode('A2C4K9PI')).toBeNull();
    expect(normaliseReferralCode('A2C4K9P0')).toBeNull();
  });

  it('refuses the wrong length, empty input and non-strings', () => {
    expect(normaliseReferralCode('A2C4K9P')).toBeNull();
    expect(normaliseReferralCode('A2C4K9PTX')).toBeNull();
    expect(normaliseReferralCode('')).toBeNull();
    expect(normaliseReferralCode(null)).toBeNull();
    expect(normaliseReferralCode(undefined)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normaliseReferralCode(12345678 as any)).toBeNull();
  });

  it('refuses anything with regex or SQL metacharacters in it', () => {
    // The value arrives from a query string and a cookie. It never reaches a
    // query as anything but a bound parameter, but the character class is the
    // reason that is true by construction rather than by review.
    for (const hostile of ["' OR 1=1--", 'A2C4K9P%', '.{8}', 'A2C4K9P\n']) {
      expect(normaliseReferralCode(hostile)).toBeNull();
    }
  });

  it('isWellFormedReferralCode agrees with it', () => {
    expect(isWellFormedReferralCode('a2c4-k9pt')).toBe(true);
    expect(isWellFormedReferralCode('nope')).toBe(false);
  });
});
