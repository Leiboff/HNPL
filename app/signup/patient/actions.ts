'use server';

import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { encryptId } from '@/lib/idEncryption';
import { ALLOWED_SALARY_DAYS, isAllowedSalaryDay } from '@/lib/salaryDates';
import {
  isValidEmail,
  normalizePhoneZA,
  validateSaId,
  saIdAge,
  checkPassword,
  type SaIdInvalidReason,
} from '@/lib/validation';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';

export type PatientSignupInput = {
  firstName:   string;
  lastName:    string;
  email:       string;
  password:    string;
  phone:       string;
  saIdNumber:  string;
  salaryDay:   number;
  token?:      string;
};

export type PatientSignupResult = {
  error:               string | null;
  success:             boolean;
  // OTP-abandon recovery: when a user already exists but is still
  // unconfirmed, we re-fire the signup OTP and ask the caller to redirect
  // straight to /verify-email instead of dead-ending on the "account
  // already exists" branch. The form treats this exactly like a fresh
  // signup's success.
  needsVerification?:  boolean;
  email?:              string;
};

const MIN_AGE = 18;

function saIdErrorMessage(reason: SaIdInvalidReason): string {
  switch (reason) {
    case 'length':      return 'SA ID number must be 13 digits.';
    case 'format':      return 'SA ID number must contain only digits.';
    case 'date':        return 'That ID number\'s date of birth isn\'t a real calendar date.';
    case 'citizenship': return 'That ID number\'s citizenship digit isn\'t recognised.';
    case 'checksum':    return 'That ID number\'s check digit doesn\'t match — please double-check what you typed.';
  }
}

export async function signUpPatient(input: PatientSignupInput): Promise<PatientSignupResult> {
  const { firstName, lastName, email, password, phone, saIdNumber, salaryDay, token } = input;

  if (!firstName.trim())   return { error: 'First name is required.', success: false };
  if (!lastName.trim())    return { error: 'Last name is required.',  success: false };
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.', success: false };

  // SA ID — full validation (DOB + citizenship + Luhn), per-reason messages.
  const saIdResult = validateSaId(saIdNumber);
  if (!saIdResult.valid) {
    return { error: saIdErrorMessage(saIdResult.reason), success: false };
  }

  // Age gate — patients must be 18+ (BNPL agreements; minors cannot contract).
  const age = saIdAge(saIdNumber);
  if (age === null || age < MIN_AGE) {
    return { error: `You must be ${MIN_AGE} or older to create a BetterNow account.`, success: false };
  }

  // Phone — must be a SA cell (no landlines for patients).
  const normalizedPhone = normalizePhoneZA(phone);
  if (!normalizedPhone) {
    return { error: 'Enter a valid South African cellphone number.', success: false };
  }

  // Password — minimum length plus the two cheap guards.
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

  if (!isAllowedSalaryDay(salaryDay)) {
    return { error: `Salary day must be one of: ${ALLOWED_SALARY_DAYS.join(', ')}.`, success: false };
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

  let encryptedSaId: string | null = null;
  try {
    encryptedSaId = encryptId(saIdNumber.trim());
  } catch {
    return { error: 'Encryption error — please contact support.', success: false };
  }

  // signUp triggers Supabase to email the 6-digit OTP (template uses
  // {{ .Token }} — see Phase 2.5 doc). With email-confirmation enforced
  // in the dashboard, the returned session is null and the user is
  // unconfirmed until verifyOtp({type:'email'}) succeeds at /verify-email.
  const { error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        role:         'patient',
        first_name:   firstName.trim(),
        last_name:    lastName.trim(),
        phone:        normalizedPhone,
        sa_id_number: encryptedSaId,
        salary_day:   salaryDay,
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
    //   • secure: production only — Vercel terminates TLS so the cookie
    //     is only ever set over HTTPS in prod. Locally on `next dev`
    //     we leave it off so the loopback http flow works.
    //   • path: '/' — the middleware (proxy.ts) reads this cookie on
    //     EVERY authenticated request to claim the invitation; needs
    //     to be sent everywhere until claimed.
    //   • maxAge: 7 days — the upper bound for "patient clicks invite,
    //     drifts through signup + email OTP, comes back later to
    //     finish". The middleware self-clears the cookie the moment
    //     the claim succeeds (or the token is found to be invalid).
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
