'use server';

import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getRequestUser } from '@/lib/auth/requestUser';
import { isValidEmail } from '@/lib/validation/email';
import { normalizePhoneZA } from '@/lib/validation';
import { neutraliseFormula } from '@/lib/crm/csv';
import { splitFullName } from '@/lib/crm/nameSplit';
import { isKnownSpecialty } from '@/lib/specialties';
import { isWithinSouthAfrica } from '@/lib/maps/saBounds';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';
import { generateReferralCode } from '@/lib/referrals/code';
import { REFERRAL_INVITE_TTL_DAYS } from '@/lib/referrals/vocabulary';

// ─── The two writes a patient can make to the referral system ─────────────
//
//   ensureMyReferralCode  mint this patient's code, once
//   referADoctor          nominate a doctor, into the CRM pipeline
//
// There is no third one, and its absence is the point of the current screen:
// referring a FRIEND is the shareable link and nothing else. The code is what
// ties an arriving signup back to the referrer, and app/patient/refer hands
// that code to the share sheet, WhatsApp, email and the clipboard. No server
// action is involved, so a friend referral is written by the CLAIM path
// (lib/referrals/claim.ts) when the friend actually arrives, never by this
// screen speculatively.
//
// BOTH of them run on the service-role client. `referrals` and
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
// ─── THE ACTION THAT USED TO BE HERE ─────────────────────────────────────
//
// `referAFriend` emailed an invitation from a form on the friend side. It was
// removed with that form, not kept "just in case": a 'use server' export is an
// HTTP endpoint whether or not anything renders it, and an endpoint that puts
// mail into an uninvolved person's inbox has no business outliving the UI that
// justified it. Invitations already in the database are unaffected —
// lib/referrals/claim.ts still matches an arriving account onto one, and
// prune_referral_invites() still expires and scrubs them.
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

/**
 * Just the id. The caller's name and address were `referAFriend`'s — it
 * addressed the invitation with one and refused the other as self-dealing —
 * and reading columns nothing uses invites the next person to use them.
 */
type Caller = { id: string };

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
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'patient') return null;
  return { id: profile.id as string };
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

/** See RATE_LIMITS.referral_invite. */
async function withinInviteBudget(accountId: string): Promise<boolean> {
  return consumeAll('referral_invite', [
    [await clientIp(), RATE_LIMITS.referral_invite.ip],
    [accountId,        RATE_LIMITS.referral_invite.account!],
  ]);
}

/**
 * The address, exactly as Google Places handed it to the browser.
 *
 * Every field here is the OUTPUT of a place the person picked from the
 * dropdown — ReferDoctorForm never lets typed-but-unpicked text reach it, for
 * the same reason app/crm/leads/new does not. That makes the shape trusted in
 * the sense that it is well-formed, and untrusted in the sense that a Server
 * Action is an HTTP endpoint and this arrives over the wire, so the action
 * below re-checks the one thing it can check on its own: that the coordinates
 * are inside South Africa.
 */
export type ReferDoctorAddress = {
  formattedAddress: string;
  streetAddress:    string | null;
  suburb:           string | null;
  city:             string | null;
  province:         string | null;
  latitude:         number | null;
  longitude:        number | null;
};

export type ReferDoctorInput = {
  /** Compulsory. */
  doctorName:   string;
  /** Compulsory, and from the shared register — see the validation below. */
  specialty:    string;
  /** Compulsory. Landlines allowed: a practice switchboard is the right number. */
  phone:        string;
  /** Compulsory. Picked from Google Places, never typed free-hand. */
  address:      ReferDoctorAddress;
  practiceName: string;
  email:        string;
  note:         string;
};

const EMPTY_ADDRESS: ReferDoctorAddress = {
  formattedAddress: '', streetAddress: null, suburb: null, city: null,
  province: null, latitude: null, longitude: null,
};

/** A number that arrived over the wire, or null. Refuses NaN and Infinity. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Nominate a doctor.
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
 *
 * ─── DOCTOR, NOT PRACTICE, AND WHY THE ROW STILL SAYS 'practice' ─────────
 *
 * What a patient knows is their doctor. They may not know whether the rooms
 * trade as "Rosebank Dental" or as "Dr A Naidoo Inc", and asking them to
 * supply a practice name they have never read was the single most refusable
 * field on the old form. So the screen asks for the DOCTOR — name, specialty,
 * number, address — and treats the practice name as the optional extra it
 * really is.
 *
 * `referrals.kind` stays 'practice' regardless, and that is deliberate rather
 * than laziness. The kind records what the referral CONVERTS INTO: a merchant
 * on this platform, approved to trade, with a `converted_practice_id` beside
 * it. A doctor is who you ask for; a practice is what signs up. Renaming the
 * enum would mean a migration, a rewrite of the constraint set in 0145, and a
 * backfill — all to make the database agree with a form label rather than
 * with the object it points at.
 *
 * ─── THE FOUR COMPULSORY FIELDS ──────────────────────────────────────────
 *
 * Name, specialty, phone and address. Each is refused server-side as well as
 * in the form, because the form is a screen the caller owns:
 *
 *   name       a lead nobody can be asked for is not workable.
 *   specialty  constrained to lib/specialties.ts rather than accepted as free
 *              text. `crm_leads.specialty` IS free text (bulk imports keep
 *              unrecognised labels verbatim), but the only writer here is a
 *              dropdown, so anything off-register arrived from a crafted
 *              payload and would land in a rep's filters as a value nothing
 *              else in the CRM can match.
 *   phone      the rep's actual next action. This replaces the old
 *              email-or-phone rule: "or" produced leads with an address
 *              nobody answers.
 *   address    what makes a lead findable, dedupable and mappable — the same
 *              three compulsory fields the CRM's own new-lead form demands.
 */
export async function referADoctor(input: ReferDoctorInput): Promise<ReferralActionResult> {
  const service = svc();
  const caller  = await requirePatient(service);
  if (!caller) return { ok: false, error: 'Not available for this account.' };

  // neutraliseFormula on every free-text field: these rows are exported to CSV
  // from the CRM, and a leading '=' in a practice name is a formula in
  // somebody's spreadsheet. Same treatment the public lead form applies.
  const doctorName   = neutraliseFormula((input.doctorName   ?? '').trim().slice(0, MAX.name));
  const practiceName = neutraliseFormula((input.practiceName ?? '').trim().slice(0, MAX.practice));
  const note         = neutraliseFormula((input.note         ?? '').trim().slice(0, MAX.note));
  const specialty    = (input.specialty ?? '').trim().slice(0, MAX.name);
  const email        = (input.email     ?? '').trim().toLowerCase().slice(0, MAX.email);
  const phoneRaw     = (input.phone     ?? '').trim().slice(0, MAX.phone);

  const rawAddress = input.address ?? EMPTY_ADDRESS;
  const address = {
    formattedAddress: neutraliseFormula((rawAddress.formattedAddress ?? '').trim().slice(0, MAX.practice)),
    streetAddress:    neutraliseFormula((rawAddress.streetAddress    ?? '').trim().slice(0, MAX.practice)),
    suburb:           neutraliseFormula((rawAddress.suburb           ?? '').trim().slice(0, MAX.name)),
    city:             neutraliseFormula((rawAddress.city             ?? '').trim().slice(0, MAX.name)),
    province:         neutraliseFormula((rawAddress.province         ?? '').trim().slice(0, MAX.name)),
    latitude:         finiteOrNull(rawAddress.latitude),
    longitude:        finiteOrNull(rawAddress.longitude),
  };

  if (!doctorName) {
    return { ok: false, error: "Tell us the doctor's name.", field: 'doctorName' };
  }
  // Off-register is refused rather than kept verbatim: see the note above.
  if (!isKnownSpecialty(specialty)) {
    return { ok: false, error: 'Choose a specialty from the list.', field: 'specialty' };
  }
  if (!phoneRaw) {
    return { ok: false, error: 'Add a phone number so we can reach them.', field: 'phone' };
  }
  // Landlines allowed — a practice switchboard is exactly the right number.
  const phone = normalizePhoneZA(phoneRaw, { allowLandline: true });
  if (!phone) {
    return {
      ok: false,
      error: 'That does not look like a South African phone number.',
      field: 'phone',
    };
  }
  if (!address.formattedAddress) {
    return {
      ok: false,
      error: 'Pick their address from the suggestions.',
      field: 'address',
    };
  }
  // A picked place always carries coordinates, so a pair that is present and
  // outside the country came from somewhere other than the dropdown — or from
  // a doctor we cannot onboard. Either way, pinning a lead on the wrong
  // continent is the failure lib/maps/saBounds.ts exists to prevent.
  if (address.latitude !== null && address.longitude !== null
      && !isWithinSouthAfrica(address.latitude, address.longitude)) {
    return {
      ok: false,
      error: 'We can only take referrals for practices in South Africa.',
      field: 'address',
    };
  }
  // Optional, but a malformed one is worth saying rather than storing.
  if (email && !isValidEmail(email)) {
    return { ok: false, error: 'Enter a valid email address.', field: 'email' };
  }

  if (!await withinInviteBudget(caller.id)) {
    return {
      ok: false,
      error: 'You have sent a lot of referrals today. Please try again tomorrow.',
    };
  }

  // crm_leads requires a first AND a last name (0069). splitFullName strips a
  // leading title and, for a single remaining token, puts it in BOTH columns —
  // right for the bulk imports it was written for, and here it would render
  // "Naidoo Naidoo" on the lead. So a one-word name is carried by the surname
  // alone, which contactDisplayName then renders as itself.
  const split      = splitFullName(doctorName);
  const sameToken  = split.firstName === split.lastName;
  const firstName  = sameToken ? '' : split.firstName;
  const lastName   = split.lastName;

  // crm_leads.practice_name and the referrals_practice_named CHECK in 0145 are
  // both NOT NULL, and the patient may genuinely not know what the rooms are
  // called. The doctor's name is the honest stand-in: it is what the rep will
  // ask for on the phone, and it is never a name we invented.
  const leadPracticeName = practiceName || doctorName;

  // Referral leads use the same configured owner as the public inbound form.
  // Sales RLS only exposes owned leads, so leaving this assignment implicit
  // would create work that ordinary reps cannot see.
  let ownerUserId: string | null = null;
  const ownerEmailEnv = process.env.CRM_INBOUND_OWNER_EMAIL;
  if (ownerEmailEnv) {
    const { data: ownerProfile } = await service
      .from('profiles')
      .select('id, role')
      .ilike('email', ownerEmailEnv.trim().toLowerCase())
      .maybeSingle();
    if (ownerProfile && (ownerProfile.role === 'sales' || ownerProfile.role === 'admin')) {
      ownerUserId = ownerProfile.id as string;
    }
  }

  const { data: lead, error: leadError } = await service
    .from('crm_leads')
    .insert({
      practice_name:      leadPracticeName,
      contact_first_name: firstName,
      contact_last_name:  lastName,
      specialty,
      email:              email || null,
      phone,
      street_address:     address.streetAddress || null,
      suburb:             address.suburb        || null,
      city:               address.city          || null,
      province:           address.province      || null,
      latitude:           address.latitude,
      longitude:          address.longitude,
      formatted_address:  address.formattedAddress,
      source:             'referral',
      stage:              'new',
      owner_user_id:      ownerUserId,
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
  const expiresAt = new Date(Date.now() + REFERRAL_INVITE_TTL_DAYS * 86_400_000).toISOString();

  const { error: referralError } = await service.from('referrals').insert({
    referrer_id:   caller.id,
    code_id:       codeId,
    kind:          'practice',
    channel:       'invite',
    status:        'pending',
    practice_name: leadPracticeName,
    invitee_name:  doctorName,
    invitee_email: email || null,
    invitee_phone: phone,
    note:          note || null,
    crm_lead_id:   lead.id,
    expires_at:    expiresAt,
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
      message: `Thanks — we have passed ${doctorName} on to our team.`,
    };
  }

  revalidatePath('/patient/refer');
  revalidatePath('/crm/leads');

  return {
    ok: true,
    message: `Thanks — we will get in touch with ${doctorName}.`,
  };
}
