import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { resolveBrandPracticeSetup, BRAND_TABLE_AUTHORITY } from './brandPracticeSetup';
import { loadSetupChecklistFacts, buildSetupChecklist } from '@/lib/practice/setupChecklist';
import type { BrandPracticeRow } from './brandViewer';

// ─── Setup state across a brand ─────────────────────────────────────────────
//
// The single assertion this file exists for: the Practices table and the
// practice's OWN setup checklist card must never disagree. A brand admin told
// "banking: set" while the practice manager is being nagged to add banking is
// worse than showing nothing, because the two of them will spend the call
// arguing about which screen is broken.
//
// So the agreement is asserted DIRECTLY — the loader's output is compared
// against buildSetupChecklist over the same facts — and then adversarially: a
// change to banking must flip BOTH surfaces, in the same direction, in one step.
//
// The fake client honours its filters and throws on an unmodelled table, so the
// per-practice scoping is real rather than assumed, and a future query cannot
// pass silently.

type Row = Record<string, unknown>;

const COMPLETE = {
  id: 'p-complete',
  phone: '+27 11 555 0000',
  address_line1: '12 Oxford Rd',
  latitude: -26.14,
  longitude: 28.04,
  till_pin_hash: 'hash',
  bank_name: 'FNB',
  bank_account_number: '620123456',
  branch_code: '250655',
  account_holder: 'Rosebank Dental',
  account_type: 'cheque',
  group_id: 'g1',
};

/** Same practice, but banking cleared and no practitioner on the roster. */
const INCOMPLETE = {
  ...COMPLETE,
  id: 'p-incomplete',
  bank_name: null,
  bank_account_number: null,
};

function practiceRow(id: string, over: Partial<BrandPracticeRow> = {}): BrandPracticeRow {
  return {
    id,
    name:    id === 'p-complete' ? 'Rosebank' : 'Sandton',
    status:  'approved',
    suburb:  'Rosebank',
    city:    'Johannesburg',
    groupId: 'g1',
    feePct:  6,
    ...over,
  };
}

const MODELLED = new Set(['practices', 'practice_members', 'till_devices', 'practice_groups']);

function makeClient(state: Record<string, Row[]>) {
  return {
    from(table: string) {
      if (!MODELLED.has(table)) {
        throw new Error(`fake: unmodelled table "${table}" — model it or the test is vacuous`);
      }
      const filters: Array<[string, unknown]> = [];
      const nulls: string[] = [];
      let cap: number | null = null;

      // .limit() is HONOURED, and that is load-bearing rather than pedantry.
      // loadSetupChecklistFacts reads practice_members and till_devices with
      // .limit(1), because the checklist only ever asks "> 0" — so its
      // activeProviderCount / activeTillDeviceCount are 0-or-1 in production
      // however many rows exist. A fake that ignored the limit would let this
      // module (and the table above it) present those as real counts and pass.
      const rows = () => {
        const matched = (state[table] ?? []).filter(
          (r) =>
            filters.every(([c, v]) => r[c] === v) &&
            nulls.every((c) => r[c] === null || r[c] === undefined),
        );
        return cap === null ? matched : matched.slice(0, cap);
      };

      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        is: (c: string) => { nulls.push(c); return b; },
        limit: (n: number) => { cap = n; return b; },
        maybeSingle: async () => ({ data: rows()[0] ?? null }),
        then: (onFulfilled: (v: { data: Row[] }) => unknown) =>
          Promise.resolve({ data: rows() }).then(onFulfilled),
      };
      return b;
    },
  };
}

/** A world with one fully-set-up practice and one missing banking + a doctor. */
function world(
  over: { practices?: Row[]; members?: Row[]; devices?: Row[]; groups?: Row[] } = {},
): Record<string, Row[]> {
  return {
    practices: over.practices ?? [COMPLETE, INCOMPLETE],
    practice_members: over.members ?? [
      { id: 'm1', practice_id: 'p-complete', active: true, role: 'provider' },
    ],
    till_devices: over.devices ?? [
      { id: 'd1', practice_id: 'p-complete', revoked_at: null },
    ],
    // Brand banking is empty by default, so the group fallback does not rescue
    // p-incomplete — which is the case the table has to surface.
    practice_groups: over.groups ?? [
      { id: 'g1', bank_name: null, bank_account_number: null },
    ],
  };
}

const ROWS = [practiceRow('p-complete'), practiceRow('p-incomplete')];
const run = (state = world(), rows = ROWS) => resolveBrandPracticeSetup(makeClient(state), rows);

// ─── The agreement ─────────────────────────────────────────────────────────

describe('the table agrees with the practice\'s own checklist card', () => {
  it('every item verdict IS the checklist\'s own item verdict, per practice', async () => {
    const state = world();
    const setup = await run(state);

    for (const row of setup) {
      const facts     = await loadSetupChecklistFacts(makeClient(state), row.practiceId);
      const checklist = buildSetupChecklist(facts, BRAND_TABLE_AUTHORITY);

      // Same keys, same order, same booleans — not "both happen to be false".
      expect(row.items.map((i) => i.key)).toEqual(checklist.items.map((i) => i.key));
      expect(row.items.map((i) => i.done)).toEqual(checklist.items.map((i) => i.done));
      expect(row.doneCount).toBe(checklist.doneCount);
      expect(row.total).toBe(checklist.total);
      expect(row.setupComplete).toBe(checklist.complete);
    }
  });

  it('the keyed lookup the columns read matches the items array', async () => {
    const setup = await run();
    for (const row of setup) {
      for (const item of row.items) {
        expect(row.done[item.key]).toBe(item.done);
      }
    }
  });

  it('the outstanding list is the checklist\'s own titles, in its own order', async () => {
    const setup = await run();
    const incomplete = setup.find((s) => s.practiceId === 'p-incomplete')!;
    // Ordered as buildSetupChecklist orders them — the two trading-gate
    // conditions lead, because they block billing outright, and `details` comes
    // last. Not sorted or re-prioritised here: the practice reads these in this
    // order on its own card.
    expect(incomplete.outstanding).toEqual(['banking', 'provider']);
    expect(incomplete.items.filter((i) => !i.done).map((i) => i.title))
      .toEqual(['Bank account', 'The doctor or practitioner']);
  });
});

// ─── Adversarial: change banking, BOTH surfaces flip ──────────────────────

describe('adversarial — flipping a practice\'s banking flips both surfaces together', () => {
  it('banking absent → table says not set AND the card would still ask for it', async () => {
    const state  = world();
    const before = await run(state);
    const row    = before.find((s) => s.practiceId === 'p-incomplete')!;

    const facts = await loadSetupChecklistFacts(makeClient(state), 'p-incomplete');
    const card  = buildSetupChecklist(facts, BRAND_TABLE_AUTHORITY);

    expect(row.done.banking).toBe(false);
    expect(card.items.find((i) => i.key === 'banking')!.done).toBe(false);
    expect(row.needsAttention).toBe(true);
  });

  it('banking added → the table ticks it in the SAME step the card does', async () => {
    const state = world({
      practices: [
        COMPLETE,
        { ...INCOMPLETE, bank_name: 'Nedbank', bank_account_number: '1234567890' },
      ],
      members: [
        { id: 'm1', practice_id: 'p-complete',   active: true, role: 'provider' },
        { id: 'm2', practice_id: 'p-incomplete', active: true, role: 'provider' },
      ],
    });

    const row   = (await run(state)).find((s) => s.practiceId === 'p-incomplete')!;
    const facts = await loadSetupChecklistFacts(makeClient(state), 'p-incomplete');
    const card  = buildSetupChecklist(facts, BRAND_TABLE_AUTHORITY);

    expect(row.done.banking).toBe(true);
    expect(card.items.find((i) => i.key === 'banking')!.done).toBe(true);
    expect(row.setupComplete).toBe(true);
    expect(card.complete).toBe(true);
    expect(row.needsAttention).toBe(false);
  });

  it('BRAND banking rescues a branch with none of its own — the case a raw bank_name read gets wrong', async () => {
    // The whole reason this module delegates. A branch settling through its
    // brand's central account is correctly configured; a table that read
    // practices.bank_name directly would nag it forever.
    const state = world({
      practices: [COMPLETE, INCOMPLETE],
      members: [
        { id: 'm1', practice_id: 'p-complete',   active: true, role: 'provider' },
        { id: 'm2', practice_id: 'p-incomplete', active: true, role: 'provider' },
      ],
      groups: [
        { id: 'g1', bank_name: 'Standard Bank', bank_account_number: '00998877' },
      ],
    });

    const row = (await run(state)).find((s) => s.practiceId === 'p-incomplete')!;
    expect(row.done.banking).toBe(true);
    expect(row.setupComplete).toBe(true);
  });
});

// ─── Approval: the column the checklist deliberately does not have ────────

describe('approval is reported verbatim, and never confused with setup', () => {
  it('a fully set-up but pending practice still needs attention', async () => {
    const state = world({
      members: [
        { id: 'm1', practice_id: 'p-complete', active: true, role: 'provider' },
      ],
    });
    const setup = await resolveBrandPracticeSetup(makeClient(state), [
      practiceRow('p-complete', { status: 'pending' }),
    ]);
    const row = setup[0];
    expect(row.setupComplete).toBe(true);     // nothing left for THEM to do
    expect(row.approved).toBe(false);
    expect(row.status).toBe('pending');
    expect(row.needsAttention).toBe(true);    // but a brand admin should still see it
    expect(row.outstanding).toEqual([]);      // and NOT be told an item is missing
  });

  it('status is passed through untouched, whatever it says', async () => {
    for (const status of ['approved', 'pending', 'suspended', 'rejected']) {
      const setup = await resolveBrandPracticeSetup(makeClient(world()), [
        practiceRow('p-complete', { status }),
      ]);
      expect(setup[0].status).toBe(status);
      expect(setup[0].approved).toBe(status === 'approved');
    }
  });

  it('approved + complete → no attention needed', async () => {
    const setup = await resolveBrandPracticeSetup(makeClient(world()), [practiceRow('p-complete')]);
    expect(setup[0].needsAttention).toBe(false);
  });
});

// ─── Till: facts, not a verdict ───────────────────────────────────────────

describe('the till is reported as facts because the checklist treats it as optional', () => {
  it('carries device presence and PIN state separately', async () => {
    const setup = await run();
    const complete   = setup.find((s) => s.practiceId === 'p-complete')!;
    const incomplete = setup.find((s) => s.practiceId === 'p-incomplete')!;

    expect(complete.hasTillDevice).toBe(true);
    expect(complete.hasTillPin).toBe(true);
    expect(incomplete.hasTillDevice).toBe(false);
    expect(incomplete.hasTillPin).toBe(true);
  });

  it('a REVOKED device does not count — revoked rows are kept forever (0088)', async () => {
    const state = world({
      devices: [{ id: 'd1', practice_id: 'p-complete', revoked_at: '2026-01-01T00:00:00Z' }],
    });
    const row = (await run(state)).find((s) => s.practiceId === 'p-complete')!;
    expect(row.hasTillDevice).toBe(false);
  });

  it('no till NEVER makes a practice need attention — it is not a required item', async () => {
    // The one thing this column must not do: turn a practice that bills from
    // the manager's laptop into a problem.
    const state = world({ devices: [] });
    const row = (await run(state)).find((s) => s.practiceId === 'p-complete')!;
    expect(row.hasTillDevice).toBe(false);
    expect(row.setupComplete).toBe(true);
    expect(row.needsAttention).toBe(false);
  });

  it('presence, NOT a count — three devices still report as booleans', async () => {
    // The bug this guards: the underlying read is .limit(1)-ed, so a "count"
    // could only ever be 1. A table column saying "1 registered" for a practice
    // with three tills would be a specific claim, and wrong. The fake honours
    // .limit(), so this test is capable of failing.
    const state = world({
      devices: [
        { id: 'd1', practice_id: 'p-complete', revoked_at: null },
        { id: 'd2', practice_id: 'p-complete', revoked_at: null },
        { id: 'd3', practice_id: 'p-complete', revoked_at: null },
      ],
      members: [
        { id: 'm1', practice_id: 'p-complete', active: true, role: 'provider' },
        { id: 'm2', practice_id: 'p-complete', active: true, role: 'provider' },
      ],
    });
    const row = (await run(state)).find((s) => s.practiceId === 'p-complete')!;
    expect(row.hasTillDevice).toBe(true);
    expect(row.hasProvider).toBe(true);
    // And nothing numeric leaked into the shape a component could print.
    expect(row).not.toHaveProperty('activeTillDeviceCount');
    expect(row).not.toHaveProperty('activeProviderCount');
  });
});

// ─── Ordering ────────────────────────────────────────────────────────────

describe('ordering puts the practices that need a human first', () => {
  it('needs-attention practices lead, then most-outstanding, then name', async () => {
    const state = world({
      practices: [
        COMPLETE,
        INCOMPLETE,
        { ...INCOMPLETE, id: 'p-empty', phone: null, address_line1: null, latitude: null, longitude: null },
      ],
      members: [{ id: 'm1', practice_id: 'p-complete', active: true, role: 'provider' }],
    });
    const setup = await resolveBrandPracticeSetup(makeClient(state), [
      practiceRow('p-complete', { name: 'Aardvark' }),      // fine, alphabetically first
      practiceRow('p-incomplete', { name: 'Zulu' }),        // 2 outstanding
      practiceRow('p-empty', { name: 'Mango' }),            // 3 outstanding
    ]);
    expect(setup.map((s) => s.practiceName)).toEqual(['Mango', 'Zulu', 'Aardvark']);
  });
});

// ─── Adversarial: scoping ────────────────────────────────────────────────

describe('a brand admin only ever sees the practices they were handed', () => {
  it('a practice outside the list never appears, however many rows exist', async () => {
    const state = world({
      practices: [COMPLETE, INCOMPLETE, { ...COMPLETE, id: 'p-other-brand', group_id: 'g-other' }],
    });
    const setup = await resolveBrandPracticeSetup(makeClient(state), [practiceRow('p-complete')]);
    expect(setup.map((s) => s.practiceId)).toEqual(['p-complete']);
    expect(JSON.stringify(setup)).not.toContain('p-other-brand');
  });

  it('an empty list reads nothing', async () => {
    expect(await resolveBrandPracticeSetup(makeClient(world()), [])).toEqual([]);
  });
});

// ─── Source pins ─────────────────────────────────────────────────────────

describe('source pins — one derivation, not two', () => {
  const SRC  = readFileSync(resolve(process.cwd(), 'lib/brand/brandPracticeSetup.ts'), 'utf8');
  const code = stripComments(SRC);

  it('goes through the checklist module rather than reading setup rows itself', () => {
    expect(code).toMatch(/loadSetupChecklistFacts/);
    expect(code).toMatch(/buildSetupChecklist/);
    expect(code).not.toMatch(/from\('practices'\)/);
    expect(code).not.toMatch(/from\('till_devices'\)/);
    expect(code).not.toMatch(/from\('practice_members'\)/);
    // And in particular never the raw banking columns, which is the read that
    // gets a centrally-banked branch wrong.
    expect(code).not.toMatch(/bank_name|bank_account_number/);
    expect(code).not.toMatch(/resolvePayoutBanking/);
  });

  it('never re-derives an item verdict — it copies item.done', () => {
    expect(code).toMatch(/done\[item\.key\] = item\.done/);
    // No local predicate for any of the three required items.
    expect(code).not.toMatch(/bankingResolved/);
    expect(code).not.toMatch(/latitude|longitude|address_line1/);
  });

  it('reads item.href NOWHERE — the practice\'s own card owns the fix path', () => {
    // Deep-linking from the table would mean a second set of fix-it URLs
    // derived from a brand-admin authority constant, which could drift from the
    // ones the card computes for the real viewer.
    expect(code).not.toMatch(/\.href/);
  });

  it('does not re-implement the checklist\'s private tillDone predicate', () => {
    // It surfaces the two facts instead. A local AND of them would be the
    // parallel implementation this module exists to avoid.
    expect(code).not.toMatch(/activeTillDeviceCount > 0 &&/);
    expect(code).not.toMatch(/tillDone/);
  });

  it('formats nothing — no dates, no money anywhere on this surface', () => {
    expect(code).not.toMatch(/new Date\(|toISOString|toFixed|toLocaleString/);
  });

  it('states the brand admin\'s real rights rather than a convenient true', () => {
    // canManageTeam FALSE: brand authority is never converted into a
    // practice-member capability.
    expect(BRAND_TABLE_AUTHORITY.canManageTeam).toBe(false);
    expect(BRAND_TABLE_AUTHORITY.canEditDetails).toBe(true);
    expect(BRAND_TABLE_AUTHORITY.canManageTill).toBe(true);
  });
});
