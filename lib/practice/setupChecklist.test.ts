import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import {
  buildSetupChecklist,
  loadSetupChecklistFacts,
  type SetupChecklistFacts,
  type SetupChecklistAuthority,
} from './setupChecklist';

/** Own source, comments stripped — for the few pins that read it. */
const CODE = stripComments(
  readFileSync(resolve(process.cwd(), 'lib/practice/setupChecklist.ts'), 'utf8'),
);

// ─── Tests — setup checklist derivation ───────────────────────────────────
//
// Four things are worth proving here and they are not the same thing:
//   1. the ARITHMETIC — which items tick, and the count that goes with them
//   2. the DISAPPEARING ACT — complete means complete, not "collapsed", and
//      nothing OPTIONAL is allowed to keep the card open
//   3. that the till is a SUGGESTION — offered, never counted, and withdrawn
//      the moment it is acted on
//   4. that state is DERIVED — every item flips from the facts alone, with
//      nothing stored, which is checked here at the unit level and again
//      against real Postgres in ./setupChecklist.pglite.test.ts
//
// The authority axis gets its own describe block because getting it wrong
// sends a user to a screen that 404s them, which is worse than showing no
// link at all.

const NOTHING: SetupChecklistFacts = {
  phone:                 null,
  addressLine1:          null,
  latitude:              null,
  longitude:             null,
  bankingResolved:       false,
  hasActiveProvider:   false,
  hasActiveTillDevice: false,
  hasTillPin:            false,
};

/**
 * The three REQUIRED things done — the state in which the card must vanish.
 * Note the till is deliberately absent: the whole point of this revision is
 * that the card is finished without one.
 */
const REQUIRED_DONE: SetupChecklistFacts = {
  phone:                 '011 555 0100',
  addressLine1:          '12 Rivonia Road, Sandton',
  latitude:              -26.1076,
  longitude:             28.0567,
  bankingResolved:       true,
  hasActiveProvider:   true,
  hasActiveTillDevice: false,
  hasTillPin:            false,
};

const FULL_RIGHTS: SetupChecklistAuthority = {
  canEditDetails: true,
  canManageTeam:  true,
  canManageTill:  true,
};

const facts = (over: Partial<SetupChecklistFacts> = {}): SetupChecklistFacts =>
  ({ ...NOTHING, ...over });

const build = (
  over: Partial<SetupChecklistFacts> = {},
  auth: SetupChecklistAuthority = FULL_RIGHTS,
) => buildSetupChecklist(facts(over), auth);

const item = (c: ReturnType<typeof build>, key: string) =>
  c.items.find((i) => i.key === key)!;

// ─── A brand-new practice ─────────────────────────────────────────────────

describe('a brand-new practice with nothing set up', () => {
  const c = build();

  it('shows all three required items outstanding, and 0 of 3', () => {
    expect(c.total).toBe(3);
    expect(c.doneCount).toBe(0);
    expect(c.items.every((i) => !i.done)).toBe(true);
  });

  it('is not complete, so the card renders', () => {
    expect(c.complete).toBe(false);
  });

  it('lists banking and the practitioner FIRST — the two that block billing', () => {
    // Order is a product decision, not an accident: the trading-gate
    // conditions cost the practice the ability to trade at all, so they lead.
    expect(c.items.map((i) => i.key)).toEqual(['banking', 'provider', 'details']);
  });

  it('points each item at the exact screen that completes it', () => {
    expect(item(c, 'banking').href).toBe('/practice/details#banking');
    expect(item(c, 'provider').href).toBe('/practice/members');
    expect(item(c, 'details').href).toBe('/practice/details');
  });

  it('gives every item a plain-language reason, not a restatement of its name', () => {
    for (const i of c.items) {
      expect(i.why.length).toBeGreaterThan(20);
      // The reason must not lean on words a practice owner has no reason to
      // know. These are the ones the product's own internals use.
      expect(i.why).not.toMatch(/payout|RLS|gate|provider_id|practice_members|till_pin/i);
    }
  });

  it('says nothing about approval — the trading-gate panel owns that', () => {
    // Approval is a real gate condition, but nobody at the practice can action
    // it and the panel on the same page states it unconditionally. Repeating it
    // here in different words would read as a second, separate problem.
    expect(Object.keys(c)).not.toContain('awaitingApproval');
    expect(c.items.map((i) => i.key)).not.toContain('approval');
    expect(c.total).toBe(3);
  });
});

// ─── Partially complete ───────────────────────────────────────────────────

describe('partially complete — details + banking done, no provider', () => {
  const c = build({
    bankingResolved: true,
    phone:           '021 555 0199',
    addressLine1:    '4 Long Street, Cape Town',
    latitude:        -33.92,
    longitude:       18.42,
  });

  it('ticks exactly the two that are done', () => {
    expect(item(c, 'banking').done).toBe(true);
    expect(item(c, 'details').done).toBe(true);
    expect(item(c, 'provider').done).toBe(false);
  });

  it('counts 2 of 3', () => {
    expect(c.doneCount).toBe(2);
    expect(c.total).toBe(3);
    expect(c.complete).toBe(false);
  });

  it('still offers the remaining action', () => {
    expect(item(c, 'provider').href).toBe('/practice/members');
  });
});

// ─── Fully complete — with and without a till ─────────────────────────────

describe('the required items decide completeness, and nothing else does', () => {
  it('is complete on the three required items alone, with NO till set up', () => {
    // The point of this revision. A practice that bills from one laptop has
    // finished; an item they can never complete would keep the card up forever
    // and break the one promise it makes.
    const c = buildSetupChecklist(REQUIRED_DONE, FULL_RIGHTS);
    expect(c.doneCount).toBe(3);
    expect(c.total).toBe(3);
    expect(c.complete).toBe(true);
    expect(c.items.every((i) => i.done)).toBe(true);
  });

  it('is complete with a till too — the till changes the count either way', () => {
    const withTill = buildSetupChecklist(
      { ...REQUIRED_DONE, hasActiveTillDevice: true, hasTillPin: true },
      FULL_RIGHTS,
    );
    expect(withTill.doneCount).toBe(3);
    expect(withTill.total).toBe(3);
    expect(withTill.complete).toBe(true);
  });

  it('offers no suggestion once complete — nothing optional keeps the card open', () => {
    // Enforced in the derivation as well as the renderer, so the returned value
    // cannot describe a state the product does not have.
    expect(buildSetupChecklist(REQUIRED_DONE, FULL_RIGHTS).suggestion).toBeNull();
  });

  it('the till is not one of the items at all', () => {
    expect(build().items.map((i) => i.key)).not.toContain('till');
  });
});

// ─── The till as a suggestion ─────────────────────────────────────────────

describe('the till is a suggestion, not a requirement', () => {
  it('is offered while the required items are outstanding', () => {
    const s = build().suggestion!;
    expect(s).not.toBeNull();
    expect(s.key).toBe('till');
    expect(s.href).toBe('/practice/pos/devices');
  });

  it('is not counted — offering it changes neither doneCount nor total', () => {
    const c = build();
    expect(c.suggestion).not.toBeNull();
    expect(c.doneCount).toBe(0);
    expect(c.total).toBe(3);
  });

  it('has no done state to be stuck in', () => {
    // The structural reason it can never look "outstanding forever": there is
    // no field for it. A suggestion is offered or withheld, never un-ticked.
    expect(Object.keys(build().suggestion!)).not.toContain('done');
  });

  it('says plainly that it is optional', () => {
    expect(build().suggestion!.eyebrow).toMatch(/optional/i);
  });

  it('encourages on BOTH counts — getting on with it, and not sharing a login', () => {
    const why = build().suggestion!.why;
    // Ease of use: reception is not waiting on the manager.
    expect(why).toMatch(/without waiting for you/i);
    // Security, said without the word: a PIN of their own instead of a login.
    expect(why).toMatch(/PIN/);
    expect(why).toMatch(/login never has to be shared/i);
    // And it is not the old required-item wording.
    expect(why).not.toMatch(/borrowing your login/i);
  });

  it('is withdrawn entirely once the till is genuinely set up — no nag', () => {
    expect(build({ hasActiveTillDevice: true, hasTillPin: true }).suggestion).toBeNull();
  });

  it('needs BOTH halves before it stops — neither alone is usable', () => {
    // A registered till with no PIN cannot be unlocked; a PIN with no till has
    // nothing to unlock. Either half alone still leaves something to suggest.
    expect(build({ hasActiveTillDevice: true, hasTillPin: false }).suggestion).not.toBeNull();
    expect(build({ hasActiveTillDevice: false, hasTillPin: true  }).suggestion).not.toBeNull();
  });

  it('names the missing half when one is already in place', () => {
    expect(build({ hasActiveTillDevice: true, hasTillPin: false }).suggestion!.hint)
      .toMatch(/needs a PIN/i);
    expect(build({ hasActiveTillDevice: false, hasTillPin: true }).suggestion!.hint)
      .toMatch(/register the computer/i);
  });

  it('says nothing extra when neither half is done — the title covers it', () => {
    expect(build().suggestion!.hint).toBeNull();
  });

  it('is withheld from a viewer who could not act on it', () => {
    // Required items fall back to naming who to ask, because those have to get
    // done by somebody. "Ask someone else to do this optional thing" is noise.
    expect(build({}, { ...FULL_RIGHTS, canManageTill: false }).suggestion).toBeNull();
  });
});

// ─── Details: the coordinate case ─────────────────────────────────────────

describe('practice details', () => {
  const COMPLETE_DETAILS = {
    phone:        '031 555 0123',
    addressLine1: '9 Florida Road, Durban',
    latitude:     -29.83,
    longitude:    31.02,
  };

  it('needs phone, street address AND map coordinates', () => {
    expect(item(build(COMPLETE_DETAILS), 'details').done).toBe(true);
    expect(item(build({ ...COMPLETE_DETAILS, phone: null }), 'details').done).toBe(false);
    expect(item(build({ ...COMPLETE_DETAILS, addressLine1: null }), 'details').done).toBe(false);
    expect(item(build({ ...COMPLETE_DETAILS, latitude: null }), 'details').done).toBe(false);
    expect(item(build({ ...COMPLETE_DETAILS, longitude: null }), 'details').done).toBe(false);
  });

  it('treats whitespace as absent', () => {
    expect(item(build({ ...COMPLETE_DETAILS, phone: '   ' }), 'details').done).toBe(false);
    expect(item(build({ ...COMPLETE_DETAILS, addressLine1: '  ' }), 'details').done).toBe(false);
  });

  it('explains the silent case: address text present, but not found on the map', () => {
    // Signup geocodes best-effort and nulls the coordinates on failure, so
    // this practice looks set up and is sorted below every practice with
    // coordinates in patient search. "Add your address" alone would read as
    // already done, so the hint has to say what actually happened.
    const c = item(build({ ...COMPLETE_DETAILS, latitude: null, longitude: null }), 'details');
    expect(c.done).toBe(false);
    expect(c.hint).toMatch(/couldn’t find your address on the map/i);
  });

  it('gives no coordinate hint when there is no address to place yet', () => {
    expect(item(build({ phone: '031 555 0123' }), 'details').hint).toBeNull();
  });
});

// ─── Banking comes from the resolver, not the columns ─────────────────────

describe('banking', () => {
  it('is done whenever banking RESOLVES — including via the brand', () => {
    // bankingResolved is fed by resolvePayoutBanking, the same resolver the
    // trading gate uses, so a branch that settles through its brand's central
    // account is correctly ticked. Reading practices.bank_* directly would
    // nag that practice forever about banking it does not need.
    expect(item(build({ bankingResolved: true }), 'banking').done).toBe(true);
  });

  it('is outstanding when nothing resolves', () => {
    expect(item(build({ bankingResolved: false }), 'banking').done).toBe(false);
  });
});

// ─── Providers, including login-less roster rows ──────────────────────────

describe('the practitioner item', () => {
  it('is satisfied by any active provider, which post-0091 includes roster-only rows', () => {
    // The fact is fed by the same practice_members predicate the trading gate
    // uses (active + role='provider'), and that predicate has never required a
    // login — so a practice whose only practitioner is a roster entry is
    // correctly ticked here, exactly as the gate would tick it.
    expect(item(build({ hasActiveProvider: true  }), 'provider').done).toBe(true);
    expect(item(build({ hasActiveProvider: false }), 'provider').done).toBe(false);
  });

  it('reads the fact directly — no count comparison to get wrong', () => {
    // This item used to be `facts.activeProviderCount > 0` against a field the
    // loader could only ever set to 0 or 1 (it reads with .limit(1)). The name
    // now matches what is measured, so the comparison is gone.
    expect(CODE).toMatch(/done:\s+facts\.hasActiveProvider,/);
    expect(CODE).not.toMatch(/hasActiveProvider\s*[><]/);
  });

  it('the facts the loader produces are named for what they MEASURE', () => {
    // The whole point of the rename. Both reads are .limit(1)-ed, so a field
    // called *Count could only ever hold 0 or 1 — and the brand Practices table
    // read one of them, believed the name, and would have rendered "1 on roster"
    // for a practice with nine.
    expect(CODE).toMatch(/hasActiveProvider:\s+\(providers\?\.length \?\? 0\) > 0/);
    expect(CODE).toMatch(/hasActiveTillDevice:\s+\(devices\?\.length\s+\?\? 0\) > 0/);
    expect(CODE).not.toMatch(/activeProviderCount:|activeTillDeviceCount:/);
    // And the .limit(1) that makes them presence-only is still there, on both.
    expect((CODE.match(/\.limit\(1\)/g) ?? []).length).toBe(2);
  });
});

// ─── Authority — never link somewhere the viewer will be rejected ─────────

describe('action links respect what the viewer is allowed to do', () => {
  it('withholds the two /practice/details links from a non-brand-admin', () => {
    // That page answers a non-brand-admin with notFound(). A link there is a
    // dead end, so the card says who to ask instead.
    const c = build({}, { ...FULL_RIGHTS, canEditDetails: false });
    expect(item(c, 'banking').href).toBeNull();
    expect(item(c, 'details').href).toBeNull();
    // The others are unaffected.
    expect(item(c, 'provider').href).toBe('/practice/members');
  });

  it('withholds the practitioner link from a non-manager', () => {
    const c = build({}, { ...FULL_RIGHTS, canManageTeam: false });
    expect(item(c, 'provider').href).toBeNull();
  });

  it('never changes an item’s DONE state based on who is looking', () => {
    // Authority decides whether there is a link, never whether the thing is
    // done. A practice's setup state is a fact about the practice.
    const noRights: SetupChecklistAuthority = {
      canEditDetails: false, canManageTeam: false, canManageTill: false,
    };
    const withRights    = buildSetupChecklist(REQUIRED_DONE, FULL_RIGHTS);
    const withoutRights = buildSetupChecklist(REQUIRED_DONE, noRights);
    expect(withoutRights.doneCount).toBe(withRights.doneCount);
    expect(withoutRights.complete).toBe(withRights.complete);
  });
});

// ─── Adversarial: the state is derived, not remembered ────────────────────

describe('every item is derived from live facts alone', () => {
  it('flips the moment the underlying fact changes, with nothing written', () => {
    // The same pure function, called twice with different facts and no
    // intervening write of any kind. This is the property a stored
    // onboarding_completed flag could not have.
    const before = build({ bankingResolved: true });
    expect(before.doneCount).toBe(1);

    const afterProvider = build({ bankingResolved: true, hasActiveProvider: true });
    expect(afterProvider.doneCount).toBe(2);

    const afterAddress = build({
      bankingResolved: true, hasActiveProvider: true,
      phone: '011 555 0100', addressLine1: '12 Rivonia Road',
      latitude: -26.1, longitude: 28.05,
    });
    expect(afterAddress.doneCount).toBe(3);
    expect(afterAddress.complete).toBe(true);
  });

  it('un-ticks an item when the fact goes away again', () => {
    // The direction a flag can never handle.
    const set  = build({ hasActiveProvider: true });
    const gone = build({ hasActiveProvider: false });
    expect(item(set,  'provider').done).toBe(true);
    expect(item(gone, 'provider').done).toBe(false);
  });

  it('brings the till suggestion BACK when the last device is revoked', () => {
    // Same property on the optional side: the nudge is derived, so it returns
    // when the thing it was nudging about goes away.
    expect(build({ hasActiveTillDevice: true, hasTillPin: true }).suggestion).toBeNull();
    expect(build({ hasActiveTillDevice: false, hasTillPin: true }).suggestion).not.toBeNull();
  });

  it('is a pure function of its inputs', () => {
    const a = build({ bankingResolved: true });
    const b = build({ bankingResolved: true });
    expect(a).toEqual(b);
  });
});

// ─── loadSetupChecklistFacts — the query shapes ───────────────────────────
//
// A recording stub, not a real database: the real-Postgres proof is in
// ./setupChecklist.pglite.test.ts. What matters here is that the reads are
// SCOPED and FILTERED, because an unfiltered one ticks an item using another
// practice's data or a revoked device.

type Recorded = { table: string; cols: string; filters: Record<string, unknown>; isNull: string[] };

function stubClient(rows: Record<string, unknown[]>, practiceRow: Record<string, unknown> | null) {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const rec: Recorded = { table, cols: '', filters: {}, isNull: [] };
      calls.push(rec);
      const builder = {
        select: (cols: string) => { rec.cols = cols; return builder; },
        eq: (col: string, val: unknown) => { rec.filters[col] = val; return builder; },
        is: (col: string, val: unknown) => {
          if (val === null) rec.isNull.push(col);
          return builder;
        },
        limit: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
        maybeSingle: () => Promise.resolve({ data: practiceRow, error: null }),
      };
      return builder;
    },
  };
  return { client, calls };
}

describe('loadSetupChecklistFacts', () => {
  it('scopes every read to the practice, and excludes revoked till devices', async () => {
    const { client, calls } = stubClient(
      { practice_members: [{ id: 'm1' }], till_devices: [{ id: 'd1' }] },
      {
        phone: '011 555 0100',
        address_line1: '12 Rivonia Road', latitude: -26.1, longitude: 28.05,
        till_pin_hash: 'hashed',
      },
    );

    const f = await loadSetupChecklistFacts(client, 'prac-1', {
      resolveBanking: async () => ({ source: 'branch', banking: {
        bank_name: 'FNB', bank_account_number: '123', branch_code: null,
        account_holder: null, account_type: null,
      } }),
    });

    const members = calls.find((c) => c.table === 'practice_members')!;
    expect(members.filters).toMatchObject({
      practice_id: 'prac-1', active: true, role: 'provider',
    });

    const devices = calls.find((c) => c.table === 'till_devices')!;
    expect(devices.filters).toMatchObject({ practice_id: 'prac-1' });
    // 0088 revokes devices rather than deleting them, so without this filter
    // a practice whose only till was revoked would still be ticked.
    expect(devices.isNull).toContain('revoked_at');

    expect(f.hasActiveProvider).toBe(true);
    expect(f.hasActiveTillDevice).toBe(true);
    expect(f.hasTillPin).toBe(true);
    expect(f.bankingResolved).toBe(true);
  });

  it('does not read practices.status — approval is not this card’s question', () => {
    // Selecting it would be the first step towards a second opinion about
    // whether a practice is approved. The trading gate is the only one.
    const { client, calls } = stubClient({}, {});
    return loadSetupChecklistFacts(client, 'prac-1', {
      resolveBanking: async () => ({ source: 'none' }),
    }).then(() => {
      const practices = calls.find((c) => c.table === 'practices')!;
      expect(practices.cols).not.toMatch(/\bstatus\b/);
    });
  });

  it('resolves banking through the injected resolver and honours source:none', async () => {
    const { client } = stubClient({}, {});
    const f = await loadSetupChecklistFacts(client, 'prac-1', {
      resolveBanking: async () => ({ source: 'none' }),
    });
    expect(f.bankingResolved).toBe(false);
  });

  it('counts brand-resolved banking as present', async () => {
    const { client } = stubClient({}, {});
    const f = await loadSetupChecklistFacts(client, 'prac-1', {
      resolveBanking: async () => ({
        source: 'group', groupId: 'g1',
        banking: {
          bank_name: 'Absa', bank_account_number: '999', branch_code: null,
          account_holder: null, account_type: null,
        },
      }),
    });
    expect(f.bankingResolved).toBe(true);
  });

  it('fails CLOSED when the practice row cannot be read', async () => {
    // Nothing readable must never present as "all set up" — a wrong tick has
    // a practice waiting to be paid into an account they never gave us.
    const { client } = stubClient({}, null);
    const f = await loadSetupChecklistFacts(client, 'prac-1', {
      resolveBanking: async () => ({ source: 'none' }),
    });
    const c = buildSetupChecklist(f, FULL_RIGHTS);
    expect(c.doneCount).toBe(0);
    expect(c.complete).toBe(false);
  });
});
