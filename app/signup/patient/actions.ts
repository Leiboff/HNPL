'use server';

import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import {
  isValidEmail,
  checkPassword,
} from '@/lib/validation';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';
import { TERMS_VERSION } from '@/lib/legal/terms';
import { PRIVACY_VERSION } from '@/lib/legal/privacy';

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
// anything, and nothing downstream to catch it (the email path never
// had a terms onboarding step, so the miss was permanent and silent).
//
// Now: no stamp, no account. Returns true only when the row is
// confirmed written.
//
// .select() back rather than trusting a null error, because an update
// matching NO rows is a success in PostgREST. If the profile trigger
// hadn't fired yet, the "successful" stamp would have hit nothing.
async function recordAcceptance(svc: ServiceClient, userId: string): Promise<boolean> {
  const { data, error } = await svc
    .from('profiles')
    .update({
      terms_accepted_at: new Date().toISOString(),
      terms_version:     TERMS_VERSION,
      privacy_version:   PRIVACY_VERSION,
    })
    .eq('id', userId)
    // Write-once. An earlier acceptance is an audit fact and is not
    // re-dated by a second run through signup; the filter makes a
    // repeat a no-op rather than an overwrite, so the confirmation
    // below reads the column instead of counting rows.
    .is('terms_accepted_at', null)
    .select('id');

  if (error) {
    console.error('terms acceptance stamp failed:', error.message);
    return false;
  }
  if (data?.length) return true;

  // Zero rows: either already accepted (fine — write-once did its job)
  // or the row isn't there (not fine). Read back to tell them apart.
  const { data: row } = await svc
    .from('profiles')
    .select('terms_accepted_at')
    .eq('id', userId)
    .maybeSingle();
  return !!row?.terms_accepted_at;
}

export async function signUpPatient(input: PatientSignupInput): Promise<PatientSignupResult> {
  const { firstName, lastName, email, password, token, termsAccepted } = input;

  if (!firstName.trim())      return { error: 'First name is required.', success: false };
  if (!lastName.trim())       return { error: 'Last name is required.',  success: false };
  if (!isValidEmail(email))   return { error: 'Enter a valid email address.', success: false };
  // Server-side gate: the T&C tick is enforced in the form, but the
  // acceptance must be a server decision, not just a client checkbox.
  if (!termsAccepted)         return { error: 'Please accept the betternow terms to continue.', success: false };

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

  const svc      = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const supabase = await createClient();

  const normalizedEmail = email.trim().toLowerCase();

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
    if (await recordAcceptance(svc, existing.id)) {
      await svc.auth.resend({ type: 'signup', email: normalizedEmail });
      return { error: null, success: true, needsVerification: true, email: normalizedEmail };
    }

    // The stamp didn't land, which here almost always means there is no
    // profile row to stamp — the AUTH_ONLY orphan findExistingAuthUser
    // exists to catch. Resending the OTP would walk them into an app
    // with no profile AND no acceptance, and returning an error would
    // dead-end them permanently: every retry meets the same orphan.
    //
    // So clear it and create the account properly below. This is not
    // deleting someone's account — it is unconfirmed, meaning nobody has
    // ever proved they own this address, it carries no data, and the
    // person in front of us is asking for this exact email right now.
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
  const newUserId = signUpData.user?.id;
  if (!newUserId || !(await recordAcceptance(svc, newUserId))) {
    if (newUserId) {
      const { error: delErr } = await svc.auth.admin.deleteUser(newUserId);
      if (delErr) console.error('rollback of unaccepted signup failed:', delErr.message);
    }
    return {
      error: 'We couldn\'t record your agreement to the terms, so your account wasn\'t created. Please try again.',
      success: false,
    };
  }

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
