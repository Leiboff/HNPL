import { decryptId } from '@/lib/idEncryption';

// ─── Claiming an unbound counter-session plan ────────────────────────────
//
// THE PROBLEM THIS EXISTS FOR
//   A bill issued at the till has no owner. issueCounterSession captures an
//   SA ID number and nothing else — no email, no account — so plans.patient_id
//   stays NULL until somebody authenticates and claims it. That deferral is
//   structural: there is genuinely nobody to bind at issuance.
//
//   But every "is this yours?" test in the checkout flow is written as
//   `plan.patient_id === user.id`, which an unbound plan can never satisfy. So
//   a RETURNING patient — one who already has a BetterNow account — scanning a
//   till QR was bounced no matter which door they came through:
//
//     signed in already  -> /checkout/[token] compared NULL to their id and
//                           sent them to /patient?reason=invitation_not_yours,
//                           which is not merely unhelpful but false: the bill
//                           IS theirs.
//     signed out         -> the anonymous form ran, they typed their email,
//                           and initiateCheckout's discriminator returned
//                           reject-organic-collision -> /login -> a confirm
//                           page that cannot see an unbound plan -> stranded.
//
//   An email-issued bill never hits this, because the practice types an email
//   and createBill stamps plans.patient_id at creation when an account already
//   exists. The till cannot do that: an SA ID is not an account.
//
// WHY BINDING NEEDS A PROOF, NOT JUST A LOGIN
//   Binding on "somebody is logged in and holds this token" would let any
//   authenticated patient standing at the counter attach someone else's bill
//   to their own account. The proof used here is the one the till already
//   captured: the SA ID NUMBER. The practice typed the patient's ID at
//   issuance; the account carries its own on profiles.sa_id_number. If the two
//   match, the person logging in IS the person the practice billed.
//
//   That is a STRICTER test than the anonymous path applies today — an
//   anonymous first-timer's SA ID is written FROM the session with nothing to
//   compare it against, because no profile exists yet.
//
//   Both values are AES-256-GCM ciphertexts with random IVs, so they are
//   compared decrypted. Never compare the stored strings: two encryptions of
//   the same ID differ.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//   It does not create accounts, does not sign anyone in, does not touch the
//   till's device auth, and cannot move a plan from one owner to another —
//   the UPDATE carries `.is('patient_id', null)`, so a plan that already has
//   an owner is untouchable through this path even if the caller's checks were
//   somehow wrong.

/** Loose structural type — see lib/practice/tillActivity.ts for the reason. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClaimSupabase = any;

export type ClaimOutcome =
  /** Bound to this user by this call. */
  | { claimed: true;  reason: 'claimed' }
  /** Bound by a concurrent caller between the read and the write. */
  | { claimed: true;  reason: 'raced_same_user' }
  /** Not bound, and the caller must NOT be routed into the plan. */
  | { claimed: false; reason: 'already_bound' | 'no_profile_id' | 'id_mismatch' | 'decrypt_failed' | 'write_failed' };

export type ClaimInput = {
  /** Service-role client. The patient's own client cannot see an unbound plan. */
  svc:            ClaimSupabase;
  planId:         string;
  /** Bound alongside the plan, exactly as initiateCheckout does. */
  applicationId:  string | null;
  /** The authenticated caller. Never a value taken from a request body. */
  userId:         string;
  /** checkout_sessions.sa_id_number — encrypted, as stored. */
  sessionSaIdEncrypted: string;
};

/**
 * Bind an unbound counter-session plan to the authenticated patient, but only
 * if their profile's SA ID is the one the till captured.
 *
 * Every outcome other than `claimed: true` leaves the database untouched.
 */
export async function claimUnboundSessionPlan(input: ClaimInput): Promise<ClaimOutcome> {
  const { svc, planId, applicationId, userId, sessionSaIdEncrypted } = input;

  const { data: profile } = await svc
    .from('profiles')
    .select('sa_id_number')
    .eq('id', userId)
    .maybeSingle();

  const storedProfileId = (profile?.sa_id_number as string | null | undefined) ?? null;
  // A profile with no SA ID cannot prove anything. Refuse rather than fall
  // back to a weaker test — "they were logged in" is exactly the proof this
  // function exists to avoid relying on.
  if (!storedProfileId) return { claimed: false, reason: 'no_profile_id' };

  let sessionId: string;
  let profileId: string;
  try {
    sessionId = decryptId(sessionSaIdEncrypted).trim();
    profileId = decryptId(storedProfileId).trim();
  } catch {
    // A key rotation or a corrupt value. Fail CLOSED — an unreadable identity
    // is not a matching identity.
    return { claimed: false, reason: 'decrypt_failed' };
  }

  if (!sessionId || sessionId !== profileId) return { claimed: false, reason: 'id_mismatch' };

  // The guard that makes this safe independently of everything above: a plan
  // that already has an owner cannot be reassigned here.
  const { data: bound, error } = await svc
    .from('plans')
    .update({ patient_id: userId })
    .eq('id', planId)
    .is('patient_id', null)
    .select('id');

  if (error) return { claimed: false, reason: 'write_failed' };

  if ((bound ?? []).length === 0) {
    // Zero rows means the plan was bound between the caller's read and this
    // write. Whether that is fine depends on WHO owns it now, so re-read
    // rather than guess.
    const { data: current } = await svc
      .from('plans')
      .select('patient_id')
      .eq('id', planId)
      .maybeSingle();
    const owner = (current?.patient_id as string | null | undefined) ?? null;
    return owner === userId
      ? { claimed: true,  reason: 'raced_same_user' }
      : { claimed: false, reason: 'already_bound' };
  }

  // Mirror initiateCheckout: the application follows the plan. Non-fatal —
  // the plan binding is the one the checkout guards read.
  if (applicationId) {
    await svc
      .from('applications')
      .update({ patient_id: userId })
      .eq('id', applicationId)
      .is('patient_id', null);
  }

  return { claimed: true, reason: 'claimed' };
}
