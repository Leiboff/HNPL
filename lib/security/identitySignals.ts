// ─── Linking accounts, and deciding what to do about it ───────────────────
//
// Backed by migration 0138. That file carries the design reasoning; this one
// carries the rules and the call sites.
//
// ─── THE SHAPE OF THE DECISION ────────────────────────────────────────────
//
// Three outcomes, and the middle one is where most of the value is:
//
//   allow  nothing unusual.
//   flag   recorded in fraud_decisions for a human to look at. The customer
//          is not impeded and never learns of it.
//   block  refused, with the reason recorded so the customer can be released
//          by name.
//
// A fraud control that can only allow or block is a bad one when you have no
// baseline — and this platform has none: zero completed transactions, so
// every threshold below is a judgement about human behaviour rather than a
// number fitted to data. Flagging is what makes that survivable. When real
// volume exists, the flag rate is the evidence for where the block line
// actually belongs.
//
// ─── WHY THE THRESHOLDS ARE WHERE THEY ARE ────────────────────────────────
//
// Set where legitimate sharing has effectively stopped, not where it starts.
// In this product specifically:
//
//   • A family shares a card. A mother paying for two children's dentistry
//     is the ordinary case. Two or three accounts on one card is normal.
//   • A family shares a browser. Same reasoning, and more so at the lower
//     end of the market this serves.
//   • South African mobile carriers NAT enormously. Tens of thousands of
//     subscribers egress from one address, so a shared IP means close to
//     nothing on its own.
//
// So: IP NEVER blocks, at any count. Device and card block at six or more
// distinct accounts, which is past any family and into a ring.
//
// A VERIFIED PHONE NUMBER IS NOT IN THAT FAMILY OF SIGNALS AT ALL, and
// treating it as one was the mistake in the first version of this file. The
// three above are evidence about a household — circumstantial, gradual,
// worth a threshold. A verified number is a duplicate: OTP proves
// possession, so two accounts that verified the same number are one person
// with one handset. It blocks on the first other account, and the schema
// enforces it directly (migration 0139) rather than waiting for the credit
// step. Email and SA ID belong to that same class and were already
// hard-unique; phone was the only one of the three with no constraint.
//
// Every threshold is overridable by env without a deploy, because the first
// weeks of real traffic will teach us something and waiting for a release to
// act on it is how a limiter ends up switched off entirely.
//
// ─── FAILURE POSTURE ──────────────────────────────────────────────────────
//
// Recording fails OPEN and silent-ish: a signal we could not write is a gap
// in tomorrow's graph, not a reason to refuse a signup today. Evaluation
// fails OPEN too — if the link query errors we cannot justify a refusal, so
// we allow and log loudly. That is a deliberate asymmetry and it is the same
// call lib/security/rateLimit.ts makes for the same reason: a control that
// can take the product down is a control that gets removed.

import crypto from 'crypto';

export type SignalKind = 'device' | 'ip' | 'card' | 'phone';
export type Decision   = 'allow' | 'flag' | 'block';

/** Where the evaluation happened, for the audit row. */
export type Surface = 'signup' | 'credit_claim' | 'card_add';

export type Thresholds = { flagAt: number; blockAt: number | null };

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * How many OTHER accounts sharing a signal is interesting, and how many is
 * refusable. `blockAt: null` means this signal can never block on its own.
 */
export function thresholdsFor(kind: SignalKind): Thresholds {
  switch (kind) {
    case 'ip':
      // Never blocks. See the header on South African carrier NAT — this is
      // the one threshold that is not a tuning choice but a fact about the
      // market, and raising it to a blocking value would refuse suburbs.
      return { flagAt: envInt('FRAUD_IP_FLAG_AT', 5), blockAt: null };
    case 'device':
      return {
        flagAt:  envInt('FRAUD_DEVICE_FLAG_AT', 3),
        blockAt: envInt('FRAUD_DEVICE_BLOCK_AT', 6),
      };
    case 'card':
      return {
        flagAt:  envInt('FRAUD_CARD_FLAG_AT', 3),
        blockAt: envInt('FRAUD_CARD_BLOCK_AT', 6),
      };
    case 'phone':
      // Blocks on ONE other account. Not a tuning choice — a different kind
      // of signal from the other three.
      //
      // A shared browser or a shared card is evidence about a household. A
      // shared VERIFIED number is not evidence of anything, it is a
      // duplicate: OTP proves possession of the handset, so two accounts
      // that both verified it are one person holding one phone. There is no
      // family reading of it the way there is for a mother's card on two
      // children's plans.
      //
      // Email and SA ID are the same class of fact and are already
      // hard-unique in the schema (auth.users.users_email_partial_key and
      // profiles_email_key; profiles_sa_id_lookup_hash_patient_uniq since
      // 0097). Phone was the one of the three with no constraint at all —
      // which is how production reached fifty accounts on one number, forty
      // one of them verified, with nothing to notice it. Migration 0139 is
      // now the primary enforcement, at the moment of verification; this is
      // the backstop that catches an account which got verified before 0139
      // existed and only reaches the credit step now.
      //
      // Note these counts are OTHER accounts, so 1 means "shared with
      // anybody at all". blockAt is not env-overridable for the same reason
      // ip's is not: both are facts about the domain rather than dials.
      return { flagAt: 1, blockAt: 1 };
  }
}

export type LinkCount = { kind: SignalKind; sharedAccounts: number };

export type Evaluation = {
  decision: Decision;
  /** The kind that produced the decision, and the count that did it. */
  rule?:    string;
  detail:   { counts: Record<string, number>; thresholds?: Thresholds };
};

/**
 * Turn link counts into a decision. Pure — no I/O, no clock, no database —
 * so the rules can be tested exhaustively, which for a component that can
 * refuse a paying customer is the minimum bar.
 *
 * The strongest signal wins: any single blocking kind blocks, otherwise any
 * single flagging kind flags. Deliberately NOT a sum or a score. A score
 * would let three innocent signals (shared home IP, shared family device,
 * shared family card — one household) add up to a refusal, which is exactly
 * the household this product exists to serve.
 */
export function evaluateLinks(counts: LinkCount[]): Evaluation {
  const asRecord: Record<string, number> = {};
  for (const c of counts) asRecord[c.kind] = c.sharedAccounts;

  let flagged: { kind: SignalKind; t: Thresholds; n: number } | null = null;

  for (const { kind, sharedAccounts } of counts) {
    const t = thresholdsFor(kind);
    if (t.blockAt !== null && sharedAccounts >= t.blockAt) {
      return {
        decision: 'block',
        rule: `${kind}_shared_by_${sharedAccounts}_accounts`,
        detail: { counts: asRecord, thresholds: t },
      };
    }
    if (sharedAccounts >= t.flagAt && !flagged) flagged = { kind, t, n: sharedAccounts };
  }

  if (flagged) {
    return {
      decision: 'flag',
      rule: `${flagged.kind}_shared_by_${flagged.n}_accounts`,
      detail: { counts: asRecord, thresholds: flagged.t },
    };
  }

  return { decision: 'allow', detail: { counts: asRecord } };
}

// ─── Hashing ──────────────────────────────────────────────────────────────

const HMAC_ENV = 'IDENTITY_SIGNAL_HMAC_KEY';

/**
 * HMAC-SHA256 of a signal value, hex. Returns null when the key is unset
 * rather than throwing.
 *
 * Throwing would match lib/auth/tillDevice.ts, and is wrong here: that
 * pepper protects a credential whose absence must stop the feature, whereas
 * an unset key here must not stop a signup. The caller treats null as "no
 * signal available", logs, and proceeds.
 */
export function hashSignal(kind: SignalKind, raw: string | null | undefined): string | null {
  const key = process.env[HMAC_ENV];
  if (!key) return null;
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  // The kind is inside the HMAC so the same string seen as two different
  // kinds cannot collide — a phone number and a device id that happen to
  // match should not link two accounts.
  return crypto.createHmac('sha256', key).update(`${kind}:${value}`).digest('hex');
}

/** True when signal collection is configured at all. */
export function signalsEnabled(): boolean {
  return Boolean(process.env[HMAC_ENV]);
}

// ─── The device cookie ────────────────────────────────────────────────────

export const DEVICE_COOKIE = 'hnpl_did';
/** Two years. Long enough to be useful, short enough to age out a handset. */
export const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 730;

/** A fresh device id. Random, not derived — see 0138 on why not a fingerprint. */
export function newDeviceId(): string {
  return crypto.randomUUID();
}

/** Accept only our own shape, so a caller cannot supply a chosen id. */
export function isValidDeviceId(value: string | null | undefined): boolean {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

// ─── Recording and evaluating, against the database ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Svc = any;

export type RawSignals = Partial<Record<SignalKind, string | null | undefined>>;

/**
 * Upsert every supplied signal for this account. Never throws.
 *
 * `hits` and `last_seen_at` are advanced on conflict so a returning device
 * is visible as a returning device; `first_seen_at` is left alone, because
 * "this card appeared on a second account three months later" reads very
 * differently from "…within the same hour".
 */
export async function recordSignals(
  svc: Svc,
  userId: string,
  raw: RawSignals,
): Promise<number> {
  if (!signalsEnabled()) {
    console.warn('[fraud] IDENTITY_SIGNAL_HMAC_KEY unset — not recording signals');
    return 0;
  }

  const rows = (Object.entries(raw) as Array<[SignalKind, string | null | undefined]>)
    .map(([kind, value]) => ({ kind, value_hash: hashSignal(kind, value) }))
    .filter((r): r is { kind: SignalKind; value_hash: string } => r.value_hash !== null)
    .map((r) => ({ user_id: userId, kind: r.kind, value_hash: r.value_hash }));

  if (rows.length === 0) return 0;

  try {
    const { error } = await svc.rpc('record_identity_signals', {
      p_user_id: userId,
      p_signals: rows.map((r) => ({ kind: r.kind, value_hash: r.value_hash })),
    });
    if (error) {
      console.error('[fraud] recordSignals failed', { userId, error: error.message });
      return 0;
    }
    return rows.length;
  } catch (err) {
    console.error('[fraud] recordSignals threw', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export type AssessResult = Evaluation & { recorded: boolean };

/**
 * Record this request's signals, then decide.
 *
 * Order matters and is deliberate: the signals go in FIRST, so the account
 * being assessed is part of its own link graph. The alternative — evaluate
 * then record — makes the first account through a shared device invisible to
 * the second, which halves the value of the whole mechanism.
 *
 * A previously-blocked decision that an admin has RELEASED is honoured: the
 * same counts will not re-block that account. Without that, releasing a
 * wrongly-refused customer would last exactly until their next attempt.
 */
export async function assessIdentity(
  svc: Svc,
  userId: string,
  surface: Surface,
  raw: RawSignals,
): Promise<AssessResult> {
  const recorded = (await recordSignals(svc, userId, raw)) > 0;

  try {
    const { data: released } = await svc
      .from('fraud_decisions')
      .select('id')
      .eq('user_id', userId)
      .eq('decision', 'block')
      .not('released_at', 'is', null)
      .limit(1);

    const { data, error } = await svc.rpc('identity_link_counts', { p_user_id: userId });
    if (error) {
      console.error('[fraud] identity_link_counts failed — allowing', {
        userId, surface, error: error.message,
      });
      return { decision: 'allow', detail: { counts: {} }, recorded };
    }

    const counts: LinkCount[] = ((data ?? []) as Array<{ kind: string; shared_accounts: number }>)
      .map((r) => ({ kind: r.kind as SignalKind, sharedAccounts: Number(r.shared_accounts) }));

    const verdict = evaluateLinks(counts);

    if (verdict.decision === 'block' && Array.isArray(released) && released.length > 0) {
      console.warn('[fraud] block suppressed by an admin release', { userId, surface });
      return {
        decision: 'flag',
        rule: `released:${verdict.rule ?? 'unknown'}`,
        detail: verdict.detail,
        recorded,
      };
    }

    if (verdict.decision !== 'allow') {
      const { error: logErr } = await svc.from('fraud_decisions').insert({
        user_id:  userId,
        surface,
        decision: verdict.decision,
        rule:     verdict.rule ?? null,
        detail:   verdict.detail,
      });
      if (logErr) {
        console.error('[fraud] could not record the decision', { userId, error: logErr.message });
      }
      // ALERT so it is greppable next to the money-path alarms.
      console.warn(
        `[fraud] ALERT ${verdict.decision} on ${surface}`,
        { userId, rule: verdict.rule, counts: verdict.detail.counts },
      );
    }

    return { ...verdict, recorded };
  } catch (err) {
    console.error('[fraud] assessIdentity threw — allowing', {
      userId, surface, error: err instanceof Error ? err.message : String(err),
    });
    return { decision: 'allow', detail: { counts: {} }, recorded };
  }
}

/** Copy shown to a refused customer. Deliberately says nothing about why. */
export const FRAUD_BLOCK_MESSAGE =
  'We can\'t continue with this application right now. Please contact support '
  + 'on hello@betternow.co.za and we\'ll help you sort it out.';
