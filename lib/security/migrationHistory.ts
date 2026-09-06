// ─── The migration numbering, checked against what production recorded ────
//
// WHY THIS EXISTS
//
// `supabase db push` decides what to apply by VERSION ALONE. It reads the
// leading digits off each filename, compares that set against the versions
// in `supabase_migrations.schema_migrations`, and runs whatever is missing.
// The recorded NAME beside each version is never consulted.
//
// That is fine while the repository and the database agree about what each
// version means, and it fails silently the moment they do not:
//
//     repo         0138_reverse_geocode_rate_limit.sql
//     production   0138  identity_signals
//
// Version 0138 is present on both sides, so the CLI calls it applied and
// moves on. `supabase migration list` prints 0138 in both columns and shows
// nothing wrong. The local file is never executed, never will be, and
// nothing says so — the migration is not "pending", it is INVISIBLE.
//
// The real one cost this repository the `reverse_geocode` rate-limit bucket.
// `consume_rate_limit` refuses unknown buckets by RAISING A WARNING AND
// RETURNING TRUE (0134, deliberately — a misspelled bucket must not become
// an outage), so the missing bucket did not throw, did not log an error, and
// did not fail a test. It just meant the billable reverse-geocoding route
// ran unlimited in production for as long as the collision stood.
//
// ─── HOW THE COLLISION HAPPENED, SO THE SHAPE IS RECOGNISABLE ─────────────
//
// Production took three migrations that were authored somewhere other than
// this repository — 0138 identity_signals, 0139 unique_verified_phone, 0140
// verified_phone_unique_index — applied via the Supabase MCP and never
// written back into `supabase/migrations`. Meanwhile the repo, which knew
// nothing about them, kept counting and reached 0138 on its own.
//
// So the two halves of the drift are separate problems with separate fixes:
//
//   • A LOCAL FILE AT A VERSION PRODUCTION HAS CLAIMED can never run. It has
//     to move to a free version, or be retired if something else now carries
//     its change. This module makes that a build failure.
//   • A VERSION PRODUCTION HAS AND THE REPO DOES NOT is a rebuild hazard of
//     the kind 0136 documents at length: `supabase db reset`, a fresh
//     staging project or a disaster-recovery rebuild produces a database
//     MISSING those objects, and nobody finds out until something depends on
//     them. That one cannot be fixed from the repository alone — the DDL has
//     to be transcribed out of production — so this module cannot enforce
//     it. What it can do is refuse to let the gap go unnamed.
//
// The manifest below is the written-down half of the drift. It is small on
// purpose: it records only the versions where the repository and production
// are known to disagree, not a mirror of the whole history, because a
// hand-maintained copy of 145 rows would rot into a second source of truth.
//
// See docs/MIGRATION-HISTORY.md for the operational side.

import { readdirSync } from 'node:fs';

/** A `NNNN_slug.sql` file in supabase/migrations. */
export type MigrationFile = {
  /** The leading digits — exactly what the Supabase CLI keys on. */
  version: string;
  /** Everything after the underscore, minus `.sql`. */
  slug: string;
  file: string;
};

/**
 * A version `supabase_migrations.schema_migrations` records in production
 * under a name this repository does not carry at that version.
 */
export type ProductionOnlyVersion = {
  version: string;
  /** The name as production recorded it. */
  name: string;
  /** What it did, as far as is known, and what finishing it requires. */
  note: string;
};

/**
 * Production's rows that this repository has no file for.
 *
 * Every entry here is a version that `db push` will never offer to apply and
 * that `db reset` will never reproduce. Removing an entry is a claim that the
 * repository now carries that migration — so removing one without adding the
 * corresponding `supabase/migrations/NNNN_*.sql` file trips the test beside
 * this module.
 */
export const PRODUCTION_ONLY_VERSIONS: readonly ProductionOnlyVersion[] = [
  {
    version: '0138',
    name: 'identity_signals',
    note:
      'Applied to production out-of-band. No DDL for it exists anywhere in ' +
      'this repository and nothing here references an `identity_signals` ' +
      'object, so it cannot be reconstructed from the code — it has to be ' +
      'transcribed from the live schema. Until it is, a database built from ' +
      'these migrations is missing whatever it created.',
  },
  {
    version: '0139',
    name: 'unique_verified_phone',
    note:
      'Applied out-of-band; first noted in the header of 0141, which was ' +
      'numbered to sit after it. Uniqueness on a verified phone number is a ' +
      'security control — the same shape as 0097 on sa_id_lookup_hash — so ' +
      'a rebuilt database is the PERMISSIVE one until this is mirrored. ' +
      'That is exactly the failure mode 0136 was written about.',
  },
  {
    version: '0140',
    name: 'verified_phone_unique_index',
    note:
      'Applied out-of-band, immediately after 0139 and presumably its ' +
      'index half. Same rebuild hazard, same remedy: transcribe from ' +
      'production.',
  },
];

/**
 * Numbering gaps that are NOT production rows and are not understood.
 *
 * 0012 predates every audit in this repository and no migration, document or
 * test mentions it. It is listed so the gap check stays exhaustive: an
 * undocumented hole is how the next 0138 hides.
 */
export const UNEXPLAINED_GAPS: readonly string[] = ['0012'];

const MIGRATION_FILENAME = /^(\d{4})_(.+)\.sql$/;

/** Every `NNNN_slug.sql` in `dir`, in the order the CLI applies them. */
export function readMigrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const m = MIGRATION_FILENAME.exec(file);
      if (!m) throw new Error(`migration filename is not NNNN_slug.sql: ${file}`);
      return { version: m[1], slug: m[2], file };
    });
}

/**
 * Versions carried by more than one file.
 *
 * CLAUDE.md forbids these outright, and the reason is the same silent skip:
 * the CLI records the version once, so whichever file it did not run is
 * indistinguishable from one it did.
 */
export function duplicateVersions(files: readonly MigrationFile[]): MigrationFile[][] {
  const byVersion = new Map<string, MigrationFile[]>();
  for (const f of files) {
    const group = byVersion.get(f.version);
    if (group) group.push(f);
    else byVersion.set(f.version, [f]);
  }
  return [...byVersion.values()].filter((g) => g.length > 1);
}

/**
 * Local files sitting on a version production has recorded under another
 * name — the migrations that can never run.
 */
export function unrunnableFiles(
  files: readonly MigrationFile[],
  recorded: readonly ProductionOnlyVersion[] = PRODUCTION_ONLY_VERSIONS,
): Array<{ file: MigrationFile; recordedAs: string }> {
  const claimed = new Map(recorded.map((r) => [r.version, r.name]));
  return files.flatMap((file) => {
    const recordedAs = claimed.get(file.version);
    return recordedAs ? [{ file, recordedAs }] : [];
  });
}

/** Every version between 0001 and the highest local file that has no file. */
export function numberingGaps(files: readonly MigrationFile[]): string[] {
  const present = new Set(files.map((f) => f.version));
  const highest = Math.max(0, ...files.map((f) => Number(f.version)));
  const gaps: string[] = [];
  for (let n = 1; n <= highest; n++) {
    const v = String(n).padStart(4, '0');
    if (!present.has(v)) gaps.push(v);
  }
  return gaps;
}

/** The version a new migration must take: one past everything either side knows. */
export function nextFreeVersion(
  files: readonly MigrationFile[],
  recorded: readonly ProductionOnlyVersion[] = PRODUCTION_ONLY_VERSIONS,
): string {
  const highest = Math.max(
    0,
    ...files.map((f) => Number(f.version)),
    ...recorded.map((r) => Number(r.version)),
  );
  return String(highest + 1).padStart(4, '0');
}
