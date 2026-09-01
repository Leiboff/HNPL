import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TERMS_DOC_SHA256, PRIVACY_DOC_SHA256,
  TERMS_DOC_PATH, PRIVACY_DOC_PATH,
  consentColumns,
} from './documentHash';
import { TERMS_VERSION } from './terms';
import { PRIVACY_VERSION } from './privacy';

// ─── The test IS the enforcement (audit A-14) ─────────────────────────────
//
// `profiles.terms_version` said '1.0' and nothing stopped a clause from being
// edited without bumping it, so the record could not answer "how do we know
// the text said that in August?" — which is the only question that matters in
// a dispute over an NCA credit agreement.
//
// The hash is a committed constant rather than something computed at runtime,
// because Next bundles server code and the .tsx is not reliably on disk in a
// serverless function; a hash that silently becomes null in production is
// worse than none. So the constant is checked HERE, against the file, and
// editing a clause without bumping the version and the hash together turns
// this suite red.
//
// If you are reading this because the test just failed: that is the intended
// behaviour, not a broken test. Bump the version, paste the reported hash in,
// and leave every existing row alone — the old version/hash pair is what a
// customer who signed last month actually agreed to.

const ROOT = resolve(process.cwd());
const sha  = (p: string) =>
  createHash('sha256')
    // Normalised so a checkout with CRLF line endings does not change the
    // digest of an unedited document.
    .update(readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

describe('the committed digests match the documents they claim to cover', () => {
  it(`terms — ${TERMS_DOC_PATH}`, () => {
    const actual = sha(TERMS_DOC_PATH);
    expect(
      TERMS_DOC_SHA256,
      `The terms text changed. If that is deliberate: bump TERMS_VERSION (now `
      + `${TERMS_VERSION}) and its effective date, then set TERMS_DOC_SHA256 to `
      + `${actual}. Do NOT backfill existing rows.`,
    ).toBe(actual);
  });

  it(`privacy — ${PRIVACY_DOC_PATH}`, () => {
    const actual = sha(PRIVACY_DOC_PATH);
    expect(
      PRIVACY_DOC_SHA256,
      `The privacy text changed. If that is deliberate: bump PRIVACY_VERSION `
      + `(now ${PRIVACY_VERSION}) and its effective date, then set `
      + `PRIVACY_DOC_SHA256 to ${actual}. Do NOT backfill existing rows.`,
    ).toBe(actual);
  });

  it('both are full SHA-256 digests, not truncated or placeholder', () => {
    for (const h of [TERMS_DOC_SHA256, PRIVACY_DOC_SHA256]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(TERMS_DOC_SHA256).not.toBe(PRIVACY_DOC_SHA256);
  });
});

describe('consentColumns — one shape for all three acceptance points', () => {
  it('carries the timestamp, both versions and both digests', () => {
    const cols = consentColumns(new Date('2026-09-02T10:00:00.000Z'));
    expect(cols).toEqual({
      terms_accepted_at:  '2026-09-02T10:00:00.000Z',
      terms_version:      TERMS_VERSION,
      privacy_version:    PRIVACY_VERSION,
      terms_doc_sha256:   TERMS_DOC_SHA256,
      privacy_doc_sha256: PRIVACY_DOC_SHA256,
    });
  });

  it('is used by every path that records an acceptance', () => {
    // Three inline object literals is how one of them comes to be missing a
    // column — the signup path's own comment already said so about its
    // internal copies. One function, three callers.
    for (const p of [
      'app/signup/patient/actions.ts',
      'app/auth/callback/route.ts',
      'app/checkout/[token]/actions.ts',
    ]) {
      const src = readFileSync(resolve(ROOT, p), 'utf8');
      expect(src, `${p} must record acceptance through consentColumns()`)
        .toMatch(/consentColumns\(/);
      // …and must not hand-roll the columns beside it.
      expect(src).not.toMatch(/terms_accepted_at:\s*new Date\(\)\.toISOString\(\)/);
    }
  });
});
