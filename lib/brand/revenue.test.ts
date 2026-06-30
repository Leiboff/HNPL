import { describe, it, expect } from 'vitest';
import {
  computeRevenue,
  isActiveForRevenue,
  type RevenuePlan,
  type RevenuePractice,
  type RevenueProvider,
} from './revenue';

// ─── Tests — brand revenue aggregation ─────────────────────────────────
//
// Pins the active-only-revenue contract for the brand-admin
// dashboard. Specifically asserts the bug-fix versus the previous
// behaviour (which counted pending_acceptance toward gross): only
// plans in the activated lifecycle slice (active + completed) count.
// Plus gross⇄net, filter-by-practice, filter-by-doctor, AND combiner.

function plan(over: Partial<RevenuePlan> = {}): RevenuePlan {
  return {
    id:           'plan-' + Math.random().toString(36).slice(2, 8),
    practice_id:  'pA',
    provider_id:  'dr1',
    total_amount: 3000,
    status:       'active',
    ...over,
  };
}

const PRACTICES: RevenuePractice[] = [
  { id: 'pA', name: 'Sandton Rooms',  fee_percent: 6 },
  { id: 'pB', name: 'Rosebank Rooms', fee_percent: 10 },
];

const PROVIDERS: RevenueProvider[] = [
  { id: 'dr1', fullName: 'Dr A' },
  { id: 'dr2', fullName: 'Dr B' },
];

// ─── isActiveForRevenue ────────────────────────────────────────────────

describe('isActiveForRevenue — the bug fix', () => {
  it('includes "active"', () => { expect(isActiveForRevenue('active')).toBe(true); });
  it('includes "completed"', () => { expect(isActiveForRevenue('completed')).toBe(true); });

  // These are the load-bearing exclusions — the previous dashboard
  // counted pending_acceptance into gross, inflating the number.
  it('EXCLUDES "pending_acceptance"', () => { expect(isActiveForRevenue('pending_acceptance')).toBe(false); });
  it('EXCLUDES "pending_first_payment"', () => { expect(isActiveForRevenue('pending_first_payment')).toBe(false); });
  it('EXCLUDES "defaulted"', () => { expect(isActiveForRevenue('defaulted')).toBe(false); });
  it('EXCLUDES "cancelled"', () => { expect(isActiveForRevenue('cancelled')).toBe(false); });
  it('EXCLUDES "declined"', () => { expect(isActiveForRevenue('declined')).toBe(false); });
});

// ─── computeRevenue — totals ────────────────────────────────────────────

describe('computeRevenue — active-only totals', () => {
  it('a single R3,000 active plan contributes gross=3000, regardless of how much has been collected', () => {
    const r = computeRevenue([plan({ total_amount: 3000 })], PRACTICES, PROVIDERS);
    expect(r.totalCount).toBe(1);
    expect(r.totalGross).toBe(3000);
  });

  it('a non-active-for-revenue plan (pending_acceptance) is dropped entirely', () => {
    const r = computeRevenue(
      [
        plan({ id: 'p1', status: 'active',             total_amount: 3000 }),
        plan({ id: 'p2', status: 'pending_acceptance', total_amount: 999  }),
      ],
      PRACTICES, PROVIDERS,
    );
    expect(r.totalCount).toBe(1);
    expect(r.totalGross).toBe(3000);
  });

  it('completed plans count (activation already happened)', () => {
    const r = computeRevenue(
      [
        plan({ id: 'p1', status: 'active',    total_amount: 2000 }),
        plan({ id: 'p2', status: 'completed', total_amount: 1500 }),
      ],
      PRACTICES, PROVIDERS,
    );
    expect(r.totalCount).toBe(2);
    expect(r.totalGross).toBe(3500);
  });

  it('defaulted, cancelled, declined, pending_* all drop', () => {
    const dead = ['pending_acceptance', 'pending_first_payment', 'defaulted', 'cancelled', 'declined'];
    const r = computeRevenue(
      dead.map((status, i) => plan({ id: 'd' + i, status, total_amount: 1000 })),
      PRACTICES, PROVIDERS,
    );
    expect(r.totalCount).toBe(0);
    expect(r.totalGross).toBe(0);
    expect(r.totalNet).toBe(0);
  });
});

// ─── computeRevenue — gross vs net ─────────────────────────────────────

describe('computeRevenue — gross vs net using each practice\'s fee_percent', () => {
  it('one R3,000 plan at 6% → gross 3000, net 2820', () => {
    const r = computeRevenue(
      [plan({ practice_id: 'pA', total_amount: 3000 })],
      PRACTICES, PROVIDERS,
    );
    expect(r.totalGross).toBe(3000);
    expect(r.totalNet).toBe(2820);   // 3000 - (3000 * 6%) = 3000 - 180
  });

  it('per-practice fee_percent is respected — same gross at 10% gives a different net', () => {
    const r = computeRevenue(
      [
        plan({ id: 'a', practice_id: 'pA', total_amount: 1000 }), // 6% → net 940
        plan({ id: 'b', practice_id: 'pB', total_amount: 1000 }), // 10% → net 900
      ],
      PRACTICES, PROVIDERS,
    );
    expect(r.totalGross).toBe(2000);
    expect(r.totalNet).toBe(1840); // 940 + 900
    const a = r.byPractice.find((x) => x.id === 'pA')!;
    const b = r.byPractice.find((x) => x.id === 'pB')!;
    expect(a.net).toBe(940);
    expect(b.net).toBe(900);
  });

  it('a plan whose practice is missing from the lookup defaults fee_percent to 0 (no silent inflation)', () => {
    // Safety property: if the practices array doesn't include the
    // plan's practice (e.g. a brand-admin who lost access to a
    // branch mid-query), the function MUST NOT invent a fee — it
    // shows gross = net for that plan. The dashboard then
    // (correctly) shows the worst-case picture for the brand.
    const r = computeRevenue(
      [plan({ practice_id: 'pUNKNOWN', total_amount: 1000 })],
      PRACTICES, PROVIDERS,
    );
    expect(r.totalGross).toBe(1000);
    expect(r.totalNet).toBe(1000);
  });
});

// ─── computeRevenue — filters ──────────────────────────────────────────

describe('computeRevenue — filters', () => {
  const plans: RevenuePlan[] = [
    plan({ id: 'p1', practice_id: 'pA', provider_id: 'dr1', total_amount: 1000 }),
    plan({ id: 'p2', practice_id: 'pA', provider_id: 'dr2', total_amount: 2000 }),
    plan({ id: 'p3', practice_id: 'pB', provider_id: 'dr1', total_amount: 4000 }),
    plan({ id: 'p4', practice_id: 'pB', provider_id: 'dr2', total_amount: 8000 }),
  ];

  it('practiceId filter narrows to that branch only', () => {
    const r = computeRevenue(plans, PRACTICES, PROVIDERS, { practiceId: 'pA' });
    expect(r.totalCount).toBe(2);
    expect(r.totalGross).toBe(3000);
    expect(r.byPractice.map((x) => x.id)).toEqual(['pA']);
  });

  it('providerId filter narrows to that doctor only (across branches)', () => {
    const r = computeRevenue(plans, PRACTICES, PROVIDERS, { providerId: 'dr1' });
    expect(r.totalCount).toBe(2);
    expect(r.totalGross).toBe(5000);    // 1000 (pA) + 4000 (pB)
    expect(r.byProvider.map((x) => x.id)).toEqual(['dr1']);
  });

  it('combined filters AND together (one doctor at one practice)', () => {
    const r = computeRevenue(plans, PRACTICES, PROVIDERS, { practiceId: 'pB', providerId: 'dr2' });
    expect(r.totalCount).toBe(1);
    expect(r.totalGross).toBe(8000);
  });

  it('filter on a non-active-for-revenue plan still excludes it', () => {
    const withDeadInBranch = [
      ...plans,
      plan({ id: 'p5', practice_id: 'pA', provider_id: 'dr1', total_amount: 999, status: 'defaulted' }),
    ];
    const r = computeRevenue(withDeadInBranch, PRACTICES, PROVIDERS, { practiceId: 'pA', providerId: 'dr1' });
    expect(r.totalCount).toBe(1);    // p1 only — p5 (defaulted) dropped
    expect(r.totalGross).toBe(1000);
  });
});

// ─── computeRevenue — breakdown shape ──────────────────────────────────

describe('computeRevenue — breakdown sorts by gross descending', () => {
  it('byPractice and byProvider are sorted descending by gross', () => {
    const r = computeRevenue(
      [
        plan({ id: 'small', practice_id: 'pA', provider_id: 'dr1', total_amount: 1000 }),
        plan({ id: 'big',   practice_id: 'pB', provider_id: 'dr2', total_amount: 9000 }),
      ],
      PRACTICES, PROVIDERS,
    );
    expect(r.byPractice[0].id).toBe('pB');
    expect(r.byPractice[1].id).toBe('pA');
    expect(r.byProvider[0].id).toBe('dr2');
    expect(r.byProvider[1].id).toBe('dr1');
  });

  it('a plan with a null provider_id is counted in the totals but not in byProvider', () => {
    // The bill-creation flow allows provider_id to be null in some
    // historical states; the dashboard should still total the
    // gross/net correctly even though that plan can't be attributed.
    const r = computeRevenue(
      [
        plan({ id: 'p1', practice_id: 'pA', provider_id: null, total_amount: 1000 }),
      ],
      PRACTICES, PROVIDERS,
    );
    expect(r.totalCount).toBe(1);
    expect(r.totalGross).toBe(1000);
    expect(r.byProvider).toEqual([]);
    expect(r.byPractice).toHaveLength(1);
  });
});

// ─── No-collection-progress guarantee ──────────────────────────────────

describe('RevenueSummary shape — no patient-collection / instalment fields', () => {
  // The brief: "Do NOT show patient collection progress / future-
  // instalment status anywhere on this dashboard."
  // The pure helper is the data-shape contract; if a future change
  // introduces a "collected_so_far" or "remaining" field on the row
  // type, this test will catch it via the keys check below.
  it('RevenueRow exposes only { id, label, count, gross, net } — no collection-progress fields', () => {
    const r = computeRevenue([plan({ total_amount: 1000 })], PRACTICES, PROVIDERS);
    const keys = Object.keys(r.byPractice[0]).sort();
    expect(keys).toEqual(['count', 'gross', 'id', 'label', 'net']);
  });
});
