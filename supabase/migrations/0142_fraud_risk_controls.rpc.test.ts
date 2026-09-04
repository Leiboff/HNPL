// @vitest-environment node
//
// ─── The aggregate fraud controls, against the adversary they exist for ────
//
// Audit 2026-09-03 S-07 asks for a specific verification shape, and this file
// is written to it:
//
//   "Execute multi-account test matrices varying one dimension at a time,
//    distributed-IP cases, concurrent signup/credit requests and provider
//    outages. Assert aggregate thresholds, alert evidence, manual-review
//    transitions and safe fail-closed behavior without locking out normal
//    household/shared-network patterns."
//
// The last clause is the one that makes this hard, and it gets as much space
// here as the attacks do. A control that stops the ring and also stops a
// family sharing a laptop is not a control that ships.
//
// ─── WHAT PGLITE CAN AND CANNOT SHOW, STATED PLAINLY ──────────────────────
//
// pglite is a single connection, so this file cannot run two genuinely
// concurrent transactions — the same limitation 0130's suite documents. It
// does not need to, because the mechanism that defeats interleaving is
// separable and IS testable:
//
//   • THE ADVISORY LOCKS (pg_advisory_xact_lock on every supplied token,
//     taken in sorted order) are what serialise two members of one ring. A
//     single connection cannot observe blocking, so their PRESENCE and their
//     SORTED order are asserted against the migration text, and their
//     observable consequence — that each evaluation counts every evaluation
//     before it, with no window in which two both see the pre-write count —
//     is asserted directly by driving the calls back to back.
//
//   • OBSERVE-THEN-COUNT is the property that makes the lock sufficient: the
//     observation row is written before the rules are evaluated, so the
//     request being judged is inside its own counts. That is asserted on its
//     own, because an off-by-one here is an off-by-one in the attacker's
//     favour on every single rule.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stripComments } from '@/lib/testing/stripComments';

const MIG_RAW = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0142_fraud_risk_controls.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const MIG_CODE = stripComments(MIG_RAW, { sql: true });

// ─── The minimum schema 0142 touches ──────────────────────────────────────
//
// Deliberately minimal and deliberately REAL: the tables the migration's
// functions actually read (plans, payments, payouts for the practice
// posture; admin_audit_log for the review trail), with the columns those
// queries name. A stub that returned canned numbers would test the test.

const SCHEMA = `
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function is_platform_admin() returns boolean language sql stable as $$ select false $$;

  create table profiles (id uuid primary key);
  create table practices (id uuid primary key);
  create table plans (
    id uuid primary key,
    patient_id uuid references profiles(id),
    practice_id uuid references practices(id),
    total_amount numeric(10,2),
    excess_amount numeric(10,2) not null default 0,
    status text,
    created_at timestamptz not null default now());
  create table payments (
    id uuid primary key,
    plan_id uuid references plans(id),
    patient_id uuid references profiles(id),
    instalment_number int,
    amount numeric(10,2),
    status text,
    kind text not null default 'instalment');
  create table payouts (
    id uuid primary key,
    practice_id uuid references practices(id),
    plan_id uuid references plans(id),
    net_amount numeric(10,2),
    created_at timestamptz not null default now());
  create table admin_audit_log (
    id uuid primary key default gen_random_uuid(),
    actor_id uuid not null,
    entity_type text not null check (entity_type in ('practice','customer')),
    entity_id uuid not null,
    action text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now());
`;

const uuid = (n: number) => {
  const h = n.toString(16).padStart(4, '0');
  return `0000${h}-0000-0000-0000-0000000${h}0`;
};

const ADMIN    = uuid(9999);
const PRACTICE = uuid(500);

type Decision = {
  ok: boolean;
  decision: 'allow' | 'friction' | 'review' | 'deny';
  score: number;
  reasons: Array<Record<string, unknown>>;
  event_id: string | null;
  review_id: string | null;
};

let db: PGlite;

async function evaluate(input: {
  event: string;
  accountId?: string | null;
  practiceId?: string | null;
  signals?: Record<string, string>;
  rules?: Array<Record<string, unknown>>;
  budgets?: Array<Record<string, unknown>>;
  switches?: string[];
  amount?: number;
}): Promise<Decision> {
  const { rows } = await db.query<{ d: Decision }>(
    `select evaluate_risk($1, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::numeric) as d`,
    [
      input.event,
      input.accountId ?? null,
      input.practiceId ?? null,
      JSON.stringify(input.signals ?? {}),
      JSON.stringify(input.rules ?? []),
      JSON.stringify(input.budgets ?? []),
      JSON.stringify(input.switches ?? []),
      input.amount ?? 0,
    ],
  );
  return rows[0].d;
}

/** The device rule from the real signup policy: 3 accounts per week. */
const DEVICE_RULE = [
  { dimension: 'device', window_secs: 604800, max_accounts: 3, action: 'review' },
];

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_RAW);
  await db.query('insert into practices (id) values ($1)', [PRACTICE]);
  await db.query('insert into profiles (id) values ($1)', [ADMIN]);
  for (let i = 1; i <= 40; i += 1) {
    await db.query('insert into profiles (id) values ($1)', [uuid(i)]);
  }
});

afterEach(async () => {
  await db.close();
});

// ══════════════════════════════════════════════════════════════════════════
// The matrix: rotate one dimension at a time
// ══════════════════════════════════════════════════════════════════════════
//
// The audit's central claim is that every EXISTING limit is defeated by
// rotating one attribute, and that joining the attributes is what closes it.
// These tests are that claim, executed: rotate accounts and keep the device,
// and the control fires; rotate the device too, and it does not.

describe('one dimension at a time — the ring rotates accounts, keeps the device', () => {
  it('lets three accounts through and holds the fourth', async () => {
    // Three is the honest ceiling: a couple plus a parent on one laptop.
    for (let i = 1; i <= 3; i += 1) {
      const d = await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { device: 'dev-A' }, rules: DEVICE_RULE,
      });
      expect(d.decision, `account ${i}`).toBe('allow');
    }

    const fourth = await evaluate({
      event: 'signup', accountId: uuid(4),
      signals: { device: 'dev-A' }, rules: DEVICE_RULE,
    });
    expect(fourth.decision).toBe('review');
    expect(fourth.reasons[0]).toMatchObject({
      rule: 'device', metric: 'accounts', observed: 4, threshold: 3,
    });
  });

  it('counts the CURRENT request, so the fourth account is refused rather than the fifth', async () => {
    // Observe-then-count. If the observation were written after the rules
    // ran, the fourth account would see three and be allowed, and every
    // threshold in the system would be off by one in the ring's favour.
    for (let i = 1; i <= 3; i += 1) {
      await evaluate({ event: 'signup', accountId: uuid(i), signals: { device: 'dev-A' }, rules: DEVICE_RULE });
    }
    const { rows } = await db.query<{ c: string }>(
      `select count(*) as c from risk_observations where dimension = 'device'`,
    );
    expect(Number(rows[0].c)).toBe(3);
  });

  it('a REFUSED attempt still counts, so hammering the wall does not stay free', async () => {
    for (let i = 1; i <= 4; i += 1) {
      await evaluate({ event: 'signup', accountId: uuid(i), signals: { device: 'dev-A' }, rules: DEVICE_RULE });
    }
    // The fourth was refused. Five more refusals from five more accounts.
    for (let i = 5; i <= 9; i += 1) {
      await evaluate({ event: 'signup', accountId: uuid(i), signals: { device: 'dev-A' }, rules: DEVICE_RULE });
    }
    const last = await evaluate({
      event: 'signup', accountId: uuid(10), signals: { device: 'dev-A' }, rules: DEVICE_RULE,
    });
    // The count kept climbing through every refusal — which is what makes the
    // evidence in the review queue tell the truth about the scale of it.
    expect(last.reasons[0]).toMatchObject({ observed: 10 });
  });

  it('does NOT fire when the ring rotates the device too — that is what the other dimensions are for', async () => {
    for (let i = 1; i <= 8; i += 1) {
      const d = await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { device: `dev-${i}` }, rules: DEVICE_RULE,
      });
      expect(d.decision).toBe('allow');
    }
    // Stated as a test rather than left implicit: one rule is one rule. The
    // real policy keys signup on device AND subnet AND ASN AND network class
    // AND mailbox domain precisely because each alone is escapable.
    const withSubnet = await evaluate({
      event: 'signup', accountId: uuid(9),
      signals: { device: 'dev-9', subnet: 'net-A' },
      rules: [
        ...DEVICE_RULE,
        { dimension: 'subnet', window_secs: 3600, max_accounts: 8, action: 'review' },
      ],
    });
    // Eight distinct devices, one subnet: the subnet rule sees what the
    // device rule cannot.
    expect(withSubnet.decision).toBe('allow'); // 1 account on net-A so far
    for (let i = 10; i <= 18; i += 1) {
      await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { device: `dev-${i}`, subnet: 'net-A' },
        rules: [{ dimension: 'subnet', window_secs: 3600, max_accounts: 8, action: 'review' }],
      });
    }
    const caught = await evaluate({
      event: 'signup', accountId: uuid(19),
      signals: { device: 'dev-19', subnet: 'net-A' },
      rules: [{ dimension: 'subnet', window_secs: 3600, max_accounts: 8, action: 'review' }],
    });
    expect(caught.decision).toBe('review');
    expect(caught.reasons[0]).toMatchObject({ rule: 'subnet', metric: 'accounts' });
  });

  it('the duplicate-identity rule denies at the SECOND account, not the fourth', async () => {
    // One SA ID is one person. This is not a threshold judgement, so the
    // rule is max_accounts 1 and the action is deny rather than review.
    const rule = [{ dimension: 'identity', window_secs: 2592000, max_accounts: 1, action: 'deny' }];
    const first = await evaluate({
      event: 'kyc_session', accountId: uuid(1), signals: { identity: 'id-X' }, rules: rule,
    });
    expect(first.decision).toBe('allow');

    const second = await evaluate({
      event: 'kyc_session', accountId: uuid(2), signals: { identity: 'id-X' }, rules: rule,
    });
    expect(second.decision).toBe('deny');
    expect(second.reasons[0]).toMatchObject({ rule: 'identity', observed: 2, threshold: 1 });
  });

  it('the same account re-presenting its own identity is not a duplicate', async () => {
    // The retry case, and it must not be caught: a patient whose first
    // verification failed on a bad photo presents the same ID again.
    const rule = [{ dimension: 'identity', window_secs: 2592000, max_accounts: 1, action: 'deny' }];
    for (let i = 0; i < 5; i += 1) {
      const d = await evaluate({
        event: 'kyc_session', accountId: uuid(1), signals: { identity: 'id-X' }, rules: rule,
      });
      expect(d.decision, `attempt ${i + 1}`).toBe('allow');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Distributed IPs — the case the audit names, and the case it warns about
// ══════════════════════════════════════════════════════════════════════════

describe('distributed IPs', () => {
  const IP_RULE = [{ dimension: 'ip', window_secs: 3600, max_events: 5, action: 'review' }];
  const CLASS_RULE = [
    { dimension: 'network_class', window_secs: 3600, max_events: 12, action: 'review' },
  ];

  it('a botnet on 30 distinct IPs defeats the per-IP rule', async () => {
    // Stated as a passing test because it is the audit's premise, and a
    // suite that only demonstrates the controls working would be hiding it.
    for (let i = 1; i <= 30; i += 1) {
      const d = await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { ip: `ip-${i}` }, rules: IP_RULE,
      });
      expect(d.decision).toBe('allow');
    }
  });

  it('…and is caught by the shared network-class token', async () => {
    // The same 30 requests, now also carrying the class of network they came
    // from. 'hosting' is ONE token across every address in the world, so the
    // aggregate is visible however widely the addresses are spread.
    for (let i = 1; i <= 12; i += 1) {
      await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { ip: `ip-${i}`, network_class: 'hosting' },
        rules: CLASS_RULE,
      });
    }
    const caught = await evaluate({
      event: 'signup', accountId: uuid(13),
      signals: { ip: 'ip-13', network_class: 'hosting' },
      rules: CLASS_RULE,
    });
    expect(caught.decision).toBe('review');
    expect(caught.reasons[0]).toMatchObject({ rule: 'network_class', observed: 13 });
  });

  it('residential traffic has its own token and is not swept up with hosting', async () => {
    for (let i = 1; i <= 12; i += 1) {
      await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { ip: `ip-${i}`, network_class: 'hosting' },
        rules: CLASS_RULE,
      });
    }
    const home = await evaluate({
      event: 'signup', accountId: uuid(20),
      signals: { ip: 'ip-home', network_class: 'residential' },
      rules: CLASS_RULE,
    });
    expect(home.decision).toBe('allow');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The household. The audit's "without locking out normal patterns"
// ══════════════════════════════════════════════════════════════════════════

describe('normal shared-infrastructure patterns are not locked out', () => {
  it('a family of four on one router, each with their own device, passes', async () => {
    const rules = [
      { dimension: 'device', window_secs: 604800, max_accounts: 3,  action: 'review' },
      { dimension: 'subnet', window_secs: 3600,   max_events:  30,  action: 'review' },
    ];
    for (let i = 1; i <= 4; i += 1) {
      const d = await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { device: `phone-${i}`, subnet: 'home-net' },
        rules,
      });
      expect(d.decision, `family member ${i}`).toBe('allow');
    }
  });

  it('a corporate NAT with 25 employees signing up in an hour passes', async () => {
    const rules = [{ dimension: 'subnet', window_secs: 3600, max_events: 30, action: 'review' }];
    for (let i = 1; i <= 25; i += 1) {
      const d = await evaluate({
        event: 'signup', accountId: uuid(i),
        signals: { subnet: 'office-net', device: `laptop-${i}` },
        rules,
      });
      expect(d.decision, `employee ${i}`).toBe('allow');
    }
  });

  it('one person retrying a declined payment eight times is not treated as card testing', async () => {
    const rules = [
      { dimension: 'card', window_secs: 3600,    max_events: 12, action: 'deny' },
      { dimension: 'card', window_secs: 2592000, max_accounts: 3, action: 'review' },
    ];
    for (let i = 0; i < 8; i += 1) {
      const d = await evaluate({
        event: 'card_payment', accountId: uuid(1),
        signals: { card: 'card-A' }, rules,
      });
      expect(d.decision, `retry ${i + 1}`).toBe('allow');
    }
  });

  it('a couple sharing one card across two accounts passes', async () => {
    const rules = [{ dimension: 'card', window_secs: 2592000, max_accounts: 2, action: 'review' }];
    for (const account of [uuid(1), uuid(2)]) {
      const d = await evaluate({
        event: 'plan_acceptance', accountId: account, signals: { card: 'card-A' }, rules,
      });
      expect(d.decision).toBe('allow');
    }
    const third = await evaluate({
      event: 'plan_acceptance', accountId: uuid(3), signals: { card: 'card-A' }, rules,
    });
    expect(third.decision).toBe('review');
  });

  it('a window that has rolled past forgets — yesterday does not refuse today', async () => {
    for (let i = 1; i <= 4; i += 1) {
      await evaluate({ event: 'signup', accountId: uuid(i), signals: { device: 'dev-A' }, rules: DEVICE_RULE });
    }
    // Age every observation past the rule's window.
    await db.query(`update risk_observations set occurred_at = now() - interval '8 days'`);
    const today = await evaluate({
      event: 'signup', accountId: uuid(5), signals: { device: 'dev-A' }, rules: DEVICE_RULE,
    });
    expect(today.decision).toBe('allow');
  });

  it('a rule whose signal is missing is skipped, not failed', async () => {
    // A first-time visitor with no device cookie, a patient with no card on
    // file. Refusing on absence would deny every new customer.
    const d = await evaluate({
      event: 'plan_acceptance', accountId: uuid(1),
      signals: { ip: 'ip-1' },
      rules: [
        { dimension: 'device', window_secs: 604800, max_accounts: 1, action: 'deny' },
        { dimension: 'card',   window_secs: 604800, max_accounts: 1, action: 'deny' },
      ],
    });
    expect(d.decision).toBe('allow');
    expect(d.reasons).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Concurrency
// ══════════════════════════════════════════════════════════════════════════

describe('concurrent signup and credit requests', () => {
  it('takes an advisory lock on every supplied token, in sorted order', () => {
    // The mechanism that serialises two members of one ring. A single pglite
    // connection cannot observe blocking, so its presence is asserted here
    // and its consequence in the next test.
    expect(MIG_CODE).toContain('pg_advisory_xact_lock');
    // Sorted, because two requests sharing two dimensions in opposite orders
    // would otherwise deadlock — and a deadlocked risk decision is an outage
    // on the money path.
    expect(MIG_CODE).toMatch(/array_agg\(k ORDER BY k\)/);
  });

  it('every evaluation sees the ones before it — no window of stale counts', async () => {
    // Ten acceptances against one card, driven back to back with no gap. If
    // any evaluation could read a count that predated an earlier one, some
    // pair here would both see 1 and both be allowed.
    const rules = [{ dimension: 'card', window_secs: 3600, max_accounts: 1, action: 'deny' }];
    const decisions = [];
    for (let i = 1; i <= 10; i += 1) {
      decisions.push(await evaluate({
        event: 'plan_acceptance', accountId: uuid(i), signals: { card: 'card-A' }, rules,
      }));
    }
    // Exactly one allowed: the first. Everything after it is a duplicate.
    expect(decisions.filter((d) => d.decision === 'allow')).toHaveLength(1);
    expect(decisions[0].decision).toBe('allow');
  });

  it('two callers racing for the last budget unit cannot both spend it', async () => {
    // consume_risk_budget's guard and increment are ONE statement, so the
    // conflict path re-reads the committed total under the row lock the
    // conflict takes.
    const budgets = [{ budget: 'kyc', units: 1, limit: 2 }];
    const a = await evaluate({ event: 'kyc_session', accountId: uuid(1), budgets });
    const b = await evaluate({ event: 'kyc_session', accountId: uuid(2), budgets });
    const c = await evaluate({ event: 'kyc_session', accountId: uuid(3), budgets });
    expect([a.decision, b.decision, c.decision]).toEqual(['allow', 'allow', 'deny']);

    const { rows } = await db.query<{ consumed: string }>(
      `select consumed from risk_budget_usage where budget = 'kyc'`,
    );
    // Two spent, not three. The refused call did not increment.
    expect(Number(rows[0].consumed)).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Budgets
// ══════════════════════════════════════════════════════════════════════════

describe('daily budgets', () => {
  it('denies when the ceiling is reached and names the numbers', async () => {
    const budgets = [{ budget: 'approved_credit', units: 4000, limit: 5000 }];
    const first  = await evaluate({ event: 'plan_acceptance', accountId: uuid(1), budgets, amount: 4000 });
    const second = await evaluate({ event: 'plan_acceptance', accountId: uuid(2), budgets, amount: 4000 });
    expect(first.decision).toBe('allow');
    expect(second.decision).toBe('deny');
    expect(second.reasons[0]).toMatchObject({
      rule: 'budget', budget: 'approved_credit', threshold: 5000,
    });
  });

  it('does not spend the budget on a request the rules already refused', async () => {
    // A denied request never reaches the vendor, so charging it against the
    // vendor's daily allowance would let an attacker exhaust the platform's
    // KYC budget using requests the platform itself rejected.
    const rules = [{ dimension: 'identity', window_secs: 3600, max_accounts: 1, action: 'deny' }];
    const budgets = [{ budget: 'kyc', units: 1, limit: 100 }];

    await evaluate({ event: 'kyc_session', accountId: uuid(1), signals: { identity: 'id-X' }, rules, budgets });
    for (let i = 2; i <= 6; i += 1) {
      const d = await evaluate({
        event: 'kyc_session', accountId: uuid(i), signals: { identity: 'id-X' }, rules, budgets,
      });
      expect(d.decision).toBe('deny');
    }

    const { rows } = await db.query<{ consumed: string }>(
      `select consumed from risk_budget_usage where budget = 'kyc'`,
    );
    expect(Number(rows[0].consumed)).toBe(1);
  });

  it('does not spend the budget on a request held for review either', async () => {
    const rules = [{ dimension: 'device', window_secs: 3600, max_accounts: 1, action: 'review' }];
    const budgets = [{ budget: 'kyc', units: 1, limit: 100 }];
    await evaluate({ event: 'kyc_session', accountId: uuid(1), signals: { device: 'dev-A' }, rules, budgets });
    await evaluate({ event: 'kyc_session', accountId: uuid(2), signals: { device: 'dev-A' }, rules, budgets });

    const { rows } = await db.query<{ consumed: string }>(
      `select consumed from risk_budget_usage where budget = 'kyc'`,
    );
    expect(Number(rows[0].consumed)).toBe(1);
  });

  it('refuses a single spend larger than the whole budget, and leaves nothing behind', async () => {
    // The INSERT branch has no WHERE to guard it, so an oversized first
    // spend of the day lands and has to be undone. Getting this wrong would
    // leave the day's budget permanently over its ceiling.
    const d = await evaluate({
      event: 'plan_acceptance', accountId: uuid(1),
      budgets: [{ budget: 'approved_credit', units: 999_999, limit: 5000 }],
      amount: 999_999,
    });
    expect(d.decision).toBe('deny');
    const { rows } = await db.query<{ consumed: string }>(
      `select consumed from risk_budget_usage where budget = 'approved_credit'`,
    );
    expect(Number(rows[0].consumed)).toBe(0);
  });

  it('warns and does not limit on an undeclared budget name rather than refusing', async () => {
    // A typo at a call site must not become an outage on the money path.
    const d = await evaluate({
      event: 'plan_acceptance', accountId: uuid(1),
      budgets: [{ budget: 'not_a_budget', units: 1, limit: 0 }],
    });
    expect(d.decision).toBe('allow');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Kill switches
// ══════════════════════════════════════════════════════════════════════════

describe('kill switches', () => {
  it('an engaged switch denies immediately and outranks every rule', async () => {
    await db.query(`select set_risk_kill_switch('credit_issuance', true, $1::uuid, 'incident')`, [ADMIN]);
    const d = await evaluate({
      event: 'plan_acceptance', accountId: uuid(1),
      signals: { device: 'dev-A' }, switches: ['credit_issuance'],
    });
    expect(d.decision).toBe('deny');
    expect(d.reasons[0]).toMatchObject({ rule: 'kill_switch', switch: 'credit_issuance' });
  });

  it('a switch only stops the events that name it', async () => {
    // Stopping payouts must not stop a patient paying their instalment —
    // holding merchant money and refusing customer collections are opposite
    // actions and must not share one control.
    await db.query(`select set_risk_kill_switch('payouts', true, $1::uuid, 'incident')`, [ADMIN]);
    const payment = await evaluate({
      event: 'card_payment', accountId: uuid(1), switches: [],
    });
    expect(payment.decision).toBe('allow');
    const payout = await evaluate({
      event: 'payout_release', practiceId: PRACTICE, switches: ['payouts'],
    });
    expect(payout.decision).toBe('deny');
  });

  it('releasing a switch restores the surface', async () => {
    await db.query(`select set_risk_kill_switch('signup', true, $1::uuid, 'incident')`, [ADMIN]);
    expect((await evaluate({ event: 'signup', accountId: uuid(1), switches: ['signup'] })).decision).toBe('deny');
    await db.query(`select set_risk_kill_switch('signup', false, $1::uuid, 'resolved')`, [ADMIN]);
    expect((await evaluate({ event: 'signup', accountId: uuid(2), switches: ['signup'] })).decision).toBe('allow');
  });

  it('refuses an unknown switch name rather than silently creating one', async () => {
    const { rows } = await db.query<{ r: { ok: boolean; error?: string } }>(
      `select set_risk_kill_switch('not_a_switch', true, $1::uuid, 'x') as r`, [ADMIN],
    );
    expect(rows[0].r).toMatchObject({ ok: false, error: 'unknown_switch' });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Manual review: the state transitions
// ══════════════════════════════════════════════════════════════════════════

describe('manual review', () => {
  async function holdAccount(account: string): Promise<Decision> {
    const rules = [{ dimension: 'device', window_secs: 3600, max_accounts: 1, action: 'review' }];
    await evaluate({ event: 'signup', accountId: uuid(1), signals: { device: 'dev-A' }, rules });
    return evaluate({ event: 'signup', accountId: account, signals: { device: 'dev-A' }, rules });
  }

  it('opens exactly one review per (account, event), however many times it fires', async () => {
    const first = await holdAccount(uuid(2));
    expect(first.review_id).toBeTruthy();

    for (let i = 0; i < 20; i += 1) {
      await evaluate({
        event: 'signup', accountId: uuid(2), signals: { device: 'dev-A' },
        rules: [{ dimension: 'device', window_secs: 3600, max_accounts: 1, action: 'review' }],
      });
    }

    const { rows } = await db.query<{ c: string; hit_count: number }>(
      `select count(*)::text as c, max(hit_count) as hit_count from risk_reviews where account_id = $1`,
      [uuid(2)],
    );
    // One queue item with a hit count, not twenty-one items burying it.
    expect(Number(rows[0].c)).toBe(1);
    expect(rows[0].hit_count).toBe(21);
  });

  it('transitions open → in_review → cleared, attributed to the actor', async () => {
    const held = await holdAccount(uuid(2));
    const reviewId = held.review_id!;

    await db.query(`select decide_risk_review($1::uuid, 'in_review', $2::uuid, null, '[]'::jsonb)`, [reviewId, ADMIN]);
    let state = await db.query<{ state: string; decided_by: string | null }>(
      `select state, decided_by from risk_reviews where id = $1`, [reviewId]);
    expect(state.rows[0].state).toBe('in_review');
    // Not yet decided — 'in_review' is "someone is looking", not an outcome.
    expect(state.rows[0].decided_by).toBeNull();

    await db.query(`select decide_risk_review($1::uuid, 'cleared', $2::uuid, 'household', '[]'::jsonb)`, [reviewId, ADMIN]);
    state = await db.query<{ state: string; decided_by: string | null }>(
      `select state, decided_by from risk_reviews where id = $1`, [reviewId]);
    expect(state.rows[0].state).toBe('cleared');
    expect(state.rows[0].decided_by).toBe(ADMIN);
  });

  it('refuses a second decision so the first reviewer\'s attribution survives', async () => {
    const held = await holdAccount(uuid(2));
    await db.query(`select decide_risk_review($1::uuid, 'cleared', $2::uuid, null, '[]'::jsonb)`, [held.review_id, ADMIN]);
    const { rows } = await db.query<{ r: { ok: boolean; error?: string } }>(
      `select decide_risk_review($1::uuid, 'rejected', $2::uuid, null, '[]'::jsonb) as r`,
      [held.review_id, ADMIN],
    );
    expect(rows[0].r).toMatchObject({ ok: false, error: 'already_decided' });
  });

  it('writes the 0048 admin audit trail on every decision', async () => {
    const held = await holdAccount(uuid(2));
    await db.query(`select decide_risk_review($1::uuid, 'rejected', $2::uuid, 'ring', '[]'::jsonb)`, [held.review_id, ADMIN]);
    const { rows } = await db.query<{ action: string; entity_type: string }>(
      `select action, entity_type from admin_audit_log where actor_id = $1`, [ADMIN]);
    expect(rows[0]).toMatchObject({ action: 'risk_review_rejected', entity_type: 'customer' });
  });

  it('a clearance does NOT erase the history behind it', async () => {
    // A cleared account whose device later appears on nine more accounts must
    // still be countable. Forgetting because a human said "fine on Tuesday"
    // hands a ring a clean slate for the price of one support ticket.
    const held = await holdAccount(uuid(2));
    await db.query(`select decide_risk_review($1::uuid, 'cleared', $2::uuid, null, '[]'::jsonb)`, [held.review_id, ADMIN]);
    const { rows } = await db.query<{ c: string }>(
      `select count(*)::text as c from risk_observations where dimension = 'device'`);
    expect(Number(rows[0].c)).toBe(2);
  });

  it('turns a rejection into standing blocks that refuse the next request', async () => {
    const held = await holdAccount(uuid(2));
    await db.query(
      `select decide_risk_review($1::uuid, 'rejected', $2::uuid, 'ring', $3::jsonb)`,
      [held.review_id, ADMIN, JSON.stringify([
        { dimension: 'device', token: 'dev-A', action: 'deny', reason: 'confirmed ring' },
      ])],
    );

    // A different event, a different account, no velocity rule at all: the
    // block is what refuses, and it does so everywhere the token appears.
    const later = await evaluate({
      event: 'plan_acceptance', accountId: uuid(7), signals: { device: 'dev-A' },
    });
    expect(later.decision).toBe('deny');
    expect(later.reasons[0]).toMatchObject({ rule: 'block', dimension: 'device', reason: 'confirmed ring' });
  });

  it('ignores a block on an undeclared dimension rather than storing a control that does nothing', async () => {
    const held = await holdAccount(uuid(2));
    await db.query(
      `select decide_risk_review($1::uuid, 'rejected', $2::uuid, null, $3::jsonb)`,
      [held.review_id, ADMIN, JSON.stringify([
        { dimension: 'not_a_dimension', token: 'x', action: 'deny' },
      ])],
    );
    const { rows } = await db.query<{ c: string }>(`select count(*)::text as c from risk_blocks`);
    expect(Number(rows[0].c)).toBe(0);
  });

  it('downgrades an unattachable review to friction rather than parking a decision nobody can action', async () => {
    // An anonymous surface with no account and no practice. A review row
    // needs a subject; without one the honest answer is friction plus an
    // alert, not a queue item that can never be cleared.
    const rules = [{ dimension: 'device', window_secs: 3600, max_events: 1, action: 'review' }];
    const first = await evaluate({ event: 'signup', signals: { device: 'dev-A' }, rules });
    expect(first.decision).toBe('allow');

    const d = await evaluate({ event: 'signup', signals: { device: 'dev-A' }, rules });
    expect(d.decision).toBe('friction');
    expect(d.review_id).toBeNull();
    expect(d.reasons.some((r) => r.rule === 'review_unattachable')).toBe(true);
  });

  it('a block expires and stops refusing', async () => {
    const held = await holdAccount(uuid(2));
    await db.query(
      `select decide_risk_review($1::uuid, 'rejected', $2::uuid, null, $3::jsonb)`,
      [held.review_id, ADMIN, JSON.stringify([
        { dimension: 'device', token: 'dev-A', action: 'deny', reason: 'temporary', ttl_secs: 3600 },
      ])],
    );
    expect((await evaluate({ event: 'signup', accountId: uuid(8), signals: { device: 'dev-A' } })).decision).toBe('deny');

    await db.query(`update risk_blocks set expires_at = now() - interval '1 minute'`);
    expect((await evaluate({ event: 'signup', accountId: uuid(9), signals: { device: 'dev-A' } })).decision).toBe('allow');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Alert evidence
// ══════════════════════════════════════════════════════════════════════════

describe('alert evidence', () => {
  it('records every non-allow decision with its reasons', async () => {
    await evaluate({ event: 'signup', accountId: uuid(1), signals: { device: 'dev-A' }, rules: DEVICE_RULE });
    for (let i = 2; i <= 5; i += 1) {
      await evaluate({ event: 'signup', accountId: uuid(i), signals: { device: 'dev-A' }, rules: DEVICE_RULE });
    }
    const { rows } = await db.query<{ decision: string; reasons: unknown[]; score: number }>(
      `select decision, reasons, score from risk_events order by occurred_at`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.decision).not.toBe('allow');
      expect(Array.isArray(row.reasons)).toBe(true);
      expect(row.reasons.length).toBeGreaterThan(0);
      expect(row.score).toBeGreaterThan(0);
    }
  });

  it('does not record allow decisions — a log that is 99.9% "allow" is unread', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await evaluate({ event: 'signup', accountId: uuid(i), signals: { device: 'dev-A' }, rules: DEVICE_RULE });
    }
    const { rows } = await db.query<{ c: string }>(`select count(*)::text as c from risk_events`);
    expect(Number(rows[0].c)).toBe(0);
  });

  it('the strongest triggered action wins when several rules fire at once', async () => {
    await evaluate({ event: 'kyc_session', accountId: uuid(1), signals: { identity: 'id-X', device: 'dev-A' } });
    const d = await evaluate({
      event: 'kyc_session', accountId: uuid(2),
      signals: { identity: 'id-X', device: 'dev-A' },
      rules: [
        { dimension: 'device',   window_secs: 3600, max_accounts: 1, action: 'review' },
        { dimension: 'identity', window_secs: 3600, max_accounts: 1, action: 'deny'   },
      ],
    });
    expect(d.decision).toBe('deny');
    // Both reasons survive: a reviewer needs the whole picture, not just the
    // rule that happened to be strongest.
    expect(d.reasons).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Fail-safe behaviour of the function itself
// ══════════════════════════════════════════════════════════════════════════

describe('unknown names and malformed rules', () => {
  it('allows and warns on an undeclared EVENT rather than refusing a live surface', async () => {
    const d = await evaluate({
      event: 'not_an_event', accountId: uuid(1),
      signals: { device: 'dev-A' }, rules: DEVICE_RULE,
    });
    expect(d.decision).toBe('allow');
    expect(d.reasons[0]).toMatchObject({ rule: 'unknown_event' });
    // Nothing recorded under a name nobody reviews.
    const { rows } = await db.query<{ c: string }>(`select count(*)::text as c from risk_observations`);
    expect(Number(rows[0].c)).toBe(0);
  });

  it('drops an undeclared DIMENSION and evaluates the rest', async () => {
    const d = await evaluate({
      event: 'signup', accountId: uuid(1),
      signals: { device: 'dev-A', made_up: 'x' },
      rules: DEVICE_RULE,
    });
    expect(d.decision).toBe('allow');
    const { rows } = await db.query<{ dimension: string }>(
      `select dimension from risk_observations`);
    expect(rows.map((r) => r.dimension)).toEqual(['device']);
  });

  it('clamps an absurd window rather than throwing', async () => {
    // A limiter that throws on a typo takes down the surface it guards.
    const d = await evaluate({
      event: 'signup', accountId: uuid(1), signals: { device: 'dev-A' },
      rules: [{ dimension: 'device', window_secs: 999_999_999, max_accounts: 1, action: 'review' }],
    });
    expect(d.decision).toBe('allow');
  });

  it('treats a zero threshold as "no limit" rather than "refuse everything"', async () => {
    const d = await evaluate({
      event: 'signup', accountId: uuid(1), signals: { device: 'dev-A' },
      rules: [{ dimension: 'device', window_secs: 3600, max_accounts: 0, action: 'deny' }],
    });
    expect(d.decision).toBe('allow');
  });

  it('falls back to review on an unrecognised rule action', async () => {
    await evaluate({ event: 'signup', accountId: uuid(1), signals: { device: 'dev-A' } });
    const d = await evaluate({
      event: 'signup', accountId: uuid(2), signals: { device: 'dev-A' },
      rules: [{ dimension: 'device', window_secs: 3600, max_accounts: 1, action: 'obliterate' }],
    });
    expect(d.decision).toBe('review');
  });

  it('ignores an empty-string token rather than clustering every empty signal together', async () => {
    // Two unrelated accounts whose device cookie failed to resolve must not
    // be linked to each other by the emptiness they share.
    await evaluate({ event: 'signup', accountId: uuid(1), signals: { device: '' }, rules: DEVICE_RULE });
    await evaluate({ event: 'signup', accountId: uuid(2), signals: { device: '' }, rules: DEVICE_RULE });
    const { rows } = await db.query<{ c: string }>(`select count(*)::text as c from risk_observations`);
    expect(Number(rows[0].c)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The merchant side: exposure and the payout circuit breaker
// ══════════════════════════════════════════════════════════════════════════

describe('practice_risk_posture', () => {
  async function seedPlan(opts: {
    id: number; patient: number; ageDays: number;
    total: number; status: string; firstCollected: boolean;
  }) {
    await db.query(
      `insert into plans (id, patient_id, practice_id, total_amount, status, created_at)
       values ($1, $2, $3, $4, $5, now() - make_interval(days => $6))`,
      [uuid(opts.id), uuid(opts.patient), PRACTICE, opts.total, opts.status, opts.ageDays],
    );
    await db.query(
      `insert into payments (id, plan_id, patient_id, instalment_number, amount, status, kind)
       values ($1, $2, $3, 1, $4, $5, 'instalment')`,
      [uuid(opts.id + 1000), uuid(opts.id), uuid(opts.patient), opts.total / 2,
       opts.firstCollected ? 'collected' : 'failed'],
    );
    await db.query(
      `insert into payments (id, plan_id, patient_id, instalment_number, amount, status, kind)
       values ($1, $2, $3, 2, $4, 'scheduled', 'instalment')`,
      [uuid(opts.id + 2000), uuid(opts.id), uuid(opts.patient), opts.total / 2],
    );
  }

  it('sums open exposure across live plans only', async () => {
    await seedPlan({ id: 1, patient: 1, ageDays: 1, total: 4000, status: 'active', firstCollected: true });
    await seedPlan({ id: 2, patient: 2, ageDays: 1, total: 2000, status: 'completed', firstCollected: true });

    const { rows } = await db.query<{ p: Record<string, number> }>(
      `select practice_risk_posture($1::uuid, 7) as p`, [PRACTICE]);
    // The active plan's uncollected instalment 2 only. The completed plan is
    // not exposure, and the collected instalment 1 is not either.
    expect(Number(rows[0].p.open_exposure)).toBe(2000);
  });

  it('reports the first-payment rate, which is the sharpest merchant signal', async () => {
    for (let i = 1; i <= 4; i += 1) {
      await seedPlan({ id: i, patient: i, ageDays: 1, total: 1000, status: 'active', firstCollected: i === 1 });
    }
    const { rows } = await db.query<{ p: Record<string, number> }>(
      `select practice_risk_posture($1::uuid, 7) as p`, [PRACTICE]);
    expect(Number(rows[0].p.first_payment_rate)).toBeCloseTo(0.25, 4);
    expect(Number(rows[0].p.plans_in_window)).toBe(4);
  });

  it('returns a NULL rate rather than a perfect one when there is nothing to divide', async () => {
    // A brand-new practice must not read as flawless, and must not read as
    // failing either.
    const { rows } = await db.query<{ p: Record<string, unknown> }>(
      `select practice_risk_posture($1::uuid, 7) as p`, [PRACTICE]);
    expect(rows[0].p.first_payment_rate).toBeNull();
  });

  it('counts customers who are new to the PLATFORM, not merely new here', async () => {
    // A ring's value is in fresh identities. A practice receiving twenty of
    // them in a week is the signal regardless of where else they have been.
    await db.query(
      `insert into plans (id, patient_id, practice_id, total_amount, status, created_at)
       values ($1, $2, $3, 1000, 'active', now() - interval '90 days')`,
      [uuid(90), uuid(1), PRACTICE],
    );
    await seedPlan({ id: 1, patient: 1, ageDays: 1, total: 1000, status: 'active', firstCollected: true });
    await seedPlan({ id: 2, patient: 2, ageDays: 1, total: 1000, status: 'active', firstCollected: true });

    const { rows } = await db.query<{ p: Record<string, number> }>(
      `select practice_risk_posture($1::uuid, 7) as p`, [PRACTICE]);
    // Patient 1 existed before the window; only patient 2 is new.
    expect(Number(rows[0].p.new_customers)).toBe(1);
  });
});

describe('trip_practice_circuit_breaker', () => {
  it('writes a block that every practice-carrying evaluation then enforces', async () => {
    await db.query(
      `select trip_practice_circuit_breaker($1::uuid, 'first_payment_rate 0.1 < 0.6', 'deny', 604800, null)`,
      [PRACTICE],
    );

    // Payout release, plan acceptance and counter sessions all carry the
    // practice, so all three are held — and none of them knows a breaker
    // exists.
    for (const event of ['payout_release', 'plan_acceptance', 'counter_session']) {
      const d = await evaluate({
        event, practiceId: PRACTICE, accountId: uuid(1),
        signals: { practice: PRACTICE },
      });
      expect(d.decision, event).toBe('deny');
    }
  });

  it('opens one review for the practice and bumps it on a re-trip', async () => {
    await db.query(`select trip_practice_circuit_breaker($1::uuid, 'a', 'review', 3600, null)`, [PRACTICE]);
    await db.query(`select trip_practice_circuit_breaker($1::uuid, 'b', 'review', 3600, null)`, [PRACTICE]);
    const { rows } = await db.query<{ c: string; hit_count: number }>(
      `select count(*)::text as c, max(hit_count) as hit_count from risk_reviews where practice_id = $1`,
      [PRACTICE],
    );
    expect(Number(rows[0].c)).toBe(1);
    expect(rows[0].hit_count).toBe(2);
  });

  it('never shortens an existing hold, and never converts an indefinite one', async () => {
    // A reviewer's indefinite block must survive a routine re-trip, or the
    // breaker becomes a way to time-limit a human's decision.
    await db.query(
      `insert into risk_blocks (dimension, token, action, reason, expires_at)
       values ('practice', $1, 'deny', 'reviewer', null)`, [PRACTICE]);
    await db.query(`select trip_practice_circuit_breaker($1::uuid, 'routine', 'review', 3600, null)`, [PRACTICE]);
    const { rows } = await db.query<{ expires_at: string | null }>(
      `select expires_at from risk_blocks where token = $1`, [PRACTICE]);
    expect(rows[0].expires_at).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Retention
// ══════════════════════════════════════════════════════════════════════════

describe('POPIA retention', () => {
  it('deletes observations past 90 days and decisions past 180, and keeps reviews', async () => {
    const rules = [{ dimension: 'device', window_secs: 3600, max_accounts: 1, action: 'review' }];
    await evaluate({ event: 'signup', accountId: uuid(1), signals: { device: 'dev-A' }, rules });
    await evaluate({ event: 'signup', accountId: uuid(2), signals: { device: 'dev-A' }, rules });

    await db.query(`update risk_observations set occurred_at = now() - interval '120 days'`);
    await db.query(`update risk_events      set occurred_at = now() - interval '200 days'`);

    const { rows } = await db.query<{ p: Record<string, number> }>(`select prune_risk_data(90, 180, 400) as p`);
    expect(Number(rows[0].p.observations)).toBe(2);
    expect(Number(rows[0].p.events)).toBe(1);

    // Reviews are decision records about people; deleting them on a timer
    // would destroy the trail that makes those decisions accountable.
    const reviews = await db.query<{ c: string }>(`select count(*)::text as c from risk_reviews`);
    expect(Number(reviews.rows[0].c)).toBe(1);
  });

  it('keeps observations inside the retention window', async () => {
    await evaluate({ event: 'signup', accountId: uuid(1), signals: { device: 'dev-A' } });
    await db.query(`update risk_observations set occurred_at = now() - interval '30 days'`);
    const { rows } = await db.query<{ p: Record<string, number> }>(`select prune_risk_data(90, 180, 400) as p`);
    expect(Number(rows[0].p.observations)).toBe(0);
  });

  it('removes expired blocks', async () => {
    await db.query(
      `insert into risk_blocks (dimension, token, action, reason, expires_at)
       values ('device', 'dev-A', 'deny', 'x', now() - interval '1 day')`);
    const { rows } = await db.query<{ p: Record<string, number> }>(`select prune_risk_data(90, 180, 400) as p`);
    expect(Number(rows[0].p.blocks)).toBe(1);
  });

  it('never stores a raw identifier — the store holds only what the caller tokenised', async () => {
    // The privacy invariant, asserted structurally: the function has no way
    // to obtain a raw value, because the only thing it is given is the token.
    // What this pins is that it does not DERIVE one — no lookup back into
    // profiles, no join to a table that holds the plaintext.
    const body = MIG_CODE.slice(
      MIG_CODE.indexOf('CREATE OR REPLACE FUNCTION evaluate_risk('),
      MIG_CODE.indexOf('CREATE OR REPLACE FUNCTION practice_risk_posture('),
    );
    expect(body).not.toMatch(/\bFROM\s+profiles\b/i);
    expect(body).not.toMatch(/\bsa_id\b/i);
    expect(body).not.toMatch(/\bphone_verifications\b/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Lockdown
// ══════════════════════════════════════════════════════════════════════════

describe('privileges and RLS', () => {
  it('enables RLS on every table it creates', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relname in ('risk_observations','risk_events','risk_reviews',
                          'risk_budget_usage','risk_kill_switches','risk_blocks')`,
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it('gives the correlation store no policies at all', async () => {
    // A correlation graph readable by the account it describes is a map of
    // how to evade it. Same lockdown as phone_verifications and
    // rate_limit_hits.
    const { rows } = await db.query<{ c: string }>(
      `select count(*)::text as c from pg_policies where tablename = 'risk_observations'`,
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it('gives risk_reviews a read policy but no write policy', async () => {
    // Reviews are decided only through decide_risk_review, which stamps the
    // actor. A reviewer clearing a row with a direct UPDATE would leave no
    // record of who cleared it.
    const { rows } = await db.query<{ cmd: string }>(
      `select cmd from pg_policies where tablename = 'risk_reviews'`,
    );
    expect(rows.map((r) => r.cmd)).toEqual(['SELECT']);
  });

  it('revokes every function from PUBLIC', async () => {
    for (const fn of [
      'consume_risk_budget', 'evaluate_risk', 'practice_risk_posture',
      'trip_practice_circuit_breaker', 'decide_risk_review',
      'set_risk_kill_switch', 'prune_risk_data',
    ]) {
      expect(MIG_CODE, fn).toContain(`REVOKE ALL ON FUNCTION ${fn}(`);
    }
  });

  it('grants nothing to anon or authenticated', async () => {
    // The rate limiter's own history (0125, A-11) is the argument: a function
    // reachable by the internet with caller-supplied parameters is a
    // primitive, whatever it was written to do. This one reports how many
    // accounts share a token and spends the platform's daily budgets.
    expect(MIG_CODE).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]{0,200}TO[^;]*\banon\b/);
    expect(MIG_CODE).not.toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]{0,200}TO[^;]*\bauthenticated\b/);
  });
});
