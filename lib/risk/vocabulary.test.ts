import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RISK_BUDGETS,
  RISK_DIMENSIONS,
  RISK_EVENTS,
  RISK_KILL_SWITCHES,
  RISK_ACTION_RANK,
  strongestAction,
} from './vocabulary';
import { RISK_POLICY, budgetsForRpc, dailyBudgetLimit, rulesForRpc } from './policy';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The two halves of the vocabulary, pinned together ──────────────────────
//
// Migration 0142 declares the events, dimensions and budgets in SQL, and this
// module declares them in TypeScript. Two lists is a drift risk, accepted for
// the reason 0134's header gives about rate-limit buckets: the point is that
// the DATABASE refuses a name the application did not declare, which it
// cannot do by reading the application.
//
// So a name added on one side and not the other has to fail HERE, or it goes
// quietly unevaluated on a live surface — which is the worst failure mode
// this whole subsystem has, because it looks exactly like a quiet day.

const MIG_RAW = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0142_fraud_risk_controls.sql'),
  'utf8',
);

// The allow-list functions are surrounded by prose that quotes the very
// names being extracted — the network_class comment lists 'hosting',
// 'proxy', 'residential' and 'unknown', none of which are dimensions. Reading
// the comments as code is the classic version of this test passing for the
// wrong reason, so the prose goes first.
const MIG = stripComments(MIG_RAW, { sql: true });

/** The quoted names inside one `SELECT p_x IN ( … )` allow-list function. */
function sqlAllowList(functionName: string): string[] {
  const start = MIG.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}(`);
  expect(start, `${functionName} is declared in 0142`).toBeGreaterThan(-1);
  const body = MIG.slice(start, MIG.indexOf('$$;', start));
  const inClause = body.slice(body.indexOf('IN ('), body.lastIndexOf(')'));
  return [...inClause.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('risk vocabulary — TypeScript and SQL agree', () => {
  it('declares the same events as risk_known_event', () => {
    expect(sqlAllowList('risk_known_event').sort()).toEqual([...RISK_EVENTS].sort());
  });

  it('declares the same dimensions as risk_known_dimension', () => {
    expect(sqlAllowList('risk_known_dimension').sort()).toEqual([...RISK_DIMENSIONS].sort());
  });

  it('declares the same budgets as risk_known_budget', () => {
    expect(sqlAllowList('risk_known_budget').sort()).toEqual([...RISK_BUDGETS].sort());
  });

  it('seeds every declared kill switch', () => {
    for (const name of RISK_KILL_SWITCHES) {
      expect(MIG).toContain(`('${name}',`);
    }
  });
});

describe('risk policy — every event is covered and internally consistent', () => {
  it('has a policy for every declared event', () => {
    for (const event of RISK_EVENTS) {
      expect(RISK_POLICY[event], `policy for ${event}`).toBeDefined();
    }
  });

  it('only names dimensions the database will accept', () => {
    for (const event of RISK_EVENTS) {
      for (const rule of RISK_POLICY[event].rules) {
        expect(RISK_DIMENSIONS).toContain(rule.dimension);
      }
    }
  });

  it('only names budgets the database will accept', () => {
    for (const event of RISK_EVENTS) {
      for (const spend of RISK_POLICY[event].budgets) {
        expect(RISK_BUDGETS).toContain(spend.budget);
      }
    }
  });

  it('only names kill switches that exist', () => {
    for (const event of RISK_EVENTS) {
      for (const name of RISK_POLICY[event].switches) {
        expect(RISK_KILL_SWITCHES).toContain(name);
      }
    }
  });

  // A rule with neither threshold is a rule that can never fire — it would
  // read as coverage on a review and provide none.
  it('gives every rule at least one threshold', () => {
    for (const event of RISK_EVENTS) {
      for (const rule of RISK_POLICY[event].rules) {
        const has = rule.maxEvents !== undefined || rule.maxAccounts !== undefined;
        expect(has, `${event}/${rule.dimension} has a threshold`).toBe(true);
      }
    }
  });

  // Every threshold above zero, because 0142 turns a zero into "no limit"
  // (NULLIF) rather than into "refuse everything" — so a typo'd zero is a
  // silently disabled rule, not a loud one.
  it('has no zero or negative thresholds', () => {
    for (const event of RISK_EVENTS) {
      for (const rule of RISK_POLICY[event].rules) {
        if (rule.maxEvents !== undefined)   expect(rule.maxEvents).toBeGreaterThan(0);
        if (rule.maxAccounts !== undefined) expect(rule.maxAccounts).toBeGreaterThan(0);
        expect(rule.windowSecs).toBeGreaterThan(0);
        // 0142 clamps windows to 30 days. A longer one would silently
        // shorten, making the policy say one thing and the database do
        // another.
        expect(rule.windowSecs).toBeLessThanOrEqual(2_592_000);
      }
    }
  });

  it('records why every threshold is what it is', () => {
    for (const event of RISK_EVENTS) {
      for (const rule of RISK_POLICY[event].rules) {
        expect(rule.rationale.length, `${event}/${rule.dimension} rationale`).toBeGreaterThan(20);
      }
    }
  });

  // The audit asks for fail-closed behaviour. Every surface here either
  // spends money at a vendor, creates an account, commits credit or releases
  // funds — none of them is a read that should proceed unevaluated.
  it('fails closed on every event', () => {
    for (const event of RISK_EVENTS) {
      expect(RISK_POLICY[event].onUnavailable, `${event} fail posture`).toBe('deny');
    }
  });

  // The audit rules out indiscriminate CAPTCHA. A `friction` action on a
  // surface with no step-up would either mean nothing or invite one to be
  // invented, so the policy must not declare frictions it cannot deliver.
  it('never uses a friction action on a surface with no step-up', () => {
    for (const event of RISK_EVENTS) {
      const policy = RISK_POLICY[event];
      if (policy.stepUps.length > 0) continue;
      for (const rule of policy.rules) {
        expect(rule.action, `${event}/${rule.dimension}`).not.toBe('friction');
      }
    }
  });
});

describe('rulesForRpc / budgetsForRpc — the wire shape', () => {
  it('emits snake_case keys 0142 reads, and omits absent thresholds', () => {
    const rules = rulesForRpc('signup');
    expect(rules.length).toBe(RISK_POLICY.signup.rules.length);
    for (const rule of rules) {
      expect(rule).toHaveProperty('dimension');
      expect(rule).toHaveProperty('window_secs');
      expect(rule).toHaveProperty('action');
      // An absent threshold must be ABSENT, not null: 0142 coalesces a
      // missing key to 0 and then NULLIFs it to "no limit", whereas an
      // explicit null would take the same path by accident rather than by
      // intent. Keeping the key out makes the two agree.
      if (!('max_events' in rule))   expect(rule.max_events).toBeUndefined();
      if (!('max_accounts' in rule)) expect(rule.max_accounts).toBeUndefined();
    }
  });

  it("resolves 'amount' budgets against the transaction value", () => {
    const budgets = budgetsForRpc('plan_acceptance', 4_500);
    const credit = budgets.find((b) => b.budget === 'approved_credit');
    expect(credit?.units).toBe(4_500);
    expect(credit?.limit).toBe(dailyBudgetLimit('approved_credit'));
  });

  it('never spends a negative amount', () => {
    // A refund-shaped or corrupted amount must not CREDIT the day's budget
    // back and let the next request through.
    const budgets = budgetsForRpc('payout_release', -10_000);
    expect(budgets[0].units).toBe(0);
  });

  it('spends a fixed unit for per-call vendor budgets', () => {
    expect(budgetsForRpc('kyc_session', 0)).toEqual([
      { budget: 'kyc', units: 1, limit: dailyBudgetLimit('kyc') },
    ]);
  });
});

describe('dailyBudgetLimit — environment overrides', () => {
  const KEY = 'RISK_DAILY_BUDGET_KYC';
  const original = process.env[KEY];
  const restore = () => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  };

  it('reads a valid override', () => {
    process.env[KEY] = '25';
    expect(dailyBudgetLimit('kyc')).toBe(25);
    restore();
  });

  it('falls back to the default on a malformed override rather than to zero', () => {
    // A typo must not become a platform-wide outage.
    process.env[KEY] = 'five hundred';
    expect(dailyBudgetLimit('kyc')).toBe(500);
    restore();
  });

  it('falls back to the default on a negative override rather than to unlimited', () => {
    process.env[KEY] = '-1';
    expect(dailyBudgetLimit('kyc')).toBe(500);
    restore();
  });
});

describe('action ranking', () => {
  it('orders allow < friction < review < deny', () => {
    expect(RISK_ACTION_RANK.allow).toBeLessThan(RISK_ACTION_RANK.friction);
    expect(RISK_ACTION_RANK.friction).toBeLessThan(RISK_ACTION_RANK.review);
    expect(RISK_ACTION_RANK.review).toBeLessThan(RISK_ACTION_RANK.deny);
  });

  it('lets the strongest action win regardless of argument order', () => {
    expect(strongestAction('allow', 'deny')).toBe('deny');
    expect(strongestAction('deny', 'allow')).toBe('deny');
    expect(strongestAction('friction', 'review')).toBe('review');
  });

  it('agrees with the ranking 0142 uses internally', () => {
    expect(MIG).toContain('{"allow":0,"friction":1,"review":2,"deny":3}');
  });
});
