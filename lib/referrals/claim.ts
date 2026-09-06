// ─── Spending a referral cookie: who gets credited, and who does not ──────
//
// Called once per authenticated request while the referral cookie is present
// (proxy.ts). Everything interesting here is a REFUSAL — the happy path is
// three lines — because an attribution is a claim about where a customer came
// from, and every wrong one is either a credit to the wrong person or a
// credit for a customer who was already ours.
//
// ─── THE FIVE REFUSALS ───────────────────────────────────────────────────
//
//   malformed          the cookie is not code-shaped. Nothing to look up.
//   unknown_code       no live code matches. A typo, or a code that has been
//                      revoked since the link was shared.
//   self_referral      the code belongs to the account presenting it. The
//                      cheapest fraud there is, and the only one worth
//                      naming separately, because it is also what an honest
//                      customer does by accident when testing their own link.
//   already_attributed this account has a referral already. Attribution is
//                      write-once: the FIRST code an account arrives with is
//                      the one that counts, so a second link cannot overwrite
//                      the first person's credit.
//   account_too_old    the account predates the window an invitation lives
//                      for. An existing customer who taps a friend's link is
//                      not a new customer, and crediting one would make the
//                      referral count a measure of how many customers click
//                      links.
//
// All five are TERMINAL: the cookie is spent and deleted. Only a database or
// network failure is retryable, and it is reported as such so the cookie
// survives to the next request — the same posture the invitation claim in
// proxy.ts already takes.
//
// ─── WHY THIS TAKES A STORE RATHER THAN A SUPABASE CLIENT ────────────────
//
// The decisions above are the part worth testing, and testing them through a
// PostgREST client means either a live database or a mock of a fluent builder
// — the second of which tests the mock. The narrow interface below is the
// seam: `supabaseReferralStore` adapts the real client to it in a dozen
// lines, and claim.test.ts drives the logic directly.

import { normaliseReferralCode } from './code';
import { REFERRAL_INVITE_TTL_DAYS } from './vocabulary';

export type ClaimOutcome =
  | 'attributed'
  | 'malformed'
  | 'unknown_code'
  | 'self_referral'
  | 'already_attributed'
  | 'account_too_old'
  | 'transient';

export type ClaimResult = {
  outcome: ClaimOutcome;
  /** Whether the cookie should be dropped. False only for `transient`. */
  terminal: boolean;
  /** The referral row that ended up carrying the attribution, when there is one. */
  referralId?: string;
};

export type ReferralCodeRow = { id: string; owner_id: string };
export type ReferralAccount = { email: string | null; created_at: string | null };

/**
 * The database operations a claim needs. Every one returns `null` for "not
 * found" and THROWS for a failure, so the caller below can tell "nothing
 * matched" from "we could not ask" — conflating those is how a transient
 * outage turns into a permanent wrong answer.
 */
export type ReferralClaimStore = {
  /** A LIVE code (not revoked). */
  findLiveCode(code: string): Promise<ReferralCodeRow | null>;
  /** The account doing the claiming. */
  findAccount(profileId: string): Promise<ReferralAccount | null>;
  /** Any existing attribution for this account, whoever made it. */
  findAttribution(profileId: string): Promise<{ id: string } | null>;
  /**
   * A pending emailed invitation from this referrer to this address, matched
   * so an invited friend lands on the row that was created for them rather
   * than on a second, anonymous one.
   */
  findPendingInviteFor(referrerId: string, email: string): Promise<{ id: string } | null>;
  /** Attach the attribution to an existing invitation. Returns false if it
   *  no longer matched (someone else got there first). */
  attachToInvite(referralId: string, profileId: string, at: string): Promise<boolean>;
  /** Record a fresh link-channel referral. Returns null on a unique-violation
   *  against the write-once attribution index — a race, not an error. */
  createLinkReferral(input: {
    referrerId: string;
    codeId:     string;
    profileId:  string;
    at:         string;
  }): Promise<{ id: string } | null>;
};

export async function claimReferral(
  store: ReferralClaimStore,
  input: { profileId: string; cookieValue: string; now?: Date },
): Promise<ClaimResult> {
  const now  = input.now ?? new Date();
  const code = normaliseReferralCode(input.cookieValue);
  if (!code) return { outcome: 'malformed', terminal: true };

  try {
    const codeRow = await store.findLiveCode(code);
    if (!codeRow) return { outcome: 'unknown_code', terminal: true };

    if (codeRow.owner_id === input.profileId) {
      return { outcome: 'self_referral', terminal: true };
    }

    const existing = await store.findAttribution(input.profileId);
    if (existing) return { outcome: 'already_attributed', terminal: true };

    const account = await store.findAccount(input.profileId);
    // No profile row yet — the trigger has not run, or this is the fraction
    // of a second before it does. NOT terminal: the cookie survives and the
    // next request finds the row. This is the one "not found" that means
    // "ask again", which is why it is handled here rather than folded into
    // account_too_old.
    if (!account) return { outcome: 'transient', terminal: false };

    if (!withinAttributionWindow(account.created_at, now)) {
      return { outcome: 'account_too_old', terminal: true };
    }

    const at    = now.toISOString();
    const email = (account.email ?? '').trim().toLowerCase();

    if (email) {
      const invite = await store.findPendingInviteFor(codeRow.owner_id, email);
      if (invite && await store.attachToInvite(invite.id, input.profileId, at)) {
        return { outcome: 'attributed', terminal: true, referralId: invite.id };
      }
    }

    const created = await store.createLinkReferral({
      referrerId: codeRow.owner_id,
      codeId:     codeRow.id,
      profileId:  input.profileId,
      at,
    });
    // The write-once index refused us: another request attributed this
    // account between our read and our insert. That is the index doing its
    // job, and the correct report is the same one the read would have given.
    if (!created) return { outcome: 'already_attributed', terminal: true };

    return { outcome: 'attributed', terminal: true, referralId: created.id };
  } catch {
    // Deliberately swallowed and reported as retryable. The cookie stays, the
    // next request tries again, and nothing has been written — every write
    // above is a single statement guarded by a unique index.
    return { outcome: 'transient', terminal: false };
  }
}

/**
 * Is this account new enough for a link to plausibly explain it?
 *
 * A missing `created_at` is treated as IN the window. The column is NOT NULL
 * in practice and nullable in the generated types; refusing on a null would
 * mean a type-level shrug silently costing a real referrer their credit,
 * whereas admitting one costs an over-count that an operator can see in the
 * row. Neither is free — this one is visible.
 */
export function withinAttributionWindow(createdAt: string | null, now: Date): boolean {
  if (!createdAt) return true;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return true;
  const ageMs = now.getTime() - created.getTime();
  return ageMs <= REFERRAL_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
}
