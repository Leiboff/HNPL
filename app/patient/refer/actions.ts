'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getRequestUser } from '@/lib/auth/requestUser';
import { isValidEmail } from '@/lib/validation/email';
import { normalizePhoneZA } from '@/lib/validation';
import { neutraliseFormula } from '@/lib/crm/csv';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';
import { generateReferralCode } from '@/lib/referrals/code';
import { referralLink } from '@/lib/referrals/link';
import { REFERRAL_INVITE_TTL_DAYS } from '@/lib/referrals/vocabulary';
import { sendReferralInviteEmail } from '@/lib/email/templates/referralInvite';

// ─── The three writes a patient can make to the referral system ───────────
//
//   ensureMyReferralCode  mint this patient's code, once
//   referAFriend          invite a person, by email
//   referAPractice        nominate a practice, into the CRM pipeline
//
// ALL of them run on the service-role client. `referrals` and
// `referral_codes` carry SELECT policies and no write policies at all
// (migration 0145), so there is no session-client path to any of this — by
// construction rather than by convention.
//
// That places the entire authorisation burden here, which is the trade the
// repo already makes for every write that matters. Each action therefore:
//
//   1. resolves the caller from the session (never from an argument),
//   2. re-reads their role server-side and refuses anything but 'patient',
//   3. spends a rate-limit budget on BOTH the IP and the account,
//   4. builds the row itself — the caller supplies content, never columns.
//
// Step 4 is the one that matters most and the one that is easiest to lose. A
// referral row decides who gets credited for a customer. Nothing a caller
// sends is allowed to reach `referrer_id`, `status`, `referred_profile_id` or
// `qualified_at`; those are set here, from the session and from constants.
//
// ─── NO INCENTIVE ────────────────────────────────────────────────────────
//
// Nothing in this file issues, calculates, promises or records a reward. See
// docs/REFERRALS.md for what an incentive programme would attach to.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ServiceClient = any;

function svc(): ServiceClient {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/** Bound what a form can push into a row a rep or an operator has to read. */
const MAX = {
  name:     120,
  email:    254,
  phone:     40,
  practice: 200,
  note:     500,
} as const;

export type ReferralActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; field?: string };

type Caller = { id: string; firstName: string; email: string };

/**
 * The caller, re-verified server-side.
 *
 * Returns null for anything that is not a confirmed patient. The role read is
 * NOT skippable on the grounds that the page already checked: a Server Action
 * is an HTTP endpoint, and the page is a screen the caller owns.
 */
async function requirePatient(service: ServiceClient): Promise<Caller | null> {
  const user = await getRequestUser();
  if (!user) return null;

  const { data: profile } = await service
    .from('profiles')
    .select('id, role, first_name, email')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'patient') return null;
  return {
    id:        profile.id as string,
    firstName: (profile.first_name as string | null) ?? '',
    email:     (profile.email as string | null) ?? user.email ?? '',
  };
}

/**
 * Mint this patient's code if they do not have a live one, and return it.
 *
 * Called by the Refer screen on render, so the code exists the first time
 * somebody looks at it rather than requiring a "generate" button — a button
 * whose only possible answer is yes is a step, not a choice.
 *
 * ─── THE COLLISION LOOP ─────────────────────────────────────────────────
 *
 * A code is 39 bits, so a collision is rare and not impossible, and the
 * database is the only thing that can tell us one happened: the unique index
 * on referral_codes.code raises 23505. Reading first and then inserting would
 * be a race with itself. So this INSERTS and retries on a unique violation, a
 * handful of times, and gives up rather than looping for ever.
 *
 * The other unique index — one live code per owner — can also raise 23505,
 * and it means something completely different: a concurrent call already
 * minted this patient's code. That is a success from the caller's point of
 * view, so the retry re-reads before trying again and returns what it finds.
 */
export async function ensureMyReferralCode(): Promise<{ code: string } | { error: string }> {
  const service = svc();
  const caller  = await requirePatient(service);
  if (!caller) return { error: 'Not available for this account.' };

  const existing = await readLiveCode(service, caller.id);
  if (existing) return { code: existing };

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const { error } = await service
      .from('referral_codes')
      .insert({ owner_id: caller.id, code });

    if (!error) return { code };

    // Either index may have raised this, and they mean opposite things.
    const again = await readLiveCode(service, caller.id);
    if (again) return { code: again };

    if (error.code !== '23505') {
      console.error('[referrals] could not mint a code', { error: error.message });
      return { error: 'We could not create your referral code. Please try again.' };
    }
    // A genuine code collision: go round with a different draw.
  }

  console.error('[referrals] five consecutive code collisions — check the generator');
  return { error: 'We could not create your referral code. Please try again.' };
}

async function readLiveCode(service: ServiceClient, ownerId: string): Promise<string | null> {
  const { data } = await service
    .from('referral_codes')
    .select('code')
    .eq('owner_id', ownerId)
    .is('revoked_at', null)
    .maybeSingle();
  return (data?.code as string | undefined) ?? null;
}

/** Both actions spend the same budget. See RATE_LIMITS.referral_invite. */
async function withinInviteBudget(accountId: string): Promise<boolean> {
  return consumeAll('referral_invite', [
    [await clientIp(), RATE_LIMITS.referral_invite.ip],
    [accountId,        RATE_LIMITS.referral_invite.account!],
  ]);
}

export type ReferFriendInput = {
  name:  string;
  email: string;
};

/**
 * Invite a friend by email.
 *
 * The row is written BEFORE the send and stays written if the send fails. A
 * referral we recorded and failed to deliver is recoverable — the customer
 * can share their link instead — and one we refused to record because Resend
 * was down is not.
 */
export async function referAFriend(input: ReferFriendInput): Promise<ReferralActionResult> {
  const service = svc();
  const caller  = await requirePatient(service);
  if (!caller) return { ok: false, error: 'Not available for this account.' };

  const name  = neutraliseFormula((input.name ?? '').trim().slice(0, MAX.name));
  const email = (input.email ?? '').trim().toLowerCase().slice(0, MAX.email);

  if (!isValidEmail(email)) {
    return { ok: false, error: 'Enter a valid email address.', field: 'email' };
  }
  // Refused here as well as by the referrals_not_self CHECK, because the
  // constraint only sees the ATTRIBUTION and this sees the invitation. Someone
  // emailing themselves an invite is not fraud, it is a person testing their
  // own link, and the honest answer is to say so rather than to send it.
  if (email === caller.email.trim().toLowerCase()) {
    return { ok: false, error: 'That is your own email address.', field: 'email' };
  }

  if (!await withinInviteBudget(caller.id)) {
    return {
      ok: false,
      error: 'You have sent a lot of invitations today. Please try again tomorrow.',
    };
  }

  const codeResult = await ensureMyReferralCode();
  if ('error' in codeResult) return { ok: false, error: codeResult.error };

  const expiresAt = new Date(Date.now() + REFERRAL_INVITE_TTL_DAYS * 86_400_000).toISOString();

  const { data: codeRow } = await service
    .from('referral_codes')
    .select('id')
    .eq('code', codeResult.code)
    .maybeSingle();

  const { error } = await service.from('referrals').insert({
    referrer_id:   caller.id,
    code_id:       codeRow?.id ?? null,
    kind:          'patient',
    channel:       'invite',
    status:        'pending',
    invitee_name:  name || null,
    invitee_email: email,
    expires_at:    expiresAt,
  });

  if (error) {
    // The open-invite index. Not an error the customer caused, and telling
    // them they already invited this person is the useful answer — it also
    // confirms nothing they did not already know, since they typed it.
    if (error.code === '23505') {
      return { ok: false, error: 'You have already invited this person.', field: 'email' };
    }
    console.error('[referrals] could not record a friend referral', { error: error.message });
    return { ok: false, error: 'We could not send that invitation. Please try again.' };
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const sent = await sendReferralInviteEmail({
    to:                email,
    referrerFirstName: caller.firstName,
    inviteeFirstName:  name.split(/\s+/)[0] || null,
    link:              referralLink(codeResult.code, appUrl),
  });

  revalidatePath('/patient/refer');

  if (!sent.ok) {
    // Honest, and specific about what IS true: the referral is recorded, so
    // the link still works if they share it themselves.
    console.error('[referrals] invitation email failed', { error: sent.error });
    return {
      ok: true,
      message: 'We saved the invitation but could not send the email. '
        + 'Share your link with them directly and it will still count.',
    };
  }

  return { ok: true, message: `Invitation sent to ${email}.` };
}

export type ReferPracticeInput = {
  practiceName: string;
  contactName:  string;
  email:        string;
  phone:        string;
  suburb:       string;
  note:         string;
};

/**
 * Nominate a practice.
 *
 * This is NOT a self-serve signup — a practice is onboarded by a rep, through
 * the pipeline that already exists. So the action does two writes:
 *
 *   • a crm_leads row with source='referral', which is what a rep works;
 *   • a referrals row pointing at it, which is what the patient sees and what
 *     a future incentive programme would read.
 *
 * The lead is written FIRST. If the referral insert then fails the lead is
 * still there and a rep still gets to call the practice, which is the outcome
 * that matters most; the reverse order would leave a referral pointing at
 * nothing and a practice nobody calls.
 *
 * Deliberately NOT deduplicated against existing leads. Whether this practice
 * is already in the pipeline is a CRM question with its own answer (the
 * dedupe view), and telling a patient "we already know them" would leak who
 * the sales team is talking to.
 */
export async function referAPractice(input: ReferPracticeInput): Promise<ReferralActionResult> {
  const service = svc();
  const caller  = await requirePatient(service);
  if (!caller) return { ok: false, error: 'Not available for this account.' };

  // neutraliseFormula on every free-text field: these rows are exported to CSV
  // from the CRM, and a leading '=' in a practice name is a formula in
  // somebody's spreadsheet. Same treatment the public lead form applies.
  const practiceName = neutraliseFormula((input.practiceName ?? '').trim().slice(0, MAX.practice));
  const contactName  = neutraliseFormula((input.contactName  ?? '').trim().slice(0, MAX.name));
  const suburb       = neutraliseFormula((input.suburb       ?? '').trim().slice(0, MAX.name));
  const note         = neutraliseFormula((input.note         ?? '').trim().slice(0, MAX.note));
  const email        = (input.email ?? '').trim().toLowerCase().slice(0, MAX.email);
  const phoneRaw     = (input.phone ?? '').trim().slice(0, MAX.phone);

  if (!practiceName) {
    return { ok: false, error: 'Tell us the name of the practice.', field: 'practiceName' };
  }
  if (!email && !phoneRaw) {
    return {
      ok: false,
      error: 'Add an email address or a phone number so we can reach them.',
      field: 'email',
    };
  }
  if (email && !isValidEmail(email)) {
    return { ok: false, error: 'Enter a valid email address.', field: 'email' };
  }
  // Landlines allowed — a practice switchboard is exactly the right number.
  if (phoneRaw && !normalizePhoneZA(phoneRaw, { allowLandline: true })) {
    return {
      ok: false,
      error: 'That does not look like a South African phone number.',
      field: 'phone',
    };
  }

  if (!await withinInviteBudget(caller.id)) {
    return {
      ok: false,
      error: 'You have sent a lot of referrals today. Please try again tomorrow.',
    };
  }

  const phone = phoneRaw
    ? normalizePhoneZA(phoneRaw, { allowLandline: true }) ?? phoneRaw
    : null;

  // crm_leads requires a first and last name. A patient may only know "Dr
  // Naidoo", or nothing at all, so this fills what it can and uses the same
  // em-dash placeholder the public lead form uses rather than inventing one.
  const parts     = contactName ? contactName.split(/\s+/) : [];
  const firstName = parts[0] ?? practiceName;
  const lastName  = parts.slice(1).join(' ') || '—';

  const { data: lead, error: leadError } = await service
    .from('crm_leads')
    .insert({
      practice_name:      practiceName,
      contact_first_name: firstName,
      contact_last_name:  lastName,
      email:              email || null,
      phone,
      suburb:             suburb || null,
      source:             'referral',
      stage:              'new',
    })
    .select('id')
    .single();

  if (leadError || !lead) {
    console.error('[referrals] could not create the lead', { error: leadError?.message });
    return { ok: false, error: 'We could not save that referral. Please try again.' };
  }

  // The patient's own words, on the lead a rep opens. Titled so its provenance
  // is unmistakable: this came from a customer, not from research.
  if (note) {
    await service.from('crm_activities').insert({
      lead_id:     lead.id,
      type:        'note',
      title:       'Referred by a patient',
      body:        note,
      occurred_at: new Date().toISOString(),
    });
  }

  const codeResult = await ensureMyReferralCode();
  const codeId = 'code' in codeResult
    ? (await service.from('referral_codes').select('id').eq('code', codeResult.code).maybeSingle())
        .data?.id ?? null
    : null;

  const { error: referralError } = await service.from('referrals').insert({
    referrer_id:   caller.id,
    code_id:       codeId,
    kind:          'practice',
    channel:       'invite',
    status:        'pending',
    practice_name: practiceName,
    invitee_name:  contactName || null,
    invitee_email: email || null,
    invitee_phone: phone,
    note:          note || null,
    crm_lead_id:   lead.id,
  });

  if (referralError) {
    // The lead is already saved, so the practice still gets called. Saying
    // "we could not save it" would be false, and asking them to try again
    // would create a second lead.
    console.error('[referrals] lead saved but referral not recorded', {
      leadId: lead.id, error: referralError.message,
    });
    return {
      ok: true,
      message: `Thanks — we have passed ${practiceName} on to our team.`,
    };
  }

  revalidatePath('/patient/refer');
  revalidatePath('/crm/leads');

  return {
    ok: true,
    message: `Thanks — we will get in touch with ${practiceName}.`,
  };
}
