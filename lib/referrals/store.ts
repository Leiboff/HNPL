// ─── The PostgREST half of a referral claim ───────────────────────────────
//
// Adapts a service-role Supabase client to `ReferralClaimStore`. It is the
// only file in lib/referrals that knows what a table is called, which is why
// claim.ts can be tested without a database and this file has no decisions in
// it worth testing.
//
// EVERY read distinguishes "no row" from "could not ask": PostgREST reports
// both as a null `data`, with the failure in `error`. Returning null for a
// failure would tell claimReferral that a code does not exist when the truth
// is that we could not look — and claimReferral treats "does not exist" as
// terminal, so the cookie would be thrown away over a blip. So each one
// THROWS on `error`, and the try/catch in claimReferral turns that into the
// retryable outcome.
//
// Service-role only, by construction: `referrals` and `referral_codes` carry
// SELECT policies and no write policies at all (migration 0145), so a session
// client cannot perform any of this.

import type { ReferralClaimStore } from './claim';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServiceClient = any;

/** PostgreSQL unique_violation. The write-once attribution index raises it. */
const UNIQUE_VIOLATION = '23505';

export function supabaseReferralStore(svc: ServiceClient): ReferralClaimStore {
  return {
    async findLiveCode(code) {
      const { data, error } = await svc
        .from('referral_codes')
        .select('id, owner_id')
        .eq('code', code)
        .is('revoked_at', null)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async findAccount(profileId) {
      const { data, error } = await svc
        .from('profiles')
        .select('email, created_at')
        .eq('id', profileId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async findAttribution(profileId) {
      const { data, error } = await svc
        .from('referrals')
        .select('id')
        .eq('referred_profile_id', profileId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async findPendingInviteFor(referrerId, email) {
      const { data, error } = await svc
        .from('referrals')
        .select('id')
        .eq('referrer_id', referrerId)
        .eq('kind', 'patient')
        .eq('status', 'pending')
        .eq('invitee_email', email)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async attachToInvite(referralId, profileId, at) {
      // `.is('referred_profile_id', null)` plus `.select()` is the same
      // read-back-what-you-updated idiom the invitation claim uses: an UPDATE
      // matching no rows is a SUCCESS in PostgREST, so the row count is the
      // only honest signal that this claim, and not a concurrent one, won.
      const { data, error } = await svc
        .from('referrals')
        .update({
          referred_profile_id: profileId,
          status:              'signed_up',
          signed_up_at:        at,
        })
        .eq('id', referralId)
        .eq('status', 'pending')
        .is('referred_profile_id', null)
        .select('id');
      if (error) {
        // The write-once index refusing us is a race we lost, not a fault.
        if (error.code === UNIQUE_VIOLATION) return false;
        throw new Error(error.message);
      }
      return Array.isArray(data) && data.length > 0;
    },

    async createLinkReferral({ referrerId, codeId, profileId, at }) {
      const { data, error } = await svc
        .from('referrals')
        .insert({
          referrer_id:         referrerId,
          code_id:             codeId,
          kind:                'patient',
          channel:             'link',
          status:              'signed_up',
          referred_profile_id: profileId,
          signed_up_at:        at,
        })
        .select('id')
        .single();
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return null;
        throw new Error(error.message);
      }
      return data ?? null;
    },
  };
}
