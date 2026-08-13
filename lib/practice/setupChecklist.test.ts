import { describe, it, expect } from 'vitest';
import {
  buildSetupChecklist,
  loadSetupChecklistFacts,
  type SetupChecklistFacts,
  type SetupChecklistAuthority,
} from './setupChecklist';

// ─── Tests — setup checklist derivation ───────────────────────────────────
//
// Three things are worth proving here and they are not the same thing:
//   1. the ARITHMETIC — which items tick, and the count that goes with them
//   2. the DISAPPEARING ACT — complete means complete, not "collapsed"
//   3. that state is DERIVED — every item flips from the facts alone, with
//      nothing stored, which is checked here at the unit level and again
//      against real Postgres in ./setupChecklist.pglite.test.ts
//
// The authority axis gets its own describe block because getting it wrong
// sends a user to a screen that 404s them, which is worse than showing no
// link at all.

const NOTHING: SetupChecklistFacts = {
  status:                'pending',
  phone:                 null,
  addressLine1:          null,
  latitude:              null,
  longitude:             null,
  bankingResolved:       false,
  activeProviderCount:   0,
  activeTillDeviceCount: 0,
  hasTillPin:            false,
};

/** Everything done, and approved — the state in which the card must vanish. */
const EVERYTHING: SetupChecklistFacts = {
  status:                'approved',
  phone:                 '011 555 0100',
  addressLine1:          '12 Rivonia Road, Sandton',
  latitude:              -26.1076,
  longitude:             28.0567,
  bankingResolved:       true,
  activeProviderCount:   1,
  activeTillDeviceCount: 1,
  hasTillPin:            true,
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

  it('shows all four items outstanding, and 0 of 4', () => {
    expect(c.total).toBe(4);
    expect(c.doneCount).toBe(0);
    expect(c.items.every((i) => !i.done)).toBe(true);
  });

  it('is not complete, so the card renders', () => {
    expect(c.complete).toBe(false);
  });

  it('lists banking and the practitioner FIRST — the two that block billing', () => {
    // Order is a product decision, not an accident: the trading-gate
    // conditions cost the practice the ability to trade at all, so they lead.
    expect(c.items.map((i) => i.key)).toEqual(['banking', 'provider', 'details', 'till']);
  });

  it('points each item at the exact screen that completes it', () => {
    expect(item(c, 'banking').href).toBe('/practice/details#banking');
    expect(item(c, 'provider').href).toBe('/practice/members');
    expect(item(c, 'details').href).toBe('/practice/details');
    expect(item(c, 'till').href).toBe('/practice/pos/devices');
  });

  it('gives every item a plain-language reason, not a restatement of its name', () => {
    for (const i of c.items) {
      expect(i.why.length).toBeGreaterThan(20);
      // The reason must not lean on words a practice owner has no reason to
      // know. These are the ones the product's own internals use.
      expect(i.why).not.toMatch(/payout|RLS|gate|provider_id|practice_members|till_pin/i);
    }
  });

  it('surfaces "we are still checking you over" without making it a tick box', () => {
    // status='pending' is a real trading-gate condition, but no screen at the
    // practice can action it — so it must be stated, and must not be one of
    // the four things they are being asked to do.
    expect(c.awaitingApproval).toBe(true);
    expect(c.items.map((i) => i.key)).not.toContain('approval');
    expect(c.total).toBe(4);
  });
});

// ─── Partially complete ───────────────────────────────────────────────────

describe('partially complete — details + banking done, no till, no provider', () => {
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
    expect(item(c, 'till').done).toBe(false);
  });

  it('counts 2 of 4', () => {
    expect(c.doneCount).toBe(2);
    expect(c.total).toBe(4);
    expect(c.complete).toBe(false);
  });

  it('still offers the two remaining actions', () => {
    expect(item(c, 'provider').href).toBe('/practice/members');
    expect(item(c, 'till').href).toBe('/practice/pos/devices');
  });
});

// ─── Fully complete ───────────────────────────────────────────────────────

describe('fully complete', () => {
  it('reports complete with every item ticked', () => {
    const c = buildSetupChecklist(EVERYTHING, FULL_RIGHTS);
    expect(c.doneCount).toBe(4);
    expect(c.complete).toBe(true);
    expect(c.items.every((i) => i.done)).toBe(true);
  });

  it('is complete even while approval is still pending — the practice has nothing left to do', () => {
    // Approval is not theirs to action. Holding the card open for it would
    // leave a checklist of four ticks on the dashboard indefinitely, which is
    // the clutter the card exists to avoid. The trading-gate panel is what
    // explains the wait.
    const c = buildSetupChecklist({ ...EVERYTHING, status: 'pending' }, FULL_RIGHTS);
    expect(c.complete).toBe(true);
    expect(c.awaitingApproval).toBe(true);
  });
});

// ─── The till: one item, two halves ───────────────────────────────────────

describe('the till is one item covering two pieces of setup', () => {
  it('needs BOTH a device and a PIN — neither half alone is usable', () => {
    expect(item(build({ activeTillDeviceCount: 1, hasTillPin: false }), 'till').done).toBe(false);
    expect(item(build({ activeTillDeviceCount: 0, hasTillPin: true  }), 'till').done).toBe(false);
    expect(item(build({ activeTillDeviceCount: 1, hasTillPin: true  }), 'till').done).toBe(true);
  });

  it('names the missing half so collapsing them hides nothing', () => {
    const needsPin = item(build({ activeTillDeviceCount: 1, hasTillPin: false }), 'till');
    expect(needsPin.hint).toMatch(/needs a PIN/i);

    const needsDevice = item(build({ activeTillDeviceCount: 0, hasTillPin: true }), 'till');
    expect(needsDevice.hint).toMatch(/register the computer/i);
  });

  it('says nothing extra when neither half is done — the title already covers it', () => {
    expect(item(build(), 'till').hint).toBeNull();
  });

  it('drops the hint once the item is done', () => {
    expect(item(build({ activeTillDeviceCount: 1, hasTillPin: true }), 'till').hint).toBeNull();
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
    // The count is fed by the same practice_members predicate the trading
    // gate uses (active + role='provider'), and that predicate has never
    // required a login — so a practice whose only practitioner is a roster
    // entry is correctly ticked here, exactly as the gate would tick it.
    expect(item(build({ activeProviderCount: 1 }), 'provider').done).toBe(true);
    expect(item(build({ activeProviderCount: 3 }), 'provider').done).toBe(true);
    expect(item(build({ activeProviderCount: 0 }), 'provider').done).toBe(false);
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
    expect(item(c, 'till').href).toBe('/practice/pos/devices');
  });

  it('withholds the practitioner link from a non-manager', () => {
    const c = build({}, { ...FULL_RIGHTS, canManageTeam: false });
    expect(item(c, 'provider').href).toBeNull();
  });

  it('withholds the till link from someone who cannot manage the till', () => {
    const c = build({}, { ...FULL_RIGHTS, canManageTill: false });
    expect(item(c, 'till').href).toBeNull();
  });

  it('never changes an item’s DONE state based on who is looking', () => {
    // Authority decides whether there is a link, never whether the thing is
    // done. A practice's setup state is a fact about the practice.
    const noRights: SetupChecklistAuthority = {
      canEditDetails: false, canManageTeam: false, canManageTill: false,
    };
    const withRights    = buildSetupChecklist(EVERYTHING, FULL_RIGHTS);
    const withoutRights = buildSetupChecklist(EVERYTHING, noRights);
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

    const afterProvider = build({ bankingResolved: true, activeProviderCount: 1 });
    expect(afterProvider.doneCount).toBe(2);

    const afterPin = build({
      bankingResolved: true, activeProviderCount: 1,
      activeTillDeviceCount: 1, hasTillPin: true,
    });
    expect(afterPin.doneCount).toBe(3);
  });

  it('un-ticks an item when the fact goes away again', () => {
    // The direction a flag can never handle: a till whose only device was
    // revoked is not set up any more, and the card has to say so.
    const set   = build({ activeTillDeviceCount: 1, hasTillPin: true });
    const gone  = build({ activeTillDeviceCount: 0, hasTillPin: true });
    expect(item(set,  'till').done).toBe(true);
    expect(item(gone, 'till').done).toBe(false);
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

type Recorded = { table: string; filters: Record<string, unknown>; isNull: string[] };

function stubClient(rows: Record<string, unknown[]>, practiceRow: Record<string, unknown> | null) {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const rec: Recorded = { table, filters: {}, isNull: [] };
      calls.push(rec);
      const builder = {
        select: () => builder,
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
        status: 'approved', phone: '011 555 0100',
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

    expect(f.activeProviderCount).toBe(1);
    expect(f.activeTillDeviceCount).toBe(1);
    expect(f.hasTillPin).toBe(true);
    expect(f.bankingResolved).toBe(true);
  });

  it('resolves banking through the injected resolver and honours source:none', async () => {
    const { client } = stubClient({}, { status: 'pending' });
    const f = await loadSetupChecklistFacts(client, 'prac-1', {
      resolveBanking: async () => ({ source: 'none' }),
    });
    expect(f.bankingResolved).toBe(false);
  });

  it('counts brand-resolved banking as present', async () => {
    const { client } = stubClient({}, { status: 'approved' });
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
