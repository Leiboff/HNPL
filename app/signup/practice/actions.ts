'use server';

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { encryptId } from '@/lib/idEncryption';

export type MemberInput = {
  memberRole:         'provider' | 'manager';
  canCreateBills:     boolean;
  canManagePractice:  boolean;
  firstName:          string;
  lastName:           string;
  email:              string;
  specialty:          string;
  hpcsaNumber:        string;
  saIdNumber:         string;
  payoutDestination:  'practice' | 'provider';
  bankName:           string;
  accountHolder:      string;
  accountNumber:      string;
  branchCode:         string;
  accountType:        'current' | 'savings' | '';
};

export type CreatePracticeInput = {
  // Step 1 — admin
  firstName:   string;
  lastName:    string;
  email:       string;
  password:    string;
  phone:       string;
  saIdNumber:  string;

  // Step 2 — practice
  practiceName:            string;
  specialty:               string;
  hpcsaNumber:             string;
  practiceRegNumber:       string;
  adminEmail:              string;
  contactPhone:            string;
  addressLine1:            string;
  addressLine2:            string;
  suburb:                  string;
  city:                    string;
  province:                string;
  postalCode:              string;

  // Step 3 — banking
  accountHolder:      string;
  bankName:           string;
  bankAccountNumber:  string;
  branchCode:         string;
  accountType:        'current' | 'savings';

  // Step 4 — team members
  adminIsProvider:     boolean;
  adminSpecialty:      string;
  adminHpcsaNumber:    string;
  members:             MemberInput[];
};

export type CreatePracticeResult = {
  error:               string | null;
  success:             boolean;
  requiresManualLogin?: boolean;
};

function svcClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

function validate(input: CreatePracticeInput): string | null {
  if (!input.firstName.trim()) return 'First name is required.';
  if (!input.lastName.trim())  return 'Last name is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return 'Enter a valid email address.';
  if (input.password.length < 8) return 'Password must be at least 8 characters.';
  if (!/^\d{13}$/.test(input.saIdNumber)) return 'SA ID number must be 13 digits.';
  if (!input.practiceName.trim()) return 'Practice name is required.';
  if (!input.specialty) return 'Specialty is required.';
  if (!input.adminEmail.trim()) return 'Practice email is required.';
  if (!input.contactPhone.trim()) return 'Contact phone is required.';
  if (!input.addressLine1.trim()) return 'Address is required.';
  if (!input.city.trim()) return 'City is required.';
  if (!input.province) return 'Province is required.';
  if (!input.accountHolder.trim()) return 'Account holder is required.';
  if (!input.bankName) return 'Bank is required.';
  if (!input.bankAccountNumber.trim()) return 'Account number is required.';
  if (!input.branchCode.trim()) return 'Branch code is required.';
  if (!input.accountType) return 'Account type is required.';

  for (const m of input.members) {
    if (!m.firstName.trim() || !m.lastName.trim()) return 'Team member name is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) return 'Team member email is invalid.';
    if (!/^\d{13}$/.test(m.saIdNumber)) return 'Team member SA ID must be 13 digits.';
    if (m.memberRole === 'provider') {
      if (!m.specialty) return 'Provider specialty is required.';
      if (m.payoutDestination === 'provider') {
        if (!m.bankName || !m.accountHolder.trim() || !m.accountNumber.trim() || !m.branchCode.trim() || !m.accountType)
          return `Banking details required for ${m.firstName}'s personal payout.`;
      }
    }
  }
  return null;
}

export async function createPractice(input: CreatePracticeInput): Promise<CreatePracticeResult> {
  const validationError = validate(input);
  if (validationError) return { error: validationError, success: false };

  const svc      = svcClient();
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const practiceId = crypto.randomUUID();
  let   adminUserId: string | null = null;

  try {
    // Encrypt admin SA ID before it enters auth metadata; if the key is missing
    // encryptId throws and the outer catch aborts signup cleanly.
    const encryptedAdminSaId = input.saIdNumber.trim()
      ? encryptId(input.saIdNumber.trim())
      : null;

    // 1. Create admin auth account
    const { data: adminAuth, error: authErr } = await svc.auth.admin.createUser({
      email:          input.email.trim().toLowerCase(),
      password:       input.password,
      email_confirm:  true,
      user_metadata: {
        role:                 'practice_admin',
        first_name:           input.firstName.trim(),
        last_name:            input.lastName.trim(),
        phone:                input.phone.trim(),
        sa_id_number:         encryptedAdminSaId,
        must_change_password: false,
      },
    });
    if (authErr || !adminAuth.user) {
      return { error: authErr?.message ?? 'Failed to create admin account.', success: false };
    }
    adminUserId = adminAuth.user.id;

    // 2. Insert practice
    const { error: practiceErr } = await svc.from('practices').insert({
      id:                           practiceId,
      owner_id:                     adminUserId,
      name:                         input.practiceName.trim(),
      specialty:                    input.specialty,
      hpcsa_number:                 input.hpcsaNumber.trim() || null,
      practice_registration_number: input.practiceRegNumber.trim() || null,
      email:                        input.adminEmail.trim().toLowerCase(),
      admin_email:                  input.adminEmail.trim().toLowerCase(),
      phone:                        input.contactPhone.trim(),
      address_line1:                input.addressLine1.trim(),
      address_line2:                input.addressLine2.trim() || null,
      suburb:                       input.suburb.trim() || null,
      city:                         input.city.trim(),
      practice_province:            input.province,
      postal_code:                  input.postalCode.trim() || null,
      account_holder:               input.accountHolder.trim(),
      bank_name:                    input.bankName,
      bank_account_number:          input.bankAccountNumber.trim(),
      branch_code:                  input.branchCode.trim(),
      account_type:                 input.accountType,
      status:                       'approved',
      fee_percent:                  6,
      admin_is_provider:            input.adminIsProvider,
      admin_specialty:              input.adminIsProvider ? (input.adminSpecialty || null) : null,
      admin_hpcsa_number:           input.adminIsProvider ? (input.adminHpcsaNumber.trim() || null) : null,
    });
    if (practiceErr) throw new Error(`Practice: ${practiceErr.message}`);

    // 4. Insert admin as practice_member
    const { error: memberErr } = await svc.from('practice_members').insert({
      practice_id:       practiceId,
      user_id:           adminUserId,
      role:              'admin',
      active:            true,
      can_create_bills:    true,
      can_manage_practice: true,
      payout_destination:  'practice',
      specialty:           input.adminIsProvider ? (input.adminSpecialty || null) : null,
      hpcsa_number:        input.adminIsProvider ? (input.adminHpcsaNumber.trim() || null) : null,
    });
    if (memberErr) throw new Error(`Member: ${memberErr.message}`);

    // 5. Invite team members (array is empty when none were added)
    for (const member of input.members) {
        const encryptedMemberSaId = member.saIdNumber.trim()
          ? encryptId(member.saIdNumber.trim())
          : null;

        const authRole = member.memberRole === 'provider' ? 'practice_provider' : 'practice_admin';

        const { data: inviteData, error: inviteErr } = await svc.auth.admin.inviteUserByEmail(
          member.email.trim().toLowerCase(),
          {
            redirectTo: `${appUrl}/provider/setup`,
            data: {
              role:                 authRole,
              first_name:           member.firstName.trim(),
              last_name:            member.lastName.trim(),
              sa_id_number:         encryptedMemberSaId,
              hpcsa_number:         member.memberRole === 'provider' ? (member.hpcsaNumber.trim() || null) : null,
              must_change_password: true,
            },
          },
        );
        if (inviteErr || !inviteData.user) {
          throw new Error(`Invite ${member.email}: ${inviteErr?.message ?? 'Failed'}`);
        }

        const memberUserId = inviteData.user.id;

        const memberRow: Record<string, unknown> = {
          practice_id:         practiceId,
          user_id:             memberUserId,
          role:                member.memberRole === 'provider' ? 'provider' : 'admin',
          active:              true,
          can_create_bills:    member.canCreateBills,
          can_manage_practice: member.canManagePractice,
          sa_id_number:        encryptedMemberSaId,
          specialty:           member.memberRole === 'provider' ? (member.specialty || null) : null,
          hpcsa_number:        member.memberRole === 'provider' ? (member.hpcsaNumber.trim() || null) : null,
          payout_destination:  member.memberRole === 'provider' ? member.payoutDestination : 'practice',
        };
        if (member.memberRole === 'provider' && member.payoutDestination === 'provider') {
          memberRow.personal_bank_name       = member.bankName       || null;
          memberRow.personal_account_holder  = member.accountHolder.trim() || null;
          memberRow.personal_account_number  = member.accountNumber.trim() || null;
          memberRow.personal_branch_code     = member.branchCode.trim()   || null;
          memberRow.personal_account_type    = member.accountType    || null;
        }

        const { error: memberInsertErr } = await svc.from('practice_members').insert(memberRow);
        if (memberInsertErr) throw new Error(`Member ${member.email}: ${memberInsertErr.message}`);
    }

    // 6. Sign in the admin so they land on /practice with a live session
    const supabase = await createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email:    input.email.trim().toLowerCase(),
      password: input.password,
    });

    if (signInError) {
      // Practice was created successfully; sign-in failed (e.g. email not confirmed).
      // Tell the client to redirect to /login instead of assuming a live session.
      return { error: null, success: true, requiresManualLogin: true };
    }

    return { error: null, success: true };

  } catch (err) {
    // Cleanup: delete practice and admin user if either was created
    if (practiceId) {
      await svc.from('practices').delete().eq('id', practiceId);
    }
    if (adminUserId) {
      await svc.auth.admin.deleteUser(adminUserId);
    }
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    return { error: msg, success: false };
  }
}
