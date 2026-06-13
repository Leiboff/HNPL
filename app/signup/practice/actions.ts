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
  requiresManualLogin?: boolean;
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
  if (!input.city.trim())           return 'City is required.';
  if (!input.province)              return 'Province is required.';

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
// Phase 2 shape: only the seven things we actually need to create a practice
// account. Banking, HPCSA, CIPC, admin SA ID, admin_is_provider, and the
// team-members array are all collected later (Phase 3 in-portal Get-paid +
// Phase 4 on /practice/members). Practice is created with status='pending';
// admin approval queue in Phase 3 flips it.

export async function createPractice(input: CreatePracticeInput): Promise<CreatePracticeResult> {
  const validationError = validate(input);
  if (validationError) return { error: validationError, success: false };

  // Phase 1 validators already proved the phone parses.
  const normalizedPhone = normalizePhoneZA(input.phone, { allowLandline: true })!;

  const svc        = svcClient();
  const practiceId = crypto.randomUUID();
  let   adminUserId: string | null = null;

  try {
    // 1. Create the admin's auth user.
    const { data: adminAuth, error: authErr } = await svc.auth.admin.createUser({
      email:          input.email.trim().toLowerCase(),
      password:       input.password,
      email_confirm:  true,
      user_metadata: {
        role:                 'practice_admin',
        first_name:           input.firstName.trim(),
        last_name:            input.lastName.trim(),
        phone:                normalizedPhone,
        must_change_password: false,
      },
    });
    if (authErr || !adminAuth.user) {
      return { error: authErr?.message ?? 'Failed to create admin account.', success: false };
    }
    adminUserId = adminAuth.user.id;

    // 2. Insert the practice.
    //
    //   • status = 'pending' — every new practice waits for admin approval.
    //     Trading gate (Phase 3) checks status='approved' before allowing
    //     bill / plan creation.
    //   • practices.email   = the admin's email (also their login).
    //   • practices.admin_email is intentionally NOT written here — column
    //     is being deprecated in Phase 5.
    //   • fee_percent defaults to 6.00 via the column default.
    //   • Banking / HPCSA / CIPC / admin SA ID collected later via the
    //     "Get paid" surface (Phase 3).
    const { error: practiceErr } = await svc.from('practices').insert({
      id:                           practiceId,
      owner_id:                     adminUserId,
      name:                         input.practiceName.trim(),
      specialty:                    input.specialty,
      practice_registration_number: input.practiceRegNumber.trim() || null,
      email:                        input.email.trim().toLowerCase(),
      phone:                        normalizedPhone,
      address_line1:                input.addressLine1.trim(),
      address_line2:                input.addressLine2.trim() || null,
      suburb:                       input.suburb.trim() || null,
      city:                         input.city.trim(),
      practice_province:            input.province,
      postal_code:                  input.postalCode.trim() || null,
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

    // 4. Sign the admin in so they land on /practice with a live session.
    const supabase = await createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email:    input.email.trim().toLowerCase(),
      password: input.password,
    });
    if (signInError) {
      // Practice was created; the sign-in just didn't take (e.g. email
      // unconfirmed). The caller redirects to /login.
      return { error: null, success: true, requiresManualLogin: true };
    }

    return { error: null, success: true };
  } catch (err) {
    // Best-effort rollback so a failed insert doesn't leave an orphan auth
    // user or a broken practice row behind.
    if (practiceId)  await svc.from('practices').delete().eq('id', practiceId);
    if (adminUserId) await svc.auth.admin.deleteUser(adminUserId);
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    return { error: msg, success: false };
  }
}
