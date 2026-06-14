'use server';

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { isValidEmail, normalizePhoneZA, checkPassword } from '@/lib/validation';

// ─── Input / result shapes ───────────────────────────────────────────────────

export type CreatePracticeInput = {
  // About the practice
  practiceName:       string;
  specialty:          string;
  practiceRegNumber:  string;  // BHF "Practice number (PR)" — optional
  addressLine1:       string;
  addressLine2:       string;
  suburb:             string;
  city:               string;
  province:           string;
  postalCode:         string;

  // Admin (the human signing up)
  firstName:          string;
  lastName:           string;
  email:              string;   // also becomes the login
  password:           string;
  phone:              string;   // practice contact — allowLandline

  // Provider Agreement checkbox
  agreementAccepted:  boolean;
};

export type CreatePracticeResult = {
  error:                string | null;
  success:              boolean;
  // When true, the caller must send the user to /verify-email to enter the
  // 6-digit OTP Supabase just emailed them. There is NO session yet — they
  // are an unconfirmed auth user, and the trading gate (status='pending')
  // would block them from doing anything useful in the portal until
  // verifyOtp + admin approval are both done anyway.
  needsVerification?:   boolean;
  email?:               string;
};

function svcClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ─── Server-side validation (authoritative) ──────────────────────────────────

function validate(input: CreatePracticeInput): string | null {
  if (!input.practiceName.trim())   return 'Practice name is required.';
  if (!input.specialty)             return 'Specialty is required.';
  if (!input.addressLine1.trim())   return 'Street address is required.';
  // Suburb + Postal code are required server-side (mirrors the client form).
  // Practice number (PR) and Address line 2 remain optional.
  if (!input.suburb.trim())         return 'Suburb is required.';
  if (!input.city.trim())           return 'City is required.';
  if (!input.province)              return 'Province is required.';
  if (!input.postalCode.trim())     return 'Postal code is required.';

  if (!input.firstName.trim())      return 'First name is required.';
  if (!input.lastName.trim())       return 'Last name is required.';
  if (!isValidEmail(input.email))   return 'Enter a valid email address.';

  if (input.password.length < 8)    return 'Password must be at least 8 characters.';
  const pwd = checkPassword(input.password, input.email);
  if (!pwd.ok) {
    return pwd.reason === 'contains_email_local_part'
      ? 'Please choose a password that doesn\'t contain your email address.'
      : 'That password is too common. Please choose a less guessable one.';
  }

  if (!normalizePhoneZA(input.phone, { allowLandline: true })) {
    return 'Enter a valid South African phone number.';
  }

  if (!input.agreementAccepted) {
    return 'Please accept the Provider Agreement to continue.';
  }

  return null;
}

// ─── createPractice ─────────────────────────────────────────────────────────
//
// Phase 2 shape: only the things we need to create a practice account.
// Banking, HPCSA, CIPC, admin SA ID, admin_is_provider, and team members
// are all collected later. Practice is created with status='pending'.
//
// Email OTP gate (added Phase 2.5):
//   Uses supabase.auth.signUp() to create the admin user — this triggers
//   Supabase to email the 6-digit verification OTP (template uses
//   {{ .Token }}). The user is UNCONFIRMED at this point and has NO
//   session. We then write the practice + member rows via the service-role
//   client (which doesn't care about the auth user's confirmed_at), and
//   return needsVerification:true. The caller redirects to /verify-email,
//   where supabase.auth.verifyOtp({type:'email'}) confirms the account
//   and creates the session.
//
//   Importantly, the previous flow's "pre-confirm-and-auto-login" pair has
//   been REMOVED — that path auto-confirmed the user and minted a session,
//   bypassing email verification entirely. The source-text regression
//   tests in app/signup/signup-forms.test.ts lock that out.

export async function createPractice(input: CreatePracticeInput): Promise<CreatePracticeResult> {
  const validationError = validate(input);
  if (validationError) return { error: validationError, success: false };

  // Phase 1 validators already proved the phone parses.
  const normalizedPhone = normalizePhoneZA(input.phone, { allowLandline: true })!;

  const email      = input.email.trim().toLowerCase();
  const svc        = svcClient();
  const practiceId = crypto.randomUUID();
  let   adminUserId: string | null = null;

  try {
    // 0. OTP-abandon recovery — if a profile already exists for this
    //    email and the auth user is still unconfirmed, re-fire the OTP
    //    and route the user back to /verify-email instead of dead-ending
    //    on a "user already registered" error from signUp().
    //
    //    As with the patient flow: we do NOT touch the user's stored
    //    password or metadata on this branch — that would be a
    //    password-reset side-channel.
    const { data: existingProfile } = await svc
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (existingProfile) {
      const { data: { user: existingUser } } = await svc.auth.admin.getUserById(existingProfile.id);
      if (existingUser && !existingUser.email_confirmed_at) {
        await svc.auth.resend({ type: 'signup', email });
        return { error: null, success: true, needsVerification: true, email };
      }
      return { error: 'An account with this email already exists. Please sign in instead.', success: false };
    }

    // 1. Sign up the admin via the SSR client. With email-confirmation
    //    enforced in the Supabase dashboard this:
    //      • creates the auth.users row (email_confirmed_at = NULL)
    //      • fires the profile-creation trigger via user_metadata
    //      • sends the signup OTP via the configured email template
    //      • returns { user, session: null }  — no live session yet
    const supabase = await createClient();
    const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
      email,
      password: input.password,
      options: {
        data: {
          role:                 'practice_admin',
          first_name:           input.firstName.trim(),
          last_name:            input.lastName.trim(),
          phone:                normalizedPhone,
          must_change_password: false,
        },
      },
    });
    if (signUpErr || !signUpData.user) {
      return { error: signUpErr?.message ?? 'Failed to create admin account.', success: false };
    }
    adminUserId = signUpData.user.id;

    // 2. Insert the practice (service-role, RLS bypass — see Phase 2 doc).
    const { error: practiceErr } = await svc.from('practices').insert({
      id:                           practiceId,
      owner_id:                     adminUserId,
      name:                         input.practiceName.trim(),
      specialty:                    input.specialty,
      practice_registration_number: input.practiceRegNumber.trim() || null,
      email,
      phone:                        normalizedPhone,
      address_line1:                input.addressLine1.trim(),
      address_line2:                input.addressLine2.trim() || null,
      suburb:                       input.suburb.trim(),
      city:                         input.city.trim(),
      practice_province:            input.province,
      postal_code:                  input.postalCode.trim(),
      status:                       'pending',
    });
    if (practiceErr) throw new Error(`Practice: ${practiceErr.message}`);

    // 3. Insert the admin as a practice_member with full management rights.
    const { error: memberErr } = await svc.from('practice_members').insert({
      practice_id:         practiceId,
      user_id:             adminUserId,
      role:                'admin',
      active:              true,
      can_create_bills:    true,
      can_manage_practice: true,
      payout_destination:  'practice',
    });
    if (memberErr) throw new Error(`Member: ${memberErr.message}`);

    // 4. Done. The user is unconfirmed and has no session. The caller will
    //    redirect to /verify-email?email=...&next=/practice. After
    //    verifyOtp the user lands on the practice dashboard, where the
    //    trading gate (status='pending') will show the "awaiting approval"
    //    panel until an HNPL admin approves the practice.
    return { error: null, success: true, needsVerification: true, email };
  } catch (err) {
    // Best-effort rollback so a failed insert doesn't leave an orphan auth
    // user or a broken practice row behind. We never silently keep
    // partial state.
    if (practiceId)  await svc.from('practices').delete().eq('id', practiceId);
    if (adminUserId) await svc.auth.admin.deleteUser(adminUserId);
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    return { error: msg, success: false };
  }
}
