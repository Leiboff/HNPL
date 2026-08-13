import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── No manual script depends on plans.provider_id ────────────────────────
//
// 0094 moved bill attribution from plans.provider_id (which referenced an auth
// user, so a roster-only practitioner could never be billed for) to
// plans.provider_member_id (a practice_members row). provider_id is retained as
// backfill evidence, COMMENTed deprecated, and a later migration DROPS it.
//
// The application moved in the same commit. The scripts under scripts/ did not,
// and that is the failure this file exists to prevent: a hand-run script that
// still names the column turns the eventual DROP into a breakage discovered
// while someone is halfway through a cleanup or an RLS check — the worst
// possible moment, and one nothing else in CI would catch, because these
// scripts are never executed by a test.
//
// WHY A REGEX RATHER THAN RUNNING THEM
// ────────────────────────────────────
// These are operator scripts: one wants service-role access to auth.users, the
// other expects the full migration chain and a live Postgres. Neither is
// runnable here. What CAN be checked cheaply is the thing that breaks — the
// column name, in a statement about plans.
//
// SCOPED TO plans, WHICH IS THE WHOLE DIFFICULTY
// ──────────────────────────────────────────────
// payouts.provider_id and patient_invitations.provider_id are DIFFERENT columns
// on different tables, both still live and both still correct to use — see
// lib/payments/activateFirstInstalment.ts, which explains why a roster
// practitioner's payout carries no provider_id at all. A test that banned the
// bare string would fail on those and teach the next reader to widen it until
// it caught nothing.
//
// So each occurrence is ATTRIBUTED to a table: scan backwards for the nearest
// from / into / update / join (SQL or the PostgREST `.from('x')` form) and take
// that table name. Imperfect by construction — a deeply nested subquery could
// fool it — which is why the two known former call sites are ALSO asserted
// positively below rather than only by absence.

const ROOT    = resolve(process.cwd());
const SCRIPTS = resolve(ROOT, 'scripts');

const rel = (p: string) => relative(ROOT, p).split(/[\\/]/).join('/');

function scriptFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { scriptFiles(full, acc); continue; }
    if (/\.(sql|ts|tsx|js|mjs)$/.test(entry) && !/\.test\.[tj]sx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

// Comments discuss the deprecated column at length — including in this repo's
// own migration headers — so they are stripped before anything is asserted.
// `sql: true` because most of these are .sql: a `-- …` comment naming a path
// with `/*` in it would otherwise open a block comment and delete the
// statement below it. See lib/testing/stripComments.ts.
const codeOf = (src: string) => stripComments(src, { sql: true });

const FILES = scriptFiles(SCRIPTS).map((p) => ({
  path: rel(p),
  code: codeOf(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')),
}));

/**
 * The table each `provider_id` in `code` belongs to, best-effort: the nearest
 * from / into / update / join before it. `\bprovider_id\b` deliberately does
 * NOT match inside `v_provider_id`, so plpgsql variables named after the old
 * column are left alone — they are local names, not schema.
 */
function providerIdOwners(code: string): string[] {
  const TABLE  = /\b(?:from|into|update|join)\s*\(?['"]?(?:public\.)?(\w+)/gi;
  const COLUMN = /\bprovider_id\b/g;

  const tables: Array<{ at: number; name: string }> = [];
  for (const m of code.matchAll(TABLE)) {
    tables.push({ at: m.index!, name: m[1].toLowerCase() });
  }

  const owners: string[] = [];
  for (const m of code.matchAll(COLUMN)) {
    const preceding = tables.filter((t) => t.at < m.index!);
    owners.push(preceding.length ? preceding[preceding.length - 1].name : '(unattributed)');
  }
  return owners;
}

// ─── The ban ──────────────────────────────────────────────────────────────

describe('scripts/ does not read or write plans.provider_id', () => {
  it('finds scripts to check in the first place', () => {
    // Guard against the whole file going vacuous if the directory moves.
    expect(FILES.length).toBeGreaterThan(1);
    const paths = FILES.map((f) => f.path);
    expect(paths).toContain('scripts/test-trading-gate-rls.sql');
    expect(paths).toContain('scripts/cleanup-unconfirmed-test-users.sql');
  });

  it('the attribution helper works on known cases before it is trusted', () => {
    // A test that reports "no offenders" is worthless if it cannot find one.
    expect(providerIdOwners('SELECT x FROM plans WHERE provider_id = 1')).toEqual(['plans']);
    expect(providerIdOwners("svc.from('payouts').select('provider_id')")).toEqual(['payouts']);
    // A select list sits BEFORE its own FROM, so the helper cannot attribute it.
    // Hence '(unattributed)' counts as an offender below rather than a pass.
    expect(providerIdOwners('SELECT provider_id FROM plans')).toEqual(['(unattributed)']);
    // And it must not mistake a plpgsql variable for the column.
    expect(providerIdOwners('SELECT x FROM plans WHERE y = v_provider_id')).toEqual([]);
  });

  it('no provider_id in any script belongs to plans, or to nothing identifiable', () => {
    const offenders = FILES
      .filter((f) => providerIdOwners(f.code)
        .some((owner) => owner === 'plans' || owner === '(unattributed)'))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('no script WRITES the column, by either shape', () => {
    // The precise, heuristic-free half: an insert column list or an update set
    // clause naming it. This is the shape that breaks hardest on the DROP.
    for (const { path, code } of FILES) {
      for (const ins of code.match(/INSERT INTO\s+(?:public\.)?plans\s*\([^)]*\)/gi) ?? []) {
        expect(ins, `${path} writes plans.provider_id`).not.toMatch(/\bprovider_id\b/);
      }
      for (const upd of code.match(/UPDATE\s+(?:public\.)?plans\s+SET[\s\S]{0,300}?(?=;|WHERE)/gi) ?? []) {
        expect(upd, `${path} updates plans.provider_id`).not.toMatch(/\bprovider_id\b/);
      }
    }
  });
});

// ─── Replaced, not merely deleted ─────────────────────────────────────────

describe('the two former call sites now go through the membership', () => {
  it('the RLS gate script attributes both plans inserts to a practice_members row', () => {
    // Absence alone would also be satisfied by quietly dropping the column from
    // the insert, which would leave the script testing the gate through a path
    // no real caller uses.
    const gate = FILES.find((f) => f.path === 'scripts/test-trading-gate-rls.sql')!;
    const inserts = gate.code.match(/INSERT INTO plans \([^)]*\)/gi) ?? [];
    expect(inserts.length).toBe(2);
    for (const ins of inserts) expect(ins).toMatch(/provider_member_id/);

    // The ids fed to them are real rows, captured with RETURNING — not bare
    // uuids that the FK would reject, which would make the inserts fail for the
    // wrong reason and turn scenario 3 (must SUCCEED) into a false pass.
    expect(gate.code).toMatch(/RETURNING id INTO v_admin_member_id/);
    expect(gate.code).toMatch(/RETURNING id INTO v_provider_member_id/);
  });

  it('the cleanup script resolves the practitioner through practice_members', () => {
    const cleanup = FILES.find(
      (f) => f.path === 'scripts/cleanup-unconfirmed-test-users.sql',
    )!;
    // Both places it used to key on plans.provider_id: the preview count and
    // the _cleanup_plans snapshot.
    expect((cleanup.code.match(/provider_member_id IN \(/g) ?? []).length).toBe(2);
    expect(cleanup.code).toMatch(/FROM public\.practice_members pm/);
    // The other tables' own provider_id columns are deliberately untouched.
    expect(providerIdOwners(cleanup.code).sort()).toEqual([
      'patient_invitations', 'patient_invitations', 'payouts', 'payouts',
    ]);
  });

  it('the column is still only deprecated, not dropped', () => {
    // When this fails, provider_id has gone from the schema — at which point
    // this whole file has done its job and can go with it.
    const mig = readFileSync(
      resolve(ROOT, 'supabase/migrations/0094_plans_provider_member.sql'), 'utf8',
    );
    expect(mig).toMatch(/COMMENT ON COLUMN plans\.provider_id IS/);
    expect(mig).toMatch(/DEPRECATED as of 0094/);
  });
});
