// @vitest-environment node
//
// ─── The drift comparison, proved without a database ──────────────────────
//
// `scripts/check-rls-drift.ts` decides "production still matches the repo"
// from `diffSchemaAgainstCatalog`. That function is the whole check, so it
// gets tested directly rather than only exercised by the script — a drift
// detector that silently reports "no drift" is worse than none, because it
// retires the question.
//
// The cases below are the real R3-08 shapes, re-created as fixtures:
//
//   • a policy that exists only in the DATABASE   — the hand-edit
//   • a policy that exists only in the MIGRATIONS — the rebuild that lost one
//   • the RENAME, which is both at once and is what R3-08 actually looked
//     like (practice_members_select_plans → practice_admins_select_plans)
//   • a command change on the same policy name — a widening that keeps its
//     name and would otherwise pass a names-only comparison
//   • trigger timing and event drift, which is how R3-01 would have shown up
//     had someone dropped protect_payouts_write by hand

import { describe, it, expect } from 'vitest';
import {
  diffSchemaAgainstCatalog,
  formatDriftReport,
  type CatalogSnapshot,
  type EffectiveSchema,
  type Command,
  type Timing,
} from './schemaInvariants';

type P = { table: string; name: string; command: Command };
type T = { table: string; name: string; timing: Timing; events: string[] };

/** Build the shape `replaySchema()` returns, without parsing anything. */
function migrations(policies: P[], triggers: T[] = []): EffectiveSchema {
  return {
    policies: new Map(policies.map((p) => [
      `${p.table} ${p.name}`,
      { ...p, migration: 'fixture.sql' },
    ])),
    triggers: new Map(triggers.map((t) => [
      `${t.table} ${t.name}`,
      {
        table: t.table, name: t.name, timing: t.timing,
        events: new Set(t.events as Array<'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'>),
        migration: 'fixture.sql',
      },
    ])),
  };
}

/** Build what `rls_catalog_snapshot()` returns. */
function database(
  policies: Array<{ table: string; name: string; cmd: string }>,
  triggers: Array<{ table: string; name: string; timing: string; events: string[] | null }> = [],
): CatalogSnapshot {
  return { policies, triggers };
}

describe('diffSchemaAgainstCatalog — agreement', () => {
  it('reports ok when both sides match', () => {
    const r = diffSchemaAgainstCatalog(
      migrations(
        [{ table: 'plans', name: 'patients_select_own_plans', command: 'SELECT' }],
        [{ table: 'payouts', name: 'trg_protect_payouts_write', timing: 'BEFORE', events: ['INSERT', 'UPDATE', 'DELETE'] }],
      ),
      database(
        [{ table: 'plans', name: 'patients_select_own_plans', cmd: 'SELECT' }],
        [{ table: 'payouts', name: 'trg_protect_payouts_write', timing: 'BEFORE', events: ['DELETE', 'INSERT', 'UPDATE'] }],
      ),
    );
    expect(r.ok).toBe(true);
    expect(formatDriftReport(r)).toBe('');
  });

  it('is case- and order-insensitive, because the catalog is', () => {
    // pg_policies returns whatever case the object was created with, and
    // jsonb_agg order is not guaranteed to match ours.
    const r = diffSchemaAgainstCatalog(
      migrations(
        [
          { table: 'plans',    name: 'a', command: 'SELECT' },
          { table: 'payments', name: 'b', command: 'INSERT' },
        ],
        [{ table: 'payments', name: 'trg', timing: 'BEFORE', events: ['UPDATE', 'INSERT'] }],
      ),
      database(
        [
          { table: 'PAYMENTS', name: 'B', cmd: 'INSERT' },
          { table: 'Plans',    name: 'A', cmd: 'SELECT' },
        ],
        [{ table: 'Payments', name: 'TRG', timing: 'before', events: ['INSERT', 'UPDATE'] }],
      ),
    );
    expect(r.ok).toBe(true);
  });
});

describe('diffSchemaAgainstCatalog — the R3-08 shapes', () => {
  it('catches a policy that exists only in the DATABASE (the hand-edit)', () => {
    const r = diffSchemaAgainstCatalog(
      migrations([]),
      database([{ table: 'payments', name: 'provider_select_own_payments', cmd: 'SELECT' }]),
    );
    expect(r.ok).toBe(false);
    expect(r.policiesOnlyInDatabase).toEqual(['payments provider_select_own_payments']);
    expect(r.policiesOnlyInMigrations).toEqual([]);
    expect(formatDriftReport(r)).toContain('hand-edits');
  });

  it('catches a policy that exists only in the MIGRATIONS (never applied, or dropped by hand)', () => {
    const r = diffSchemaAgainstCatalog(
      migrations([{ table: 'payouts', name: 'protect_something', command: 'ALL' }]),
      database([]),
    );
    expect(r.ok).toBe(false);
    expect(r.policiesOnlyInMigrations).toEqual(['payouts protect_something']);
    expect(formatDriftReport(r)).toContain('MISSING from the database');
  });

  it('catches the RENAME — what R3-08 actually was — in both directions at once', () => {
    const r = diffSchemaAgainstCatalog(
      migrations([{ table: 'plans', name: 'practice_members_select_plans', command: 'SELECT' }]),
      database([{ table: 'plans', name: 'practice_admins_select_plans',  cmd: 'SELECT' }]),
    );
    expect(r.ok).toBe(false);
    expect(r.policiesOnlyInDatabase).toEqual(['plans practice_admins_select_plans']);
    expect(r.policiesOnlyInMigrations).toEqual(['plans practice_members_select_plans']);
  });

  it('catches a command change under an unchanged name', () => {
    // The dangerous quiet case: a SELECT policy hand-widened to ALL keeps its
    // name, so a names-only comparison would call this clean.
    const r = diffSchemaAgainstCatalog(
      migrations([{ table: 'payouts', name: 'admins_all_payouts', command: 'SELECT' }]),
      database([{ table: 'payouts', name: 'admins_all_payouts', cmd: 'ALL' }]),
    );
    expect(r.ok).toBe(false);
    expect(r.policiesOnlyInDatabase).toEqual([]);
    expect(r.policiesDiffering).toEqual([
      'payouts admins_all_payouts: database=ALL migrations=SELECT',
    ]);
  });
});

describe('diffSchemaAgainstCatalog — triggers', () => {
  it('catches a guard trigger dropped by hand', () => {
    const r = diffSchemaAgainstCatalog(
      migrations([], [{ table: 'payouts', name: 'trg_protect_payouts_write', timing: 'BEFORE', events: ['INSERT'] }]),
      database([], []),
    );
    expect(r.ok).toBe(false);
    expect(r.triggersOnlyInMigrations).toEqual(['payouts trg_protect_payouts_write']);
  });

  it('catches a trigger that lost an event', () => {
    // R3-02 in miniature: the trigger is still there, but no longer fires on
    // INSERT. Present in both sides, so only the event comparison sees it.
    const r = diffSchemaAgainstCatalog(
      migrations([], [{ table: 'practices', name: 'trg_protect_practices_columns', timing: 'BEFORE', events: ['INSERT', 'UPDATE'] }]),
      database([], [{ table: 'practices', name: 'trg_protect_practices_columns', timing: 'BEFORE', events: ['UPDATE'] }]),
    );
    expect(r.ok).toBe(false);
    expect(r.triggersDiffering).toEqual([
      'practices trg_protect_practices_columns: database=BEFORE|UPDATE migrations=BEFORE|INSERT+UPDATE',
    ]);
  });

  it('catches a BEFORE guard silently becoming AFTER', () => {
    // An AFTER trigger cannot refuse a write by raising — it fires once the
    // row is in. Same name, same events, completely different guarantee.
    const r = diffSchemaAgainstCatalog(
      migrations([], [{ table: 'plans', name: 'trg_protect_plans_write', timing: 'BEFORE', events: ['INSERT'] }]),
      database([], [{ table: 'plans', name: 'trg_protect_plans_write', timing: 'AFTER',  events: ['INSERT'] }]),
    );
    expect(r.ok).toBe(false);
    expect(r.triggersDiffering[0]).toContain('database=AFTER|INSERT migrations=BEFORE|INSERT');
  });

  it('tolerates a null events array from the catalog without crashing', () => {
    // jsonb_agg over an all-NULL set returns NULL, not []. A drift checker
    // that throws is a drift checker that gets switched off.
    const r = diffSchemaAgainstCatalog(
      migrations([], []),
      database([], [{ table: 't', name: 'x', timing: 'BEFORE', events: null }]),
    );
    expect(r.ok).toBe(false);
    expect(r.triggersOnlyInDatabase).toEqual(['t x']);
  });
});

describe('formatDriftReport', () => {
  it('is empty on agreement and names every category on drift', () => {
    expect(formatDriftReport({
      ok: true,
      policiesOnlyInDatabase: [], policiesOnlyInMigrations: [], policiesDiffering: [],
      triggersOnlyInDatabase: [], triggersOnlyInMigrations: [], triggersDiffering: [],
    })).toBe('');

    const text = formatDriftReport({
      ok: false,
      policiesOnlyInDatabase: ['a b'], policiesOnlyInMigrations: ['c d'], policiesDiffering: ['e f: x'],
      triggersOnlyInDatabase: ['g h'], triggersOnlyInMigrations: ['i j'], triggersDiffering: ['k l: y'],
    });
    for (const fragment of ['a b', 'c d', 'e f: x', 'g h', 'i j', 'k l: y']) {
      expect(text).toContain(fragment);
    }
  });
});

// ─── The wiring, against the real schema ──────────────────────────────────
//
// The fixtures above prove the comparison logic. This proves the SHAPE
// MAPPING on the actual 120-policy / 31-trigger schema: Set<events> → sorted
// array, Map keys → `table name`, and the exact field names
// `rls_catalog_snapshot()` emits (`table` / `name` / `cmd` / `timing` /
// `events`). A mismatch there would make the script report drift on a clean
// database, or — far worse — report clean because nothing lined up.
//
// Content equality between the replay and production was established
// separately, by diffing both catalogs directly when 0136 was written.

describe('diffSchemaAgainstCatalog — wiring against the real replayed schema', () => {
  it('a snapshot shaped exactly as the RPC emits it compares clean', async () => {
    const { replaySchema } = await import('./schemaInvariants');
    const live = replaySchema();

    // Exactly the projection rls_catalog_snapshot() performs (0137).
    const snapshot: CatalogSnapshot = {
      policies: [...live.policies.values()].map((p) => ({
        table: p.table, name: p.name, cmd: p.command,
      })),
      triggers: [...live.triggers.values()].map((t) => ({
        table: t.table, name: t.name, timing: t.timing, events: [...t.events].sort(),
      })),
    };

    expect(snapshot.policies.length).toBeGreaterThan(100);
    expect(snapshot.triggers.length).toBeGreaterThan(20);

    const r = diffSchemaAgainstCatalog(live, snapshot);
    expect(formatDriftReport(r)).toBe('');
    expect(r.ok).toBe(true);
  });

  it('and drift on that same schema is still detected', async () => {
    // Guards against the mapping accidentally comparing nothing to nothing.
    const { replaySchema } = await import('./schemaInvariants');
    const live = replaySchema();
    const snapshot: CatalogSnapshot = {
      policies: [...live.policies.values()]
        .filter((p) => p.name !== 'admins_all_payouts')
        .map((p) => ({ table: p.table, name: p.name, cmd: p.command })),
      triggers: [...live.triggers.values()].map((t) => ({
        table: t.table, name: t.name, timing: t.timing, events: [...t.events].sort(),
      })),
    };
    const r = diffSchemaAgainstCatalog(live, snapshot);
    expect(r.ok).toBe(false);
    expect(r.policiesOnlyInMigrations).toContain('payouts admins_all_payouts');
  });
});
