import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

// ─── Source-text regression ──────────────────────────────────────────────────
//
// Ban new direct SA-ID, SA-phone, and email regexes outside lib/validation/.
// A future copy-paste would otherwise drift away from the canonical
// validators and re-introduce the bug class we just removed (no Luhn check,
// no real-date check, no cell-only enforcement, etc.).
//
// If you genuinely need a new validator: add it to lib/validation/ and
// import the named export here, then update this test's allowlist.

const ROOT = resolve(process.cwd());

/** Recursively collect .ts / .tsx files under `dir`, skipping ignored folders. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  const IGNORE = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git', 'public']);
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    const st   = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Normalise separators so the same path works on Windows (\) and POSIX (/). */
function rel(p: string): string {
  return relative(ROOT, p).split(/[\\/]/).join('/');
}

const ALL_SRC = collectSourceFiles(ROOT)
  .filter((p) => !rel(p).startsWith('lib/validation/'))
  // Build artefacts that occasionally land under .next/dev/* — paranoia.
  .filter((p) => !p.includes('.next'));

// ─── Banned patterns ─────────────────────────────────────────────────────────

// Email — the exact loose regex previously copied 3+ times. We allow the
// `text-[^…]` Tailwind utilities and similar coincidental matches to pass
// by anchoring on the full @-pattern.
const EMAIL_REGEX_LITERAL = /\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+/;

// SA ID — the "13 consecutive digits" anchored regex.
const SA_ID_REGEX_LITERAL = /\\d\{13\}/;

// SA phone — either the previous local helper (`27\d{9}|0\d{9}`) or
// equivalent shapes that pin the SA prefix.
const SA_PHONE_REGEX_LITERAL = /27\\d\{9\}|\\+27\\d\{9\}|0\\d\{9\}/;

describe('regression: validation regexes live only in lib/validation/', () => {
  it('email regex appears in lib/validation/email.ts ONLY', () => {
    const offenders = ALL_SRC.filter((path) => EMAIL_REGEX_LITERAL.test(readFileSync(path, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('SA ID 13-digit regex appears in lib/validation/saId.ts ONLY', () => {
    const offenders = ALL_SRC.filter((path) => SA_ID_REGEX_LITERAL.test(readFileSync(path, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('SA phone regex appears in lib/validation/phone.ts ONLY', () => {
    const offenders = ALL_SRC.filter((path) => SA_PHONE_REGEX_LITERAL.test(readFileSync(path, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });
});
