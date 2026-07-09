'use server';

import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import {
  isValidEmail,
  checkPassword,
} from '@/lib/validation';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';

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
//   • salary_day (now in /onboarding/identity)

export type PatientSignupInput = {
  firstName:  string;
  lastName:   string;
  email:      string;
  password:   string;
  token?:     string;
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

export async function signUpPatient(input: PatientSignupInput): Promise<PatientSignupResult> {
  const { firstName, lastName, email, password, token } = input;

  if (!firstName.trim())      return { error: 'First name is required.', success: false };
  if (!lastName.trim())       return { error: 'Last name is required.',  success: false };
  if (!isValidEmail(email))   return { error: 'Enter a valid email address.', success: false };

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
    if (!existing.email_confirmed_at) {
      await svc.auth.resend({ type: 'signup', email: normalizedEmail });
      return { error: null, success: true, needsVerification: true, email: normalizedEmail };
    }
    return { error: 'An account with this email already exists. Please sign in instead.', success: false };
  }

  // signUp triggers Supabase to email the 6-digit OTP. With email-
  // confirmation enforced in the dashboard, the returned session is
  // null and the user is unconfirmed until verifyOtp({type:'email'})
  // succeeds — the onboarding flow lands them at /onboarding/verify-email
  // to do that.
  const { error: signUpError } = await supabase.auth.signUp({
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
