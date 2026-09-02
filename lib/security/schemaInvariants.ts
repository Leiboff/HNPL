// ─── The effective RLS/trigger state, derived from the migrations ─────────
//
// WHY THIS EXISTS (audit round three, the structural finding)
//
// Three audits found Critical issues and two of them were the same shape: a
// table with a user-reachable INSERT policy and nothing guarding what the
// INSERT could contain.
//
//   F-01/F-05  patients rewrote plans and their own KYC columns  → 0121/0122
//   A-17       patients inserted phantom applications            → 0128
//   R3-01      patients forged their own payout row              → 0135
//   R3-02      anyone created an approved, trading practice      → 0135
//
// Every one of those was fixed properly and none of the fixes generalised.
// Nobody ever asked the question in its general form — "for every table,
// what can a user session INSERT, and what guards it?" — and that question
// is one join away from being answerable. Rounds one and two swept UPDATE
// exhaustively; INSERT never got the same sweep, which is exactly why R3-01
// and R3-02 survived them both.
//
// So this module answers it mechanically, and the test beside it makes the
// answer a build failure rather than a finding in a document eight months
// from now.
//
// ─── WHY REPLAY THE MIGRATIONS RATHER THAN QUERY THE DATABASE ─────────────
//
// Querying `pg_policies` on the live project is more accurate and useless in
// CI: there is no database in a test runner, and a check that only runs when
// someone remembers to point it at production is the kind of check that
// stops running. Replaying the migrations in version order reproduces the
// same catalog from files that are already in the repo, so it runs on every
// commit — and, more to the point, it runs on the commit that ADDS the
// policy, which is the only moment the fix is cheap.
//
// The replay was validated against the live catalog (project
// wcwuqpyjiexkvnilceko, migrations 0001–0135) when it was written: every
// policy and trigger this produces matched pg_policies / pg_trigger exactly,
// in both directions. That comparison is what makes the parser below
// trustworthy rather than plausible.
//
// ─── WHAT IT PARSES, AND WHY A REGEX IS ACCEPTABLE HERE ───────────────────
//
// A-08 is the standing lesson in this repo that a regex over a grammar the
// real parser reads differently is a vulnerability. That lesson does not
// transfer to this file, and it is worth saying why rather than assuming it:
//
//   • the input is OUR OWN migration corpus, not attacker-supplied text;
//   • a parse MISS here produces a false alarm (a table looks unguarded when
//     it is guarded), which someone notices immediately — not a silent
//     bypass;
//   • and the one dangerous direction — failing to SEE a policy, so a real
//     gap goes unreported — is closed by `assertFullyParsed`, which counts
//     the CREATE/DROP statements in the raw text and fails if the parser
//     accounted for fewer. The parser cannot quietly skip something.
//
// Dollar-quoted bodies are removed before parsing. Verified when this was
// written: no migration creates a policy or trigger inside a DO block or via
// EXECUTE, so nothing real is lost by discarding them, and keeping them
// would let a `CREATE POLICY` written inside a function's prose register as
// a real policy.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

export type Command = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
export type Timing  = 'BEFORE' | 'AFTER' | 'INSTEAD OF';

export type Policy = {
  table:     string;
  name:      string;
  /** The FOR clause. PostgreSQL defaults to ALL when it is omitted. */
  command:   Command;
  /** Migration filename this policy currently comes from. */
  migration: string;
};

export type Trigger = {
  table:     string;
  name:      string;
  timing:    Timing;
  events:    Set<'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'>;
  migration: string;
};

export type EffectiveSchema = {
  /** Keyed `table policyname` — a policy name is unique per table. */
  policies: Map<string, Policy>;
  /** Keyed `table triggername`. */
  triggers: Map<string, Trigger>;
};

export type Migration = { file: string; version: string; sql: string };

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

/** Strip `$$ … $$` and `$tag$ … $tag$` bodies. See the header. */
export function stripDollarQuoted(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (!open || open.index === undefined) { out += sql.slice(i); break; }
    const start = i + open.index;
    out += sql.slice(i, start);
    const tag = open[0];
    const close = sql.indexOf(tag, start + tag.length);
    // An unterminated body runs to EOF — discard the rest, as the server
    // would fail on it anyway and we must not treat prose as statements.
    if (close === -1) break;
    // Keep a newline so line structure (and therefore statement separation)
    // survives.
    out += '\n';
    i = close + tag.length;
  }
  return out;
}

/** Migration files, in the version order the CLI applies them. */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((file) => ({
      file,
      version: (/^(\d+)/.exec(file)?.[1]) ?? '',
      sql: readFileSync(resolve(dir, file), 'utf8').replace(/\r\n/g, '\n'),
    }));
}

/** Comments and function bodies gone; everything else verbatim. */
export function statementText(sql: string): string {
  return stripDollarQuoted(stripComments(sql, { sql: true }));
}

const IDENT = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`;

const RE_CREATE_POLICY = new RegExp(
  String.raw`\bCREATE\s+POLICY\s+${IDENT}\s+ON\s+(?:public\.)?${IDENT}([\s\S]*?)(?=;)`,
  'gi',
);
const RE_DROP_POLICY = new RegExp(
  String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+(?:public\.)?${IDENT}`,
  'gi',
);
const RE_CREATE_TRIGGER = new RegExp(
  String.raw`\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+${IDENT}\s+` +
  String.raw`(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]*?)\s+ON\s+(?:public\.)?${IDENT}`,
  'gi',
);
const RE_DROP_TRIGGER = new RegExp(
  String.raw`\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+(?:public\.)?${IDENT}`,
  'gi',
);

/** `"quoted"` or bare — the regexes above capture both into a pair. */
const pick = (q?: string, bare?: string): string => (q ?? bare ?? '').toLowerCase();

const key = (table: string, name: string): string => `${table} ${name}`;

function parseCommand(tail: string): Command {
  const m = /\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i.exec(tail);
  // No FOR clause means ALL — the PostgreSQL default, and the case that
  // makes `admins_all_*` policies grant INSERT without ever saying so.
  return (m ? m[1].toUpperCase() : 'ALL') as Command;
}

/**
 * Replay every migration in order and return the schema they leave behind.
 *
 * Later statements win, which is what makes this an effective state rather
 * than a list of everything ever written: 0030's `DROP POLICY
 * users_insert_own_profile` really does remove 0002's policy here, the same
 * way it does in the database.
 */
export function replaySchema(migrations: Migration[] = readMigrations()): EffectiveSchema {
  const policies = new Map<string, Policy>();
  const triggers = new Map<string, Trigger>();

  for (const mig of migrations) {
    const text = statementText(mig.sql);

    for (const m of text.matchAll(RE_DROP_POLICY)) {
      policies.delete(key(pick(m[3], m[4]), pick(m[1], m[2])));
    }
    for (const m of text.matchAll(RE_CREATE_POLICY)) {
      const name  = pick(m[1], m[2]);
      const table = pick(m[3], m[4]);
      policies.set(key(table, name), {
        table, name, command: parseCommand(m[5] ?? ''), migration: mig.file,
      });
    }

    for (const m of text.matchAll(RE_DROP_TRIGGER)) {
      triggers.delete(key(pick(m[3], m[4]), pick(m[1], m[2])));
    }
    for (const m of text.matchAll(RE_CREATE_TRIGGER)) {
      const name   = pick(m[1], m[2]);
      const timing = (m[3] ?? '').toUpperCase().replace(/\s+/g, ' ') as Timing;
      const table  = pick(m[5], m[6]);
      const events = new Set(
        (m[4] ?? '').toUpperCase().split(/\s+OR\s+/)
          // `UPDATE OF status` is one event with a column list attached, so
          // take the leading keyword of each clause rather than the whole
          // clause. Missing this made 0069's
          // `AFTER UPDATE OF status ON practices` parse to NO events at all —
          // caught by diffing the replay against pg_trigger, not by
          // assertFullyParsed, which only counts statements and had correctly
          // seen this one.
          .map((e) => e.trim().split(/\s+/)[0] ?? '')
          .filter((e): e is 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' =>
            e === 'INSERT' || e === 'UPDATE' || e === 'DELETE' || e === 'TRUNCATE'),
      );
      triggers.set(key(table, name), { table, name, timing, events, migration: mig.file });
    }
  }

  return { policies, triggers };
}

/**
 * Fail loudly if the parser accounted for fewer statements than the raw text
 * contains.
 *
 * This is the assertion that makes the regexes above safe to rely on. A
 * pattern that silently stops matching — because someone writes `CREATE
 * POLICY` across a line break the regex does not expect, or schema-qualifies
 * a table a new way — would otherwise make a real gap invisible. Counting
 * the keywords independently of the parse means the parser can be wrong, but
 * it cannot be quietly wrong.
 */
export function assertFullyParsed(migrations: Migration[] = readMigrations()): void {
  const problems: string[] = [];

  for (const mig of migrations) {
    const text = statementText(mig.sql);
    const counts = {
      'CREATE POLICY':  (text.match(/\bCREATE\s+POLICY\b/gi)  ?? []).length,
      'DROP POLICY':    (text.match(/\bDROP\s+POLICY\b/gi)    ?? []).length,
      'CREATE TRIGGER': (text.match(/\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/gi) ?? []).length,
      'DROP TRIGGER':   (text.match(/\bDROP\s+TRIGGER\b/gi)   ?? []).length,
    };
    const parsed = {
      'CREATE POLICY':  [...text.matchAll(RE_CREATE_POLICY)].length,
      'DROP POLICY':    [...text.matchAll(RE_DROP_POLICY)].length,
      'CREATE TRIGGER': [...text.matchAll(RE_CREATE_TRIGGER)].length,
      'DROP TRIGGER':   [...text.matchAll(RE_DROP_TRIGGER)].length,
    };
    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      if (parsed[k] !== counts[k]) {
        problems.push(`${mig.file}: saw ${counts[k]} "${k}" but parsed ${parsed[k]}`);
      }
    }
  }

  if (problems.length) {
    throw new Error(
      'lib/security/schemaInvariants.ts could not parse every policy/trigger '
      + 'statement. The invariant tests below are only as good as this parse, '
      + 'so this is a hard failure rather than a warning. Fix the pattern (or '
      + 'the migration\'s formatting) before relying on the result:\n  '
      + problems.join('\n  '),
    );
  }
}

/** Tables where a user session can INSERT, per the effective policy set. */
export function tablesWithUserInsert(schema: EffectiveSchema): Map<string, Policy[]> {
  const byTable = new Map<string, Policy[]>();
  for (const p of schema.policies.values()) {
    if (p.command !== 'INSERT' && p.command !== 'ALL') continue;
    byTable.set(p.table, [...(byTable.get(p.table) ?? []), p]);
  }
  return byTable;
}

/** Does this table have a BEFORE INSERT row trigger? */
export function hasBeforeInsertTrigger(schema: EffectiveSchema, table: string): boolean {
  for (const t of schema.triggers.values()) {
    if (t.table === table && t.timing === 'BEFORE' && t.events.has('INSERT')) return true;
  }
  return false;
}

// ─── The EXECUTE allow-list (0125) ────────────────────────────────────────
//
// 0125 inverted function privileges: ALTER DEFAULT PRIVILEGES revokes
// EXECUTE from PUBLIC/anon/authenticated, so a function added after it is
// private on creation and a browser-callable one needs an explicit GRANT.
//
// That is only an allow-list while somebody is checking the list. This finds
// every grant to anon/authenticated written at or after 0125 so the test can
// hold it against the names 0125 actually reasoned about.

export type FunctionGrant = { fn: string; roles: string[]; migration: string };

// The name span excludes `;` and `'` and the terminator accepts a closing
// quote, and BOTH of those are load-bearing — found when 0138 made the old
// form mis-report.
//
// Grants inside DO blocks are written as `EXECUTE 'GRANT EXECUTE ON FUNCTION
// f(...) TO service_role';` — there is no semicolon INSIDE the string, so a
// `[\s\S]*?` name span could not terminate there and ran on until the next
// `TO <roles>;` anywhere later in the file. That produced a grant that reads
// as "the function named at the start, granted to the roles from an
// unrelated statement at the end" — in 0138's case a table grant several
// hundred lines away, reported as `identity_link_counts → authenticated`.
//
// Wrong in the alarming direction as well as the noisy one: the same run-on
// would attribute a REAL anon grant to whatever function name happened to
// come first, so the allow-list check would demand the wrong name and, once
// that name was added, stop noticing the actual one.
const RE_GRANT_EXECUTE =
  /\bGRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([^;']*?)\s+TO\s+([A-Za-z_, \t]+?)\s*(?:'|;|$)/gi;

export function browserCallableGrants(
  migrations: Migration[] = readMigrations(),
  sinceVersion = '0125',
): FunctionGrant[] {
  const out: FunctionGrant[] = [];
  for (const mig of migrations) {
    if (!mig.version || mig.version < sinceVersion) continue;
    // Grants inside DO blocks are real; 0125 and 0129 both write them that
    // way, so this one scan keeps the function bodies.
    const text = stripComments(mig.sql, { sql: true });
    for (const m of text.matchAll(RE_GRANT_EXECUTE)) {
      const roles = m[2].split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
      if (!roles.some((r) => r === 'anon' || r === 'authenticated')) continue;
      // `name(args)` → `name`. The signature is not the interesting part; a
      // second overload of an allow-listed name is still a decision someone
      // has to have made.
      const fn = (/^(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)/.exec(m[1].trim())?.[1] ?? m[1].trim())
        .toLowerCase();
      out.push({ fn, roles, migration: mig.file });
    }
  }
  return out;
}

// ─── Drift detection against the live catalog ─────────────────────────────
//
// The invariant test replays the migrations, which tells you what a fresh
// environment gets. It cannot tell you what PRODUCTION has — and R3-08 was
// exactly a case where those differed, undetected, for months.
//
// This is the comparison, as a pure function so it can be tested without a
// database. `scripts/check-rls-drift.ts` supplies the snapshot by calling
// `rls_catalog_snapshot()` (migration 0137) on the service-role client.
//
// Both directions matter and they mean different things:
//
//   only in the DATABASE   — a hand-edit. It will vanish on the next rebuild.
//   only in the MIGRATIONS — the migration did not reach this environment, or
//                            something dropped the object by hand. Either way
//                            the repo is describing a defence that is not
//                            actually running.
//
// Neither is more urgent in general, so neither is downgraded to a warning.

export type CatalogSnapshot = {
  policies: Array<{ table: string; name: string; cmd: string }>;
  triggers: Array<{ table: string; name: string; timing: string; events: string[] | null }>;
};

export type DriftReport = {
  ok: boolean;
  policiesOnlyInDatabase:   string[];
  policiesOnlyInMigrations: string[];
  policiesDiffering:        string[];
  triggersOnlyInDatabase:   string[];
  triggersOnlyInMigrations: string[];
  triggersDiffering:        string[];
};

const normEvents = (e: Iterable<string> | null | undefined): string =>
  [...(e ?? [])].map((x) => x.toUpperCase()).sort().join('+');

/** Compare the migration replay against a live catalog snapshot. */
export function diffSchemaAgainstCatalog(
  schema:   EffectiveSchema,
  snapshot: CatalogSnapshot,
): DriftReport {
  const dbPolicies = new Map(
    (snapshot.policies ?? []).map((p) => [
      key(p.table.toLowerCase(), p.name.toLowerCase()),
      (p.cmd ?? 'ALL').toUpperCase(),
    ]),
  );
  const dbTriggers = new Map(
    (snapshot.triggers ?? []).map((t) => [
      key(t.table.toLowerCase(), t.name.toLowerCase()),
      `${(t.timing ?? '').toUpperCase()}|${normEvents(t.events)}`,
    ]),
  );

  const migPolicies = new Map(
    [...schema.policies.values()].map((p) => [key(p.table, p.name), p.command]),
  );
  const migTriggers = new Map(
    [...schema.triggers.values()].map((t) => [
      key(t.table, t.name), `${t.timing}|${normEvents(t.events)}`,
    ]),
  );

  const onlyIn = (a: Map<string, string>, b: Map<string, string>): string[] =>
    [...a.keys()].filter((k) => !b.has(k)).sort();

  const differing = (a: Map<string, string>, b: Map<string, string>): string[] =>
    [...a.entries()]
      .filter(([k, v]) => b.has(k) && b.get(k) !== v)
      .map(([k, v]) => `${k}: database=${v} migrations=${b.get(k)}`)
      .sort();

  const report: DriftReport = {
    ok: true,
    policiesOnlyInDatabase:   onlyIn(dbPolicies,  migPolicies),
    policiesOnlyInMigrations: onlyIn(migPolicies, dbPolicies),
    policiesDiffering:        differing(dbPolicies, migPolicies),
    triggersOnlyInDatabase:   onlyIn(dbTriggers,  migTriggers),
    triggersOnlyInMigrations: onlyIn(migTriggers, dbTriggers),
    triggersDiffering:        differing(dbTriggers, migTriggers),
  };
  report.ok = Object.values(report).every((v) => v === true || (Array.isArray(v) && v.length === 0));
  return report;
}

/** Human-readable drift report. Empty string when there is none. */
export function formatDriftReport(r: DriftReport): string {
  if (r.ok) return '';
  const section = (title: string, items: string[]): string =>
    items.length ? `\n  ${title}\n${items.map((i) => `    - ${i}`).join('\n')}` : '';
  return [
    section('POLICIES present in the DATABASE but in no migration (hand-edits):', r.policiesOnlyInDatabase),
    section('POLICIES in the migrations but MISSING from the database:',          r.policiesOnlyInMigrations),
    section('POLICIES whose command differs:',                                     r.policiesDiffering),
    section('TRIGGERS present in the DATABASE but in no migration (hand-edits):', r.triggersOnlyInDatabase),
    section('TRIGGERS in the migrations but MISSING from the database:',          r.triggersOnlyInMigrations),
    section('TRIGGERS whose timing or events differ:',                             r.triggersDiffering),
  ].join('');
}
