// @vitest-environment node
//
// ─── The numbering, pinned against production's recorded history ──────────
//
// These are the assertions that would have caught 0138 on the commit that
// created it, instead of leaving a billable route unlimited until somebody
// went looking. Everything here reads files — no database, so it runs in CI
// on every commit, which is the whole point (same argument as
// schemaInvariants.ts makes for replaying rather than querying).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { RATE_LIMITS } from './rateLimit';
import {
  readMigrationFiles,
  duplicateVersions,
  unrunnableFiles,
  numberingGaps,
  nextFreeVersion,
  PRODUCTION_ONLY_VERSIONS,
  UNEXPLAINED_GAPS,
} from './migrationHistory';

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');
const FILES = readMigrationFiles(MIGRATIONS_DIR);

describe('migration numbering', () => {
  it('reads the corpus at all', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES[0].file).toBe('0001_initial_schema.sql');
  });

  it('gives every version to exactly one file', () => {
    // CLAUDE.md: "Two files at the same version are ambiguous — never create
    // one." The CLI records the version once, so the file it did not run is
    // indistinguishable from the one it did.
    expect(duplicateVersions(FILES)).toEqual([]);
  });

  it('has no file on a version production already recorded under another name', () => {
    // THE 0138 REGRESSION. A file here can never be applied by `db push` and
    // never reported as pending — it is not late, it is unreachable. Move it
    // to a free version, or retire it if something else now carries the
    // change, but do not leave it sitting on a claimed number.
    const stuck = unrunnableFiles(FILES).map(
      ({ file, recordedAs }) => `${file.file} — production records ${file.version} as ${recordedAs}`,
    );
    expect(stuck).toEqual([]);
  });

  it('accounts for every hole in the sequence', () => {
    // A gap is either a production row this repo has not mirrored yet, or a
    // known historical hole. An undeclared one is where the next collision
    // hides: the numbering looks continuous, so the next author takes the
    // number and lands on top of whatever is actually there.
    const declared = new Set([
      ...PRODUCTION_ONLY_VERSIONS.map((r) => r.version),
      ...UNEXPLAINED_GAPS,
    ]);
    expect(numberingGaps(FILES).filter((v) => !declared.has(v))).toEqual([]);
  });

  it('every production-only version is genuinely absent from the repo', () => {
    // Keeps the manifest honest in the other direction. The day someone
    // transcribes 0139 out of production, this fails until they delete the
    // entry — which is the review moment where "is this really what the live
    // database has?" gets asked.
    const present = new Set(FILES.map((f) => f.version));
    expect(PRODUCTION_ONLY_VERSIONS.filter((r) => present.has(r.version))).toEqual([]);
  });

  it('points the next migration past BOTH histories', () => {
    // Not `max(local) + 1`. 0139 and 0140 exist in production and nowhere
    // here, so counting from the repository alone walks straight back into
    // the collision this whole module is about.
    expect(nextFreeVersion(FILES)).toBe('0146');
  });
});

// ─── What the retired 0138 was for, and where it went ─────────────────────
//
// 0138_reverse_geocode_rate_limit.sql did one thing: CREATE OR REPLACE
// `rate_limit_known_bucket` with `reverse_geocode` added to the list. It was
// deleted rather than renumbered, because 0145 already restates the whole
// list — including `reverse_geocode` — and the only free versions left are
// AFTER 0145. A renumbered 0146 would therefore have become the function's
// last declaration, and the buckets test reads the last one; a copy of the
// list that has to be kept in step with 0145 forever, for no schema effect
// at all, is a footgun rather than a record.
//
// So the change is not lost, but that now rests on 0145. These tests hold it
// there.

describe('the reverse_geocode bucket survived the retirement of 0138', () => {
  const declaring = FILES.filter(({ file }) =>
    /CREATE OR REPLACE FUNCTION rate_limit_known_bucket/.test(
      stripComments(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'), { sql: true }),
    ));

  /** The declaration a database actually ends up with. */
  const last = declaring[declaring.length - 1];

  it('the retired file is not back', () => {
    expect(FILES.map((f) => f.file)).not.toContain('0138_reverse_geocode_rate_limit.sql');
  });

  it('the surviving declaration is 0145, and it applies', () => {
    // "It applies" is the load-bearing half: 0145 is not on a claimed
    // version, so unlike 0138 it will actually run.
    expect(last.file).toBe('0145_referrals_foundation.sql');
    expect(unrunnableFiles([last])).toEqual([]);
  });

  it('that declaration still names every bucket the app can send', () => {
    const list = stripComments(
      readFileSync(resolve(MIGRATIONS_DIR, last.file), 'utf8'), { sql: true },
    );
    for (const bucket of Object.keys(RATE_LIMITS)) {
      expect(list).toContain(`'${bucket}'`);
    }
    // Named explicitly as well as swept, so that dropping `reverse_geocode`
    // from RateLimitBucket in TypeScript cannot quietly satisfy the loop.
    expect(list).toContain(`'reverse_geocode'`);
  });
});
