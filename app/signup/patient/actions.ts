'use server';

import { cookies } from 'next/headers';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

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
  error:   string | null;
  success: boolean;
};

function validateSaId(id: string): boolean {
  return /^\d{13}$/.test(id);
}

function validatePhone(phone: string): boolean {
  const digits = phone.replace(/[\s\-+]/g, '');
  return /^(27\d{9}|0\d{9})$/.test(digits);
}

export async function signUpPatient(input: PatientSignupInput): Promise<PatientSignupResult> {
  const { firstName, lastName, email, password, phone, saIdNumber, salaryDay, token } = input;

  if (!firstName.trim())                             return { error: 'First name is required.',                  success: false };
  if (!lastName.trim())                              return { error: 'Last name is required.',                   success: false };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))   return { error: 'Enter a valid email address.',             success: false };
  if (password.length < 8)                           return { error: 'Password must be at least 8 characters.', success: false };
  if (!validateSaId(saIdNumber))                     return { error: 'SA ID number must be 13 digits.',         success: false };
  if (!validatePhone(phone))                         return { error: 'Enter a valid South African phone number.', success: false };
  if (!Number.isInteger(salaryDay) || salaryDay < 1 || salaryDay > 31)
                                                     return { error: 'Salary day must be between 1 and 31.',    success: false };

  const svc    = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const supabase = await createClient();
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? '';

  const { data: existing } = await svc
    .from('profiles')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();

  if (existing) {
    return { error: 'An account with this email already exists. Please sign in instead.', success: false };
  }

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${appUrl}/patient`,
      data: {
        role:         'patient',
        first_name:   firstName.trim(),
        last_name:    lastName.trim(),
        phone:        phone.trim(),
        sa_id_number: saIdNumber.trim(),
        salary_day:   salaryDay,
      },
    },
  });

  if (signUpError) {
    return { error: signUpError.message ?? 'Sign up failed. Please try again.', success: false };
  }

  if (token) {
    const cookieStore = await cookies();
    cookieStore.set('hnpl_invite_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   60 * 60 * 24 * 7,
      path:     '/',
    });
  }

  return { error: null, success: true };
}
