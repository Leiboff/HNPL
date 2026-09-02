import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  thresholdsFor,
  evaluateLinks,
  hashSignal,
  signalsEnabled,
  isValidDeviceId,
  newDeviceId,
  recordSignals,
  assessIdentity,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE,
  type LinkCount,
  type SignalKind,
} from './identitySignals';

// ─── Tests for the identity-link rules ────────────────────────────────────
//
// `evaluateLinks` can refuse a paying customer, which puts it in a different
// class from most of this codebase: a false positive here is a person turned
// away at a dentist's front desk with no explanation. So it gets exhaustive
// coverage rather than representative coverage, and several of the cases
// below exist purely to pin behaviour that would be tempting to "improve"
// later — particularly that this is NOT a score.
//
// The two properties that must never regress:
//
//   1. IP alone never blocks, at any count. South African carriers NAT tens
//      of thousands of subscribers behind one address; a blocking IP rule
//      refuses suburbs, not rings.
//   2. Signals do not add up. Three weak signals stay weak. One household —
//      shared home IP, shared family device, shared family card — is the
//      customer this product is for, and a scoring model refuses them.

const K: SignalKind[] = ['device', 'ip', 'card', 'phone'];
const links = (o: Partial<Record<SignalKind, number>>): LinkCount[] =>
  (Object.entries(o) as Array<[SignalKind, number]>)
    .map(([kind, sharedAccounts]) => ({ kind, sharedAccounts }));

beforeEach(() => { vi.unstubAllEnvs(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────

describe('thresholdsFor', () => {
  it('gives every kind a flag threshold', () => {
    for (const kind of K) expect(thresholdsFor(kind).flagAt).toBeGreaterThan(0);
  });

  it('IP has no block threshold at all — the carrier-NAT rule', () => {
    expect(thresholdsFor('ip').blockAt).toBeNull();
  });

  it('the household signals block strictly above where they flag', () => {
    // If blockAt <= flagAt the flag tier is unreachable and the whole
    // "watch before you refuse" posture collapses into a bare block. True
    // of device and card, which are evidence about a household. NOT true of
    // phone, which is a duplicate rather than evidence — see below.
    for (const kind of ['device', 'card'] as const) {
      const t = thresholdsFor(kind);
      expect(t.blockAt).not.toBeNull();
      expect(t.blockAt!).toBeGreaterThan(t.flagAt);
    }
  });

  it('a verified phone blocks on the FIRST other account', () => {
    // People do not share cell numbers. OTP proves possession of the
    // handset, so two accounts that verified the same number are one person
    // — there is no household reading of it the way there is for a mother's
    // card on two children's plans.
    expect(thresholdsFor('phone')).toEqual({ flagAt: 1, blockAt: 1 });
  });

  it('phone is stricter than card, not merely tighter', () => {
    expect(thresholdsFor('phone').blockAt!).toBeLessThan(thresholdsFor('card').blockAt!);
  });

  it('is overridable by env for the household signals', () => {
    vi.stubEnv('FRAUD_CARD_BLOCK_AT', '9');
    expect(thresholdsFor('card').blockAt).toBe(9);
    vi.stubEnv('FRAUD_DEVICE_FLAG_AT', '4');
    expect(thresholdsFor('device').flagAt).toBe(4);
  });

  it('ignores nonsense env values rather than disabling itself', () => {
    // A typo in a Vercel env var must not silently become "block at NaN",
    // which compares false against everything and turns the rule off.
    for (const bad of ['', 'abc', '0', '-3']) {
      vi.stubEnv('FRAUD_CARD_BLOCK_AT', bad);
      expect(thresholdsFor('card').blockAt).toBe(6);
    }
  });

  it('no env override can loosen phone or give IP a block threshold', () => {
    // The two thresholds that are facts about the domain rather than dials:
    // an IP that blocks refuses suburbs, and a phone that does not block
    // permits the duplicate account this whole mechanism exists to stop.
    vi.stubEnv('FRAUD_IP_BLOCK_AT', '3');
    expect(thresholdsFor('ip').blockAt).toBeNull();

    for (const loose of ['4', '99', '0']) {
      vi.stubEnv('FRAUD_PHONE_BLOCK_AT', loose);
      vi.stubEnv('FRAUD_PHONE_FLAG_AT',  loose);
      expect(thresholdsFor('phone')).toEqual({ flagAt: 1, blockAt: 1 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('evaluateLinks — the boundaries', () => {
  it('allows an account with no links at all', () => {
    expect(evaluateLinks([]).decision).toBe('allow');
  });

  it('allows an account whose every count is zero', () => {
    expect(evaluateLinks(links({ device: 0, ip: 0, card: 0, phone: 0 })).decision).toBe('allow');
  });

  it.each(K)('%s allows one below its flag threshold', (kind) => {
    const { flagAt } = thresholdsFor(kind);
    expect(evaluateLinks(links({ [kind]: flagAt - 1 })).decision).toBe('allow');
  });

  it.each(['device', 'card', 'ip'] as const)(
    '%s flags exactly at its flag threshold', (kind) => {
      expect(evaluateLinks(links({ [kind]: thresholdsFor(kind).flagAt })).decision).toBe('flag');
    });

  it.each(['device', 'card'] as const)(
    '%s flags one below its block threshold and blocks exactly at it', (kind) => {
      const { blockAt } = thresholdsFor(kind);
      expect(evaluateLinks(links({ [kind]: blockAt! - 1 })).decision).toBe('flag');
      expect(evaluateLinks(links({ [kind]: blockAt! })).decision).toBe('block');
    });

  it('phone never merely flags — it is allow at zero and block at one', () => {
    expect(evaluateLinks(links({ phone: 0 })).decision).toBe('allow');
    for (const n of [1, 2, 5, 40]) {
      expect(evaluateLinks(links({ phone: n })).decision).toBe('block');
    }
  });

  it('IP never blocks, however extreme the count', () => {
    // 40 000 accounts behind one Vodacom egress is not a hypothetical.
    for (const n of [5, 50, 500, 40_000]) {
      expect(evaluateLinks(links({ ip: n })).decision).toBe('flag');
    }
  });
});

describe('evaluateLinks — signals do not add up', () => {
  it('one household on one IP, one device and one card is still allowed', () => {
    // Mother, father, two children: two other accounts on each signal. Every
    // count is below every flag threshold and must stay there. A scoring
    // model would total six and refuse the exact customer this product
    // exists to serve.
    const verdict = evaluateLinks(links({ ip: 3, device: 2, card: 2 }));
    expect(verdict.decision).toBe('allow');
  });

  it('three separate flag-level signals flag once, and never escalate to a block', () => {
    const verdict = evaluateLinks(links({
      ip:     thresholdsFor('ip').flagAt,
      device: thresholdsFor('device').flagAt,
      card:   thresholdsFor('card').flagAt,
    }));
    expect(verdict.decision).toBe('flag');
  });

  it('a single blocking signal blocks even when everything else is quiet', () => {
    const verdict = evaluateLinks(links({ ip: 0, device: 0, card: thresholdsFor('card').blockAt! }));
    expect(verdict.decision).toBe('block');
    expect(verdict.rule).toMatch(/^card_shared_by_\d+_accounts$/);
  });

  it('the blocking kind wins the rule name even when it is listed last', () => {
    // Order of the RPC's rows must not decide the outcome.
    const verdict = evaluateLinks([
      { kind: 'ip',   sharedAccounts: 99 },
      { kind: 'card', sharedAccounts: thresholdsFor('card').blockAt! },
    ]);
    expect(verdict.decision).toBe('block');
    expect(verdict.rule).toContain('card');
  });
});

describe('evaluateLinks — what the reviewer sees', () => {
  it('carries every count, including the ones that did not fire', () => {
    const verdict = evaluateLinks(links({ ip: 7, device: 1 }));
    expect(verdict.detail.counts).toEqual({ ip: 7, device: 1 });
  });

  it('names the kind and the count in the rule, so it reads without a lookup', () => {
    const verdict = evaluateLinks(links({ phone: thresholdsFor('phone').blockAt! }));
    expect(verdict.rule).toBe(`phone_shared_by_${thresholdsFor('phone').blockAt}_accounts`);
  });

  it('records no rule on an allow', () => {
    expect(evaluateLinks(links({ device: 1 })).rule).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('hashSignal', () => {
  beforeEach(() => { vi.stubEnv('IDENTITY_SIGNAL_HMAC_KEY', 'test-pepper'); });

  it('produces the 64-char lowercase hex the column CHECK requires', () => {
    expect(hashSignal('device', 'abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable, so the same device links across sessions', () => {
    expect(hashSignal('device', 'abc')).toBe(hashSignal('device', 'abc'));
  });

  it('normalises case and surrounding whitespace', () => {
    expect(hashSignal('card', '  PEACH:VISA:4242:1229 ')).toBe(hashSignal('card', 'peach:visa:4242:1229'));
  });

  it('separates the kinds, so a phone and a device id cannot collide', () => {
    // Without the kind inside the HMAC, a value that happened to appear as
    // two different kinds would link two unrelated accounts.
    expect(hashSignal('phone', 'same')).not.toBe(hashSignal('device', 'same'));
  });

  it('changes completely when the pepper changes', () => {
    const a = hashSignal('ip', '196.0.0.1');
    vi.stubEnv('IDENTITY_SIGNAL_HMAC_KEY', 'other-pepper');
    expect(hashSignal('ip', '196.0.0.1')).not.toBe(a);
  });

  it('returns null rather than hashing nothing', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(hashSignal('ip', empty)).toBeNull();
    }
  });

  it('returns null when the pepper is unset, and does NOT throw', () => {
    // Deliberately unlike lib/auth/tillDevice.ts, which throws. That pepper
    // protects a credential whose absence must stop the feature; an unset
    // key here must not stop a signup.
    vi.stubEnv('IDENTITY_SIGNAL_HMAC_KEY', '');
    expect(hashSignal('device', 'abc')).toBeNull();
    expect(signalsEnabled()).toBe(false);
  });
});

describe('the device cookie', () => {
  it('mints ids that its own validator accepts', () => {
    for (let i = 0; i < 20; i++) expect(isValidDeviceId(newDeviceId())).toBe(true);
  });

  it('rejects anything a caller might supply instead', () => {
    // The cookie is attacker-controlled input. Accepting a chosen id would
    // let one person pin many accounts to one device id on purpose — or,
    // worse, pin their account to somebody else's id.
    for (const bad of [
      '', 'abc', null, undefined, 'not-a-uuid-at-all',
      '0000AAAA-0000-0000-0000-00000000AAAA',      // uppercase
      '0000aaaa-0000-0000-0000-00000000aaaa ',     // trailing space
      "0000aaaa-0000-0000-0000-00000000aaaa'; --", // sql-ish
    ]) {
      expect(isValidDeviceId(bad as string)).toBe(false);
    }
  });

  it('is named and aged consistently with a two-year device lifetime', () => {
    expect(DEVICE_COOKIE).toBe('hnpl_did');
    expect(DEVICE_COOKIE_MAX_AGE).toBe(60 * 60 * 24 * 730);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The database-facing half. Stubbed client — the SQL itself is proved in
// supabase/migrations/0138_identity_signals.rls.test.ts against real
// PostgreSQL. What matters here is the failure posture.
// ─────────────────────────────────────────────────────────────────────────

type Call = { fn: string; args: Record<string, unknown> };

function stubClient(opts: {
  rpc?: Record<string, { data?: unknown; error?: { message: string } | null }>;
  rpcThrows?: boolean;
  released?: unknown[];
} = {}) {
  const calls: Call[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  const svc = {
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (opts.rpcThrows) throw new Error('connection reset');
      return opts.rpc?.[fn] ?? { data: null, error: null };
    },
    from(_table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, not: () => chain,
        limit: async () => ({ data: opts.released ?? [], error: null }),
        insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; },
      };
      return chain;
    },
  };
  return { svc, calls, inserted };
}

const USER = '0000aaaa-0000-0000-0000-00000000aaaa';

describe('recordSignals', () => {
  beforeEach(() => { vi.stubEnv('IDENTITY_SIGNAL_HMAC_KEY', 'test-pepper'); });

  it('hashes every supplied signal and sends them in one call', async () => {
    const { svc, calls } = stubClient();
    const n = await recordSignals(svc, USER, { device: 'd1', ip: '1.2.3.4', card: 'peach:visa:4242:1229' });
    expect(n).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('record_identity_signals');

    const sent = calls[0].args.p_signals as Array<{ kind: string; value_hash: string }>;
    expect(sent.map((s) => s.kind).sort()).toEqual(['card', 'device', 'ip']);
    // Raw values must never leave the process.
    const json = JSON.stringify(sent);
    expect(json).not.toContain('1.2.3.4');
    expect(json).not.toContain('4242');
    expect(sent.every((s) => /^[0-9a-f]{64}$/.test(s.value_hash))).toBe(true);
  });

  it('drops signals that were not supplied instead of sending empty hashes', async () => {
    const { svc, calls } = stubClient();
    const n = await recordSignals(svc, USER, { device: 'd1', ip: null, card: undefined, phone: '  ' });
    expect(n).toBe(1);
    expect((calls[0].args.p_signals as unknown[])).toHaveLength(1);
  });

  it('makes no call at all when nothing survived hashing', async () => {
    const { svc, calls } = stubClient();
    expect(await recordSignals(svc, USER, { ip: null })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does nothing but warn when the pepper is unset', async () => {
    vi.stubEnv('IDENTITY_SIGNAL_HMAC_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc, calls } = stubClient();
    expect(await recordSignals(svc, USER, { device: 'd1' })).toBe(0);
    expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it('fails open on a database error — a lost signal is not a lost signup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { svc } = stubClient({ rpc: { record_identity_signals: { error: { message: 'boom' } } } });
    await expect(recordSignals(svc, USER, { device: 'd1' })).resolves.toBe(0);
  });

  it('fails open when the client throws outright', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { svc } = stubClient({ rpcThrows: true });
    await expect(recordSignals(svc, USER, { device: 'd1' })).resolves.toBe(0);
  });
});

describe('assessIdentity', () => {
  beforeEach(() => { vi.stubEnv('IDENTITY_SIGNAL_HMAC_KEY', 'test-pepper'); });

  const withCounts = (counts: Array<{ kind: string; shared_accounts: number }>, released: unknown[] = []) =>
    stubClient({ rpc: { identity_link_counts: { data: counts, error: null } }, released });

  it('records BEFORE it evaluates, so the account is in its own link graph', async () => {
    // Evaluate-then-record would make the first account through a shared
    // device invisible to the second, halving the value of the mechanism.
    const { svc, calls } = withCounts([]);
    await assessIdentity(svc, USER, 'signup', { device: 'd1' });
    expect(calls.map((c) => c.fn)).toEqual(['record_identity_signals', 'identity_link_counts']);
  });

  it('allows and logs nothing when there are no links', async () => {
    const { svc, inserted } = withCounts([]);
    const res = await assessIdentity(svc, USER, 'signup', { device: 'd1' });
    expect(res.decision).toBe('allow');
    expect(inserted).toHaveLength(0);   // allows are deliberately not recorded
  });

  it('records a flag with the rule and counts behind it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc, inserted } = withCounts([{ kind: 'device', shared_accounts: thresholdsFor('device').flagAt }]);
    const res = await assessIdentity(svc, USER, 'signup', { device: 'd1' });
    expect(res.decision).toBe('flag');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ user_id: USER, surface: 'signup', decision: 'flag' });
    expect(inserted[0].rule).toContain('device');
  });

  it('ALERTs on a block, greppable next to the money-path alarms', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc } = withCounts([{ kind: 'card', shared_accounts: thresholdsFor('card').blockAt! }]);
    const res = await assessIdentity(svc, USER, 'card_add', { card: 'c1' });
    expect(res.decision).toBe('block');
    expect(warn.mock.calls.flat().join(' ')).toContain('ALERT');
  });

  it('honours an admin release — the same counts do not re-block', async () => {
    // Without this, releasing a wrongly-refused customer would last exactly
    // until their next attempt, which is worse than having no release at all
    // because the admin believes they fixed it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc } = withCounts(
      [{ kind: 'card', shared_accounts: thresholdsFor('card').blockAt! }],
      [{ id: 'a-released-block' }],
    );
    const res = await assessIdentity(svc, USER, 'signup', { card: 'c1' });
    expect(res.decision).toBe('flag');          // still watched, not refused
    expect(res.rule).toMatch(/^released:/);     // and legible as a release
  });

  it('a release does not suppress a flag into an allow', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc } = withCounts(
      [{ kind: 'ip', shared_accounts: 99 }],
      [{ id: 'a-released-block' }],
    );
    expect((await assessIdentity(svc, USER, 'signup', { ip: '1.2.3.4' })).decision).toBe('flag');
  });

  it('allows when the link query fails — we cannot justify a refusal we could not compute', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { svc, inserted } = stubClient({
      rpc: { identity_link_counts: { data: null, error: { message: 'permission denied' } } },
    });
    const res = await assessIdentity(svc, USER, 'signup', { device: 'd1' });
    expect(res.decision).toBe('allow');
    expect(inserted).toHaveLength(0);
  });

  it('allows when the client throws outright', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { svc } = stubClient({ rpcThrows: true });
    expect((await assessIdentity(svc, USER, 'signup', { device: 'd1' })).decision).toBe('allow');
  });

  it('coerces the RPC’s numeric shape rather than trusting it', async () => {
    // PostgREST can hand back a bigint as a string. `'6' >= 6` is true in JS
    // by coercion, but `'6' >= '10'` is false — a silent off-by-a-lot at
    // exactly the counts that matter.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blockAt = thresholdsFor('card').blockAt!;
    const { svc } = stubClient({
      rpc: { identity_link_counts: { data: [{ kind: 'card', shared_accounts: String(blockAt + 10) }], error: null } },
    });
    const res = await assessIdentity(svc, USER, 'signup', { card: 'c1' });
    expect(res.decision).toBe('block');
    expect(res.detail.counts.card).toBe(blockAt + 10);
  });
});
