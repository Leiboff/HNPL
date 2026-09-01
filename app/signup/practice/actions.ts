'use server';

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { isValidEmail, normalizePhoneZA, checkPassword } from '@/lib/validation';
import { findExistingAuthUser } from '@/lib/auth/findExistingAuthUser';
import { notifyAdminOfPracticeSignup } from '@/lib/email/notifyAdminOfPracticeSignup';
import { isWithinSouthAfrica } from '@/lib/maps/saBounds';

// ─── Input / result shapes ───────────────────────────────────────────────────

export type CreatePracticeInput = {
  // About the practice
  practiceName:       string;
  specialty:          string;
  practiceRegNumber:  string;  // BHF "Practice number (PR)" — optional

  /**
   * If the signup was reached via a CRM-generated practice invitation
   * link (/signup/practice?token=…), the token flows through here so
   * the server can stamp accepted_at + accepted_by_practice_id on the
   * invite row AND link the linked CRM lead's converted_practice_id.
   * Optional — absence means "open self-signup". Invalid / expired /
   * already-accepted tokens are treated as absent (no failure — the
   * practice is still created).
   */
  inviteToken?:       string;

  // Address: client posts what the Places (New) picker captured. The
  // formatted address goes into addressLine1; suburb/city/province/
  // postalCode are parsed from the place's addressComponents on the
  // client (lib/maps/places parseAddressComponents). lat/long come
  // straight from the place's location field — no server-side geocode.
  addressLine1:       string;
  addressLine2:       string;
  suburb:             string;
  city:               string;
  province:           string;
  postalCode:         string;
  latitude:           number | null;
  longitude:          number | null;

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

// ─── getPracticeInvitationByToken ────────────────────────────────────
//
// Anonymous-safe: calls the SECURITY DEFINER RPC that returns at most
// one row for a non-expired, unaccepted invitation. Returns null for
// any invalid state — which now means NO SIGNUP, not an open one. Both
// the page (what it renders) and createPractice (what it accepts) gate
// on this same verdict.

export type PrefillPayload = {
  email:              string;
  practice_name:      string;
  contact_first_name: string | null;
  contact_last_name:  string | null;
  phone:              string | null;
  specialty:          string | null;
  street_address:     string | null;
  suburb:             string | null;
  city:               string | null;
  province:           string | null;
};

export async function getPracticeInvitationByToken(token: string): Promise<PrefillPayload | null> {
  if (!token || token.length < 8 || token.length > 128) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('get_practice_invitation_by_token', { p_token: token });
  if (error) {
    console.warn('[practice signup] get_practice_invitation_by_token error', error);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return row as PrefillPayload;
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
  // ── Invitation-only, enforced HERE ──────────────────────────────────
  //
  // /signup/practice used to be an open front door: the ?token= was a
  // convenience that pre-filled the form, and `if (!token) return` in the
  // page meant no token simply meant no prefill. Anyone who found the URL
  // could raise a practice, and the Provider Agreement tick they gave was
  // never recorded anywhere (grep this file for terms_accepted_at — there
  // is nothing).
  //
  // Practices are now provisioned by invitation only. The page renders no
  // form without one, but the page is not the boundary: this is a server
  // action with a public endpoint, reachable by a hand-rolled POST that
  // has never loaded the page at all. So the token is re-verified here,
  // against the same SECURITY DEFINER RPC the page uses, and its verdict
  // is what decides — never the caller's assertion that it holds one.
  //
  // The RPC returns a row only for an invitation that is non-expired AND
  // unaccepted, so a spent or stale token fails this exactly like no
  // token at all. accept_practice_invitation below then marks it used,
  // which is what keeps one invitation worth one practice.
  const invitation = input.inviteToken
    ? await getPracticeInvitationByToken(input.inviteToken)
    : null;
  if (!invitation) {
    return {
      error: 'Practice accounts are set up by invitation. Please contact the betternow team to get started.',
      success: false,
    };
  }

  const validationError = validate(input);
  if (validationError) return { error: validationError, success: false };

  // Phase 1 validators already proved the phone parses.
  const normalizedPhone = normalizePhoneZA(input.phone, { allowLandline: true })!;

  const email      = input.email.trim().toLowerCase();
  const svc        = svcClient();
  const practiceId = crypto.randomUUID();
  let   adminUserId: string | null = null;
  let   createdBrandId: string | null = null;

  try {
    // 0. Pre-check existence — covers normal abandon-at-OTP AND AUTH_ONLY
    //    orphans (auth user lingering with no profile, left behind by a
    //    failed rollback). findExistingAuthUser looks at BOTH tables; the
    //    profile-only lookup used previously missed the orphan case,
    //    causing every subsequent signup attempt with the same email to
    //    fall into Supabase's silent existing-email response branch.
    //
    //    Password / metadata are NOT touched on the recovery branch — that
    //    would be a password-reset side-channel.
    const existing = await findExistingAuthUser(svc, email);
    if (existing) {
      if (!existing.email_confirmed_at) {
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
    //      • returns { error: null } — and a `data` envelope whose shape
    //        we DELIBERATELY DO NOT depend on.
    //
    //    Why we ignore signUpData. The SSR-client signUp response sometimes
    //    has `data.user = null` even when the auth.users row was created
    //    successfully (this is observable in dev — the row appears in
    //    Supabase Studio, the OTP email arrives, the response is null).
    //    The patient flow works because it never reads data; we follow the
    //    same pattern here and fetch the just-created user's id via a
    //    service-role lookup, which is authoritative.
    const supabase = await createClient();
    const { error: signUpErr } = await supabase.auth.signUp({
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
    if (signUpErr) {
      return { error: signUpErr.message, success: false };
    }

    // Authoritative user lookup post-signUp. findExistingAuthUser is the
    // same helper the pre-check used — service-role read against
    // auth.users by email. The SSR-client signUp response is unreliable
    // about whether `data.user` is populated even on success, so we
    // never read it; this lookup is the source of truth for the new
    // auth user's id.
    const justCreated = await findExistingAuthUser(svc, email);
    if (!justCreated?.id) {
      return {
        error: 'Sign up did not complete. Please try again — if it keeps failing, contact support.',
        success: false,
      };
    }
    adminUserId = justCreated.id;

    // 2. Insert the practice (service-role, RLS bypass — see Phase 2 doc).
    //
    // Coordinates come from the client's Places (New) picker (the
    // `latitude` / `longitude` fields on the input). SA-range backstop
    // here protects against a future client bug or hand-rolled POST
    // that sets bogus coords. Out-of-range → NULL coords + warn, but
    // the practice is still created so signup never blocks on a
    // location glitch.
    let lat: number | null = input.latitude;
    let lng: number | null = input.longitude;
    if (lat != null && lng != null && !isWithinSouthAfrica(lat, lng)) {
      console.warn('[signup/practice] coords from client outside SA range — stored as NULL', {
        practiceId, lat, lng,
      });
      lat = null;
      lng = null;
    }

    // 2a. Brand-first inversion (0062): every practice belongs to a
    //     brand. For a solo signup we create the brand SILENTLY — the
    //     form has no brand field, the user sees no brand wording, and
    //     the brand name defaults to the practice name. The /brand
    //     surface only appears in the UI once the owner adds a second
    //     practice (n=1 → invisible, n>=2 → visible).
    const { data: brandRow, error: brandErr } = await svc
      .from('practice_groups')
      .insert({
        name:       input.practiceName.trim(),
        status:     'active',
        created_by: adminUserId,
      })
      .select('id')
      .single();
    if (brandErr || !brandRow) {
      throw new Error(`Brand: ${brandErr?.message ?? 'no brand row returned'}`);
    }
    const brandId = brandRow.id as string;
    createdBrandId = brandId;

    const { error: practiceErr } = await svc.from('practices').insert({
      id:                           practiceId,
      owner_id:                     adminUserId,
      group_id:                     brandId,
      name:                         input.practiceName.trim(),
      specialty:                    input.specialty,
      practice_registration_number: input.practiceRegNumber.trim() || null,
      email,
      phone:                        normalizedPhone,
      address_line1:                input.addressLine1.trim(),
      address_line2:                input.addressLine2.trim() || null,
      suburb:                       input.suburb.trim() || null,
      city:                         input.city.trim() || null,
      practice_province:            input.province || null,
      postal_code:                  input.postalCode.trim() || null,
      latitude:                     lat,
      longitude:                    lng,
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

    // 3a. Grant the signed-up user brand_admin of their auto-created
    //     brand. They never SEE the brand at n=1, but the membership
    //     row is what unlocks add-another-practice later.
    const { error: brandMemberErr } = await svc
      .from('practice_group_members')
      .insert({
        group_id: brandId,
        user_id:  adminUserId,
        role:     'brand_admin',
        active:   true,
      });
    if (brandMemberErr) throw new Error(`Brand member: ${brandMemberErr.message}`);

    // 3c. If this signup carries a CRM invite token, stamp acceptance
    //     on the invite AND set converted_practice_id on the linked lead.
    //     Best-effort: a failed accept must NOT roll back the signup —
    //     the practice exists either way. Sales can hand-link if needed.
    if (input.inviteToken) {
      const { error: acceptErr } = await svc.rpc('accept_practice_invitation', {
        p_token:       input.inviteToken,
        p_practice_id: practiceId,
      });
      if (acceptErr) {
        console.warn('[practice signup] accept_practice_invitation failed', {
          token_len: input.inviteToken.length, err: acceptErr,
        });
      }
    }

    // 3b. Notify the platform admin so they can review the new practice.
    //     Best-effort: a failed send (missing env vars, Resend outage)
    //     must NOT block the signup return — the user finishes signup
    //     either way, and the admin can also see new pending practices
    //     in the approval queue on demand.
    await notifyAdminOfPracticeSignup({
      id:        practiceId,
      name:      input.practiceName.trim(),
      specialty: input.specialty,
      city:      input.city.trim(),
    });

    // 4. Done. The user is unconfirmed and has no session. The caller will
    //    redirect to /verify-email?email=...&next=/practice. After
    //    verifyOtp the user lands on the practice dashboard, where the
    //    trading gate (status='pending') will show the "awaiting approval"
    //    panel until an HNPL admin approves the practice.
    return { error: null, success: true, needsVerification: true, email };
  } catch (err) {
    // ── Rollback order ─────────────────────────────────────────────────
    //   practices  →  practice_members  →  profiles  →  auth.users
    //
    //   Until 0044 + 0045 are applied (ON DELETE CASCADE on profiles.id,
    //   per-FK policy on downstream tables), this order matters: the
    //   profiles.id → auth.users(id) FK is NO ACTION, so deleting the
    //   auth user first would fail with FK violation, leaving an
    //   AUTH_ONLY orphan that breaks subsequent retries.
    //
    //   Once 0044 + 0045 are live, the profiles + practice_members steps
    //   become redundant (cascade handles them). We keep them as belt-
    //   and-braces so rollback survives a future regression in those
    //   migrations and so each step's failure is independently logged.
    if (practiceId) {
      const { error: e } = await svc.from('practices').delete().eq('id', practiceId);
      if (e) console.error('[practice signup] rollback practices.delete failed', e);
    }
    if (createdBrandId) {
      // Delete the brand FIRST (cascades practice_group_members via the
      // ON DELETE CASCADE on practice_group_members.group_id). Order
      // matters only relative to auth.users — anything keyed on the
      // brand can go before the user disappears.
      const { error: bErr } = await svc.from('practice_groups').delete().eq('id', createdBrandId);
      if (bErr) console.error('[practice signup] rollback practice_groups.delete failed', bErr);
    }
    if (adminUserId) {
      const { error: memErr } = await svc.from('practice_members').delete().eq('user_id', adminUserId);
      if (memErr) console.error('[practice signup] rollback practice_members.delete failed', memErr);

      const { error: profErr } = await svc.from('profiles').delete().eq('id', adminUserId);
      if (profErr) console.error('[practice signup] rollback profiles.delete failed', profErr);

      const { error: userErr } = await svc.auth.admin.deleteUser(adminUserId);
      if (userErr) console.error('[practice signup] rollback auth.deleteUser failed — ORPHAN auth user', {
        admin_user_id: adminUserId,
        err:           userErr,
      });
    }
    const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
    return { error: msg, success: false };
  }
}
