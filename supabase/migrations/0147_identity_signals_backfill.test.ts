// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── 0147 is a copy of 0138, and copies rot ───────────────────────────────
//
// 0147 exists because version 0138 was claimed by two different migrations
// (production's `identity_signals`, master's `reverse_geocode_rate_limit`),
// so a database that applied master's 0138 skips the restored one and never
// receives the identity-signal tables. 0147 re-installs them idempotently.
//
// The cost of that repair is two copies of the same DDL, and the failure mode
// is the quiet one: somebody edits 0138, 0147 keeps installing the old shape,
// and the two kinds of database diverge on exactly the schema nobody looks at
// until an audit. This test is what makes the duplication safe.

// Literal paths, not a joined directory constant: app/test-path-integrity
// resolves these statically to prove every source-text read points at a file
// that exists, and it cannot follow a variable.
const BACKFILL = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0147_identity_signals_backfill.sql'), 'utf8',
).replace(/\r\n/g, '\n');
const ORIGINAL = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0138_identity_signals.sql'), 'utf8',
).replace(/\r\n/g, '\n');

/** Comments and whitespace carry no schema, so compare only what does. */
const ddl = (sql: string) =>
  stripComments(sql, { sql: true })
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

describe('0147 backfill stays in lockstep with 0138', () => {
  it('installs exactly the DDL 0138 does', () => {
    expect(
      ddl(BACKFILL),
      '0147 re-installs 0138\'s objects for databases whose 0138 was the '
      + 'rate-limit migration. If you changed one file, change the other — or '
      + 'those databases get a different schema from production.',
    ).toBe(ddl(ORIGINAL));
  });

  it('is safe to run where the objects already exist', () => {
    // Production applied all of this as 0138, so 0147 runs there as a no-op.
    // That is only true while every statement is idempotent: a bare CREATE
    // TABLE / TRIGGER / POLICY would abort the migration and, with it, the
    // deploy.
    const body = ddl(BACKFILL);

    for (const m of body.matchAll(/^CREATE (TABLE|INDEX|UNIQUE INDEX) (.+)$/gm)) {
      expect(m[0], `"${m[0]}" needs IF NOT EXISTS`).toMatch(/IF NOT EXISTS/);
    }
    for (const m of body.matchAll(/^CREATE FUNCTION\b.*$/gm)) {
      expect.unreachable(`"${m[0]}" needs OR REPLACE`);
    }
    // Triggers and policies have no IF NOT EXISTS, so each must be preceded
    // by its own DROP ... IF EXISTS.
    for (const kind of ['TRIGGER', 'POLICY'] as const) {
      const created = [...body.matchAll(new RegExp(`^CREATE ${kind} ("?[\\w]+"?)`, 'gm'))]
        .map((m) => m[1].replace(/"/g, ''));
      expect(created.length).toBeGreaterThan(0);
      for (const name of created) {
        expect(
          body,
          `CREATE ${kind} ${name} has no matching DROP ${kind} IF EXISTS`,
        ).toMatch(new RegExp(`DROP ${kind} IF EXISTS "?${name}"?`));
      }
    }
  });
});
