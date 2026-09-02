'use server';

import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import {
  isValidEmail,
  checkPassword,
} from '@/lib/validation';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';
import { consentColumns } from '@/lib/legal/documentHash';
import { currentServiceKeyKind, serviceKeyProblem } from '@/lib/supabase/serviceRoleKey';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';
import { assessIdentity } from '@/lib/security/identitySignals';
import { requestSignals } from '@/lib/security/requestSignals';

// ─── signUpPatient — slim, account-only ────────────────────────────────
//
// After the stepped-onboarding pass, this action creates an auth user
// and the minimal profile fields. Phone, SA ID, salary date, and the
// credit + affordability check are ALL captured inside the /onboarding
// tree post-signup (state model routes to the first unfinished step).
//
// Kept here:
//   • email + password validation
//   • name fields (first + last)
//   • OTP-abandon recovery via findExistingAuthUser
//   • invitation-token cookie handoff (unchanged)
//
// Removed (delegated to /onboarding):
//   • phone capture (now in /onboarding/phone's phone-entry sub-stage)
//   • SA-ID validation + encryption (now in /onboarding/identity, still
//     the same lib/idEncryption + lib/validation/saId under the hood)
//   • salary_day (now in /onboarding/salary)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServiceClient = any;

export type PatientSignupInput = {
  firstName:     string;
  lastName:      string;
  email:         string;
  password:      string;
  token?:        string;
  termsAccepted: boolean;
};

export type PatientSignupResult = {
  error:              string | null;
  success:            boolean;
  // OTP-abandon recovery: when a user already exists but is still
  // unconfirmed, we re-fire the signup OTP and ask the caller to
  // redirect straight to /onboarding/verify-email instead of dead-
  // ending on the "account already exists" branch. The form treats
  // this exactly like a fresh signup's success.
  needsVerification?: boolean;
  email?:             string;
};

// ─── The acceptance stamp is a HARD gate ───────────────────────────────
//
// It used to be best-effort: log the failure, create the account
// anyway. That produced exactly the account this system must not be
// able to produce — a live customer with no record that they agreed to
// anything.
//
// Now: no stamp, no account.
//
// ─── But "no stamp" must mean the write was REFUSED ───────────────────
//
// Reported from the field: a normal email signup, terms ticked, and the
// screen came back with "We couldn't record your agreement to the terms,
// so your account wasn't created." Every retry does the same thing, and
// after the first attempt a retry can also collide with the account the
// rollback was meant to remove — a permanent dead end on the front door.
//
// This function conflated two very different situations and returned
// false for both:
//
//   • the write was refused (permissions, a bad column, the row locked) —
//     genuinely fatal, and worth undoing the account for;
//   • there was no profile row to write TO.
//
// The second is not fatal and should never have cost anyone their
// signup. /auth/callback has provisioned defensively in exactly that
// situation for as long as it has existed ("trigger didn't fire OR the
// row was deleted — provision as a standard patient"), and it does so
// WITH the acceptance. The email path had no equivalent, so the same
// database state that the OAuth path recovers from silently ended the
// email path with this message. That asymmetry is the bug.
//
// So: stamp the row if it is there, CREATE it with the acceptance if it
// is not, and fail only when the database actually refuses us.
//
// Every failure now carries its reason into the logs. The old version
// logged `error.message` alone, which is why the field report could not
// be told apart from a permissions problem: PostgREST puts the useful
// part in `code` and `details`.

type ProfileSeed = {
  email:     string;
  firstName: string;
  lastName:  string;
};

type AcceptanceOutcome =
  | { ok: true;  how: 'stamped' | 'already-on-record' | 'provisioned' }
  | { ok: false; why: string; ref: string };

/**
 * A short reference shown to the person in front of the screen.
 *
 * The failure this covers has now been reported twice and diagnosed
 * neither time, because the screen said the same sentence whatever the
 * cause and the reason only existed in a server log nobody was reading. A
 * tester can read this off the page and quote it.
 *
 * Deliberately coarse: an operation and a SQLSTATE. No table names, no
 * ids, no key material, nothing about who exists.
 */
function ref(operation: string, error?: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = (error as any)?.code;
  const suffix = typeof code === 'string' && /^[A-Za-z0-9]{1,8}$/.test(code) ? `-${code}` : '';
  return `${operation}${suffix}`.toUpperCase();
}

/** Everything PostgREST knows about a failure, not just the sentence. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(error: any): string {
  const parts = [error?.code, error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .map(String);
  return parts.length ? parts.join(' | ') : 'unknown error';
}

/** Is the acceptance on the row now? The only question that matters. */
async function acceptanceOnRecord(
  svc: ServiceClient,
  userId: string,
): Promise<{ exists: boolean; accepted: boolean; error?: string }> {
  const { data, error } = await svc
    .from('profiles')
    .select('terms_accepted_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) return { exists: false, accepted: false, error: describe(error) };
  return { exists: !!data, accepted: !!data?.terms_accepted_at };
}

async function recordAcceptance(
  svc: ServiceClient,
  userId: string,
  seed: ProfileSeed,
): Promise<AcceptanceOutcome> {
  // Write-once. An earlier acceptance is an audit fact and is not
  // re-dated by a second run through signup; the `.is(null)` filter makes
  // a repeat a no-op rather than an overwrite.
  //
  // .select() back rather than trusting a null error, because an update
  // matching NO rows is a success in PostgREST.
  const { data: stamped, error: updateErr } = await svc
    .from('profiles')
    .update(consentColumns())
    .eq('id', userId)
    .is('terms_accepted_at', null)
    .select('id');

  if (updateErr) {
    // A refused write. Fatal — we do not know what state the row is in
    // and we are not going to guess on a legal record.
    console.error('[signup] terms acceptance UPDATE refused', { userId, error: describe(updateErr) });
    return { ok: false, why: `update refused: ${describe(updateErr)}`, ref: ref('upd', updateErr) };
  }
  if (stamped?.length) return { ok: true, how: 'stamped' };

  // Zero rows. Three possibilities, and they are not the same thing.
  const state = await acceptanceOnRecord(svc, userId);
  if (state.error) {
    console.error('[signup] terms acceptance read-back failed', { userId, error: state.error });
    return { ok: false, why: `read-back failed: ${state.error}`, ref: ref('read') };
  }

  // (1) Already accepted — write-once did its job.
  if (state.accepted) return { ok: true, how: 'already-on-record' };

  // (2) The row is there and the column is null, yet the filtered update
  // matched nothing. Only a race gets here (something stamped and cleared
  // between the two statements). Try once without the filter.
  if (state.exists) {
    const { data: retried, error: retryErr } = await svc
      .from('profiles')
      .update(consentColumns())
      .eq('id', userId)
      .select('id');
    if (retryErr || !retried?.length) {
      console.error('[signup] terms acceptance retry did not land', {
        userId,
        error: retryErr ? describe(retryErr) : 'update matched no rows',
      });
      return { ok: false, why: 'retry did not land', ref: ref('retry', retryErr) };
    }
    return { ok: true, how: 'stamped' };
  }

  // (3) No profile row at all. NOT fatal — provision it, with the
  // acceptance, exactly as /auth/callback does for an OAuth arrival in
  // the same state. role is 'patient' because this is the patient signup
  // action and nothing else can reach it.
  console.warn('[signup] no profile row to stamp — provisioning defensively', { userId });
  const { error: insertErr } = await svc.from('profiles').insert({
    id:         userId,
    email:      seed.email,
    role:       'patient',
    first_name: seed.firstName,
    last_name:  seed.lastName,
    verification_status: 'unverified',
    ...consentColumns(),
  });

  if (insertErr) {
    // A unique violation means the trigger's row landed between our read
    // and our insert. Re-read: if the acceptance is there, we are done.
    const again = await acceptanceOnRecord(svc, userId);
    if (again.accepted) return { ok: true, how: 'already-on-record' };
    console.error('[signup] defensive profile provision failed', { userId, error: describe(insertErr) });
    return { ok: false, why: `provision failed: ${describe(insertErr)}`, ref: ref('prov', insertErr) };
  }

  return { ok: true, how: 'provisioned' };
}

export async function signUpPatient(input: PatientSignupInput): Promise<PatientSignupResult> {
  const { firstName, lastName, email, password, token, termsAccepted } = input;

  // ── Rate limit ──────────────────────────────────────────────────────
  //
  // Anonymous, and every successful call creates an auth user AND sends a
  // Supabase transactional email. It had no limiter of any kind (audit
  // F-17). Spent BEFORE validation on purpose — unlike the contact form,
  // where the same ordering question was decided the other way, the
  // expensive work here is not gated behind a cheap validator an attacker
  // would have to satisfy: a script sends well-formed payloads.
  if (!await consumeAll('signup', [
    [await clientIp(), RATE_LIMITS.signup.ip],
  ])) {
    return {
      error: 'Too many sign-up attempts from this connection. Please wait a few minutes and try again.',
      success: false,
    };
  }

  if (!firstName.trim())      return { error: 'First name is required.', success: false };
  if (!lastName.trim())       return { error: 'Last name is required.',  success: false };
  if (!isValidEmail(email))   return { error: 'Enter a valid email address.', success: false };
  // ── Server-side gate: the acceptance is a SERVER decision ───────────
  //
  // The tick is enforced in the form too, but a Server Action is an HTTP
  // endpoint and the form is a page the caller owns — so this is the only
  // check that counts.
  //
  // `!== true`, not `!termsAccepted`. The field is typed `boolean` and
  // TypeScript is erased at runtime; nothing between the wire and here
  // coerces it, so a crafted payload can send a string, a number, or an
  // object. `!termsAccepted` admits every truthy one of those — including,
  // notoriously, the STRING "false" — and each would create an account
  // AND stamp profiles.terms_accepted_at.
  //
  // That column is a legal audit record. A value the server never examined
  // is not evidence that anyone agreed to anything, so the gate takes the
  // same strict-equality posture the OAuth path already takes on its own
  // client-asserted parameter (`terms_accepted === '1'` in
  // app/auth/callback/route.ts). Enumerated in
  // app/signup/patient/terms-bypass.adversarial.test.ts.
  if (termsAccepted !== true)  return { error: 'Please accept the betternow terms to continue.', success: false };

  // Password — minimum length + the two cheap guards (email-local-part
  // + common-password list). Same guardrails as before.
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.', success: false };
  }
  const pwdCheck = checkPassword(password, email);
  if (!pwdCheck.ok) {
    return {
      error: pwdCheck.reason === 'contains_email_local_part'
        ? 'Please choose a password that doesn\'t contain your email address.'
        : 'That password is too common. Please choose a less guessable one.',
      success: false,
    };
  }

  // ── Can this process write past RLS at all? ─────────────────────────
  //
  // Checked BEFORE an account is created, because the alternative is what
  // happened twice: signUp succeeds, every privileged read comes back
  // empty (RLS returns zero rows rather than an error — see
  // lib/supabase/serviceRoleKey.ts), the acceptance cannot be recorded,
  // and the account is rolled back with a message that describes the
  // symptom and names nothing. A misconfigured key is not a signup
  // failure and must not be reported as one.
  //
  // It does NOT block the signup: a key shape this cannot recognise may
  // still be perfectly valid, and refusing every signup over a guess about
  // a string would be worse than the bug. It logs, loudly, and rides along
  // in the reference if the acceptance then fails — so the next report
  // arrives with the answer attached.
  const keyKind  = currentServiceKeyKind();
  const keyFault = serviceKeyProblem(keyKind);
  if (keyFault) console.error('[signup] PRIVILEGED KEY MISCONFIGURED —', keyFault);

  const svc      = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const supabase = await createClient();

  const normalizedEmail = email.trim().toLowerCase();
  // What a defensively-provisioned profile row is filled with, if it turns
  // out there is no row to stamp. Same shape /auth/callback inserts.
  const seed: ProfileSeed = {
    email:     normalizedEmail,
    firstName: firstName.trim(),
    lastName:  lastName.trim(),
  };

  // OTP-abandon recovery — also covers AUTH_ONLY orphans from prior
  // failed signups (see lib/auth/findExistingAuthUser.ts). Password and
  // metadata are deliberately not re-written on the recovery branch.
  const existing = await findExistingAuthUser(svc, normalizedEmail);
  if (existing) {
    if (existing.email_confirmed_at) {
      return { error: 'An account with this email already exists. Please sign in instead.', success: false };
    }

    // Unconfirmed — the abandon-at-OTP case. It gets the same gate as a
    // fresh signup: this account was never finished, so it may predate
    // the acceptance requirement entirely, and it does not get waved
    // through on the strength of already existing.
    const recovered = await recordAcceptance(svc, existing.id, seed);
    if (recovered.ok) {
      // Includes the AUTH_ONLY orphan case — no profile row — which
      // recordAcceptance now PROVISIONS rather than reporting as a
      // failure. That used to fall through to the delete-and-recreate
      // below; provisioning reaches the same end state without
      // destroying and re-minting an auth user, so the delete is now
      // only for a genuinely refused write.
      await svc.auth.resend({ type: 'signup', email: normalizedEmail });
      return { error: null, success: true, needsVerification: true, email: normalizedEmail };
    }

    // The database refused us. Resending the OTP would walk them into an
    // app with no acceptance, and returning an error would dead-end them
    // permanently: every retry meets the same orphan.
    //
    // So clear it and create the account properly below. This is not
    // deleting someone's account — it is unconfirmed, meaning nobody has
    // ever proved they own this address, it carries no data, and the
    // person in front of us is asking for this exact email right now.
    console.error('[signup] could not record acceptance on an unconfirmed account', {
      userId:  existing.id,
      why:     recovered.why,
      keyKind,
    });
    const { error: orphanErr } = await svc.auth.admin.deleteUser(existing.id);
    if (orphanErr) {
      console.error('could not clear unaccepted orphan signup:', orphanErr.message);
      return { error: 'We couldn\'t create your account. Please try again.', success: false };
    }
  }

  // signUp triggers Supabase to email the 6-digit OTP. With email-
  // confirmation enforced in the dashboard, the returned session is
  // null and the user is unconfirmed until verifyOtp({type:'email'})
  // succeeds — the onboarding flow lands them at /onboarding/verify-email
  // to do that.
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        role:       'patient',
        first_name: firstName.trim(),
        last_name:  lastName.trim(),
      },
    },
  });

  if (signUpError) {
    return { error: signUpError.message ?? 'Sign up failed. Please try again.', success: false };
  }

  // Record T&C acceptance on the profile, server-side, at the moment of
  // signup. The profile row is created synchronously by the
  // on_auth_user_created trigger, so it exists by the time signUp
  // returns; we stamp it with the version the customer agreed to
  // (lib/legal/terms.ts).
  //
  // If it does not land, the account is UNDONE. The auth user was
  // created microseconds ago by this request, findExistingAuthUser
  // established there was nothing here before it, and it carries no
  // data yet — so deleting it is a rollback of our own half-finished
  // transaction, not the destruction of anyone's account. The
  // alternative is leaving an unaccepted account behind and telling the
  // customer to try again, which would then hit "an account with this
  // email already exists" and strand them permanently.
  // ── signUp does not reliably hand back the new user ──────────────────
  //
  // THE ACTUAL BUG, after two wrong diagnoses of mine and one wrong fix.
  //
  // @supabase/auth-js parses the /signup response with `_sessionResponse`,
  // whose entire user extraction is:
  //
  //     const user = data.user ?? null;
  //
  // GoTrue's POST /signup returns an AccessTokenResponse — with the user
  // NESTED under `user` — only when it creates a session. When email
  // confirmation is required it creates no session and returns the User
  // model at the TOP LEVEL of the body instead. There is no `user` key to
  // read, so auth-js yields `{ user: null, session: null }` with no error.
  // (`_userResponse`, two functions along in the same file, has the
  // fallback this one lacks: `data.user ?? data`.)
  //
  // This project requires email confirmation — the whole OTP flow depends
  // on it — so EVERY email signup came back with a null user. The account
  // was created; we simply never learned its id, so the acceptance was
  // never stamped and the visitor was told we could not record their
  // agreement. Every time, for every address, new or not. That is both
  // field reports, and it is why neither of my earlier fixes helped: one
  // was about a key, the other provisioned a profile row for an id we did
  // not have.
  //
  // It is also why the reference read NOUSER for an address that had
  // never been used, which is the fact that finally ruled out
  // "the email already exists" and pointed here.
  //
  // So this no longer trusts the response SHAPE. signUp returned no
  // error, which means an auth user now exists for this address; the id
  // is resolved by looking it up. findExistingAuthUser's cheap path finds
  // it via the profiles row the handle_new_user trigger just created, so
  // this works whether or not migration 0119 has been applied.
  const newUser = signUpData.user;

  // The one response that really does mean "already registered": a user
  // object with an EMPTY identities array — GoTrue's obfuscated fake user,
  // returned when both Confirm-email and Confirm-phone are enabled
  // (documented in auth-js's own signUp remarks). A null user is NOT this
  // signal, and reading it as one made every signup report a duplicate.
  if (newUser && Array.isArray(newUser.identities) && newUser.identities.length === 0) {
    return {
      error: 'An account with this email already exists. Please sign in instead — '
        + 'or use "Forgot password" if you can\'t get in.',
      success: false,
    };
  }

  let newUserId: string | null = newUser?.id ?? null;
  if (!newUserId) {
    const created = await findExistingAuthUser(svc, normalizedEmail);
    newUserId = created?.id ?? null;
    if (newUserId) {
      // Expected on every confirm-email signup, not an anomaly — logged at
      // warn so the shape is visible if auth-js ever starts nesting the
      // user and this branch stops being taken.
      console.warn('[signup] signUp returned no user id (top-level user body) — resolved by email lookup');
    } else {
      console.error('[signup] signUp reported no error, but no user could be resolved for this address');
    }
  }

  const accepted = newUserId ? await recordAcceptance(svc, newUserId, seed) : null;
  if (!newUserId || !accepted?.ok) {
    console.error('[signup] rolling back an account with no acceptance', {
      userId:  newUserId ?? '(no user returned by signUp)',
      why:     accepted && !accepted.ok ? accepted.why : 'signUp returned no user id',
      keyKind,
    });
    if (newUserId) {
      const { error: delErr } = await svc.auth.admin.deleteUser(newUserId);
      if (delErr) console.error('rollback of unaccepted signup failed:', delErr.message);
    }
    // The reference is the whole point of this branch existing twice. It
    // is what turns "please try again" — which two testers correctly read
    // as "this is broken" — into something diagnosable from a screenshot.
    const reference = [accepted && !accepted.ok ? accepted.ref : 'NOUSER', keyFault ? `KEY-${keyKind.toUpperCase()}` : null]
      .filter(Boolean)
      .join('/');
    return {
      error: 'We couldn\'t record your agreement to the terms, so your account wasn\'t created. '
        + `Please try again, and quote reference ${reference} if it happens again.`,
      success: false,
    };
  }

  // ── Identity signals (audit R3, bot / synthetic-identity defence) ───
  //
  // Runs AFTER the acceptance is safely recorded, so a signal write can
  // never be the thing that costs somebody their account.
  //
  // RECORDED, NOT ENFORCED — and that is a considered choice, not a
  // half-finished one. Blocking here would be self-defeating in a way that
  // is easy to miss: the only refusal available at signup is to roll the
  // auth user back, `profiles` cascades to `identity_signals` and
  // `fraud_decisions`, and the deleted account's links vanish with it. A
  // device sitting on six accounts would drop to five the instant we
  // refused the seventh, and the attacker could retry indefinitely while
  // the evidence deleted itself. The block would be a loop, not a wall.
  //
  // Keeping the account costs nothing: an account with no approved credit
  // limit cannot transact at all (which is the state all 87 existing
  // accounts are in today). The refusal that matters happens at
  // runCreditCheck, where credit is actually granted — by which point the
  // phone and card signals exist too, and the link graph is worth
  // something.
  //
  // Only device and IP are available at this point. IP never blocks
  // anyway; device is the one that will carry weight here later.
  await assessIdentity(svc, newUserId, 'signup', await requestSignals());

  if (token) {
    // Cookie posture (hardened 2026-06-21):
    //   • httpOnly: JS in the browser cannot read it.
    //   • sameSite: 'lax' — the patient may click the invite link from
    //     an email (top-level navigation); lax allows the cookie on
    //     that hop, 'strict' would drop it.
    //   • secure: production only.
    //   • path: '/' — the middleware reads it on every authenticated
    //     request to claim the invitation.
    //   • maxAge: 7 days — upper bound for "click invite, drift through
    //     signup + email OTP, come back later to finish".
    const cookieStore = await cookies();
    cookieStore.set('hnpl_invite_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   60 * 60 * 24 * 7,
      path:     '/',
    });
  }

  return { error: null, success: true };
}
