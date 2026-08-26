'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { findLeadCollisions, normaliseEmail, normalisePhone } from '@/lib/crm/dedupe';
import { buildLeadCalendarLink } from '@/lib/crm/calendarLink';
import { sastLocalToUtc } from '@/lib/crm/timezone';

// ─── Server-side guard: sales OR admin ───────────────────────────────
//
// The only two profile roles allowed to mutate CRM data. Mirrors the
// admin/practices guardAdmin pattern; sole authz layer on every CRM
// write. RLS on crm_leads / crm_activities enforces the same rule at
// the DB layer — the guard here surfaces a clean error message before
// PostgREST rejects on RLS.

type GuardOk  = { ok: true;  userId: string; role: 'sales' | 'admin' };
type GuardErr = { ok: false; error:  string };

async function guardSalesOrAdmin(): Promise<GuardOk | GuardErr> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    return { ok: false, error: 'Unauthorized.' };
  }
  return { ok: true, userId: user.id, role: profile.role as 'sales' | 'admin' };
}

// ─── Input shapes ────────────────────────────────────────────────────

export type CreateLeadInput = {
  practice_name:              string;
  contact_first_name:         string;
  contact_last_name:          string;
  role_at_practice?:          string | null;
  specialty?:                 string | null;
  phone?:                     string | null;
  email?:                     string | null;
  street_address?:            string | null;
  suburb?:                    string | null;
  city?:                      string | null;
  province?:                  string | null;
  latitude?:                  number | null;
  longitude?:                 number | null;
  formatted_address?:         string | null;
  source?:                    string;
  owner_user_id?:             string | null;
  next_follow_up_at?:         string | null;   // ISO
  estimated_monthly_billings?: number | null;
  confirmDupe?:               boolean;         // set to true to bypass the dedupe warning
};

const SOURCES = new Set(['referral', 'cold_outreach', 'inbound', 'event', 'other']);
const STAGES  = new Set([
  'new', 'contacted', 'meeting_scheduled', 'demo_done',
  'agreement_sent', 'signed', 'onboarded', 'lost',
]);

export type CreateLeadResult = {
  error?:      string;
  leadId?:     string;
  duplicates?: Array<{ id: string; practice_name: string }>;  // only present if dedupe warned + not confirmed
};

export async function createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!input.practice_name?.trim())      return { error: 'Practice name is required.' };
  if (!input.contact_first_name?.trim()) return { error: 'Contact first name is required.' };
  if (!input.contact_last_name?.trim())  return { error: 'Contact last name is required.' };

  const source = (input.source ?? 'other').toLowerCase();
  if (!SOURCES.has(source)) return { error: `Invalid source: ${source}` };

  const supabase = await createClient();

  // ── Dedupe: phone OR email match against existing leads ────────
  const probe = { phone: input.phone ?? null, email: input.email ?? null };
  if (probe.phone || probe.email) {
    const orClauses: string[] = [];
    const nPhone = normalisePhone(probe.phone);
    const nEmail = normaliseEmail(probe.email);
    if (nPhone) orClauses.push(`phone.eq.${nPhone}`);
    if (nEmail) orClauses.push(`email.ilike.${nEmail}`);

    if (orClauses.length > 0) {
      const { data: candidates } = await supabase
        .from('crm_leads')
        .select('id, practice_name, phone, email')
        .or(orClauses.join(','))
        .limit(50);

      const cols = findLeadCollisions(probe, (candidates ?? []) as Array<{ id: string; practice_name: string; phone: string | null; email: string | null }>);
      if (cols.length > 0 && !input.confirmDupe) {
        return {
          duplicates: cols.map(c => ({ id: c.id, practice_name: c.practice_name })),
        };
      }
    }
  }

  const insertRow = {
    practice_name:              input.practice_name.trim(),
    contact_first_name:         input.contact_first_name.trim(),
    contact_last_name:          input.contact_last_name.trim(),
    role_at_practice:           input.role_at_practice?.trim()  || null,
    specialty:                  input.specialty?.trim()          || null,
    phone:                      input.phone?.trim()              || null,
    email:                      input.email?.trim().toLowerCase() || null,
    street_address:             input.street_address?.trim()     || null,
    suburb:                     input.suburb?.trim()             || null,
    city:                       input.city?.trim()               || null,
    province:                   input.province?.trim()           || null,
    latitude:                   input.latitude  ?? null,
    longitude:                  input.longitude ?? null,
    formatted_address:          input.formatted_address ?? null,
    source,
    stage:                      'new' as const,
    owner_user_id:              input.owner_user_id ?? guard.userId,
    created_by:                 guard.userId,
    next_follow_up_at:          input.next_follow_up_at ?? null,
    estimated_monthly_billings: input.estimated_monthly_billings ?? null,
  };

  const { data: lead, error } = await supabase
    .from('crm_leads')
    .insert(insertRow)
    .select('id')
    .single();

  if (error || !lead) return { error: error?.message ?? 'Insert failed.' };

  revalidatePath('/crm');
  revalidatePath('/crm/leads');
  revalidatePath('/crm/board');
  return { leadId: lead.id };
}

// ─── updateLead ─────────────────────────────────────────────────────

export type UpdateLeadFields = Partial<Omit<CreateLeadInput, 'confirmDupe'>> & {
  stage?:        string;
  lost_reason?:  string | null;
};

export async function updateLead(id: string, fields: UpdateLeadFields): Promise<{ error?: string }> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };

  const patch: Record<string, unknown> = {};
  const passthrough = [
    'practice_name', 'contact_first_name', 'contact_last_name', 'role_at_practice',
    'specialty', 'phone', 'email', 'street_address', 'suburb', 'city', 'province',
    'latitude', 'longitude', 'formatted_address',
    'owner_user_id', 'next_follow_up_at', 'lost_reason', 'estimated_monthly_billings',
  ] as const;
  for (const key of passthrough) {
    if (key in fields) patch[key] = (fields as Record<string, unknown>)[key] ?? null;
  }
  if (fields.source !== undefined) {
    const s = (fields.source ?? 'other').toLowerCase();
    if (!SOURCES.has(s)) return { error: `Invalid source: ${s}` };
    patch.source = s;
  }
  if (fields.stage !== undefined) {
    if (!STAGES.has(fields.stage)) return { error: `Invalid stage: ${fields.stage}` };
    patch.stage = fields.stage;
  }

  const supabase = await createClient();
  const { error } = await supabase.from('crm_leads').update(patch).eq('id', id);
  if (error) return { error: error.message };

  revalidatePath(`/crm/leads/${id}`);
  revalidatePath('/crm/leads');
  revalidatePath('/crm/board');
  revalidatePath('/crm');
  return {};
}

// ─── bulkAssignOwner — reassign a batch of leads from the leads list ──
//
// RLS is the real enforcement: a sales caller's UPDATE only touches
// rows they already own (USING), and can set the new owner to anyone
// (WITH CHECK doesn't re-require the new owner be them — see
// 0113_crm_leads_owner_scoped_rls.sql). So a sales rep can hand off
// leads they own; they cannot touch a teammate's row even if it's
// included in leadIds — that row is silently skipped by RLS, which is
// why `updated` can be less than leadIds.length without an error.

export async function bulkAssignOwner(
  leadIds: string[],
  ownerId: string,
): Promise<{ error?: string; updated?: number }> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };
  if (leadIds.length === 0) return { updated: 0 };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('crm_leads')
    .update({ owner_user_id: ownerId })
    .in('id', leadIds)
    .select('id');
  if (error) return { error: error.message };

  revalidatePath('/crm/leads');
  revalidatePath('/crm/board');
  revalidatePath('/crm');
  return { updated: data?.length ?? 0 };
}

// ─── moveLeadStage — used by the board drag and by detail buttons ────

const LOST_REASONS = new Set([
  'price', 'uses_competitor', 'no_need', 'no_decision_maker',
  'unresponsive', 'not_eligible', 'other',
]);

export async function moveLeadStage(
  id:          string,
  toStage:     string,
  lostReason?: string,
  note?:       string,
): Promise<{ error?: string }> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };
  if (!STAGES.has(toStage)) return { error: `Invalid stage: ${toStage}` };
  if (toStage === 'lost' && (!lostReason || !LOST_REASONS.has(lostReason))) {
    return { error: 'A lost reason is required when moving a lead to lost.' };
  }

  const supabase = await createClient();

  const patch: Record<string, unknown> = { stage: toStage };
  if (toStage === 'lost') {
    patch.lost_reason = lostReason;
    patch.lost_note   = note?.trim() || null;
  }

  const { error } = await supabase.from('crm_leads').update(patch).eq('id', id);
  if (error) return { error: error.message };

  // Optional note in addition to the auto stage_change activity.
  if (note && note.trim()) {
    await supabase.from('crm_activities').insert({
      lead_id: id,
      type: 'note',
      title: 'Note',
      body:  note.trim(),
      created_by: guard.userId,
    });
  }

  revalidatePath(`/crm/leads/${id}`);
  revalidatePath('/crm/board');
  revalidatePath('/crm/leads');
  revalidatePath('/crm');
  return {};
}

// ─── logActivity — quick-add call / meeting / whatsapp / email / note ─

export type LogActivityInput = {
  lead_id: string;
  type:    'call' | 'meeting' | 'whatsapp' | 'email' | 'note';
  title?:  string;
  body?:   string;
  occurred_at?: string;   // ISO; defaults to now on server
};

const LOGGABLE_TYPES = new Set(['call', 'meeting', 'whatsapp', 'email', 'note']);

export async function logActivity(input: LogActivityInput): Promise<{ error?: string }> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };
  if (!LOGGABLE_TYPES.has(input.type)) return { error: `Invalid type: ${input.type}` };

  const supabase = await createClient();

  const titleFallback = {
    call:     'Call',
    meeting:  'Meeting',
    whatsapp: 'WhatsApp',
    email:    'Email',
    note:     'Note',
  }[input.type];

  const { error } = await supabase.from('crm_activities').insert({
    lead_id:    input.lead_id,
    type:       input.type,
    title:      input.title?.trim()  || titleFallback,
    body:       input.body?.trim()   || null,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    created_by: guard.userId,
  });
  if (error) return { error: error.message };

  revalidatePath(`/crm/leads/${input.lead_id}`);
  revalidatePath('/crm');
  return {};
}

// ─── scheduleFollowup — schedule call/meeting + calendar deep link ────

export type ScheduleFollowupInput = {
  lead_id:         string;
  local_date:      string;   // YYYY-MM-DD (SAST)
  local_time:      string;   // HH:MM     (SAST)
  duration_min:    number;
  type:            'call' | 'meeting';
  override_title?: string;
  notes?:          string;
};

export async function scheduleFollowup(input: ScheduleFollowupInput): Promise<{
  error?:        string;
  calendarUrl?:  string;
}> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.local_date)) return { error: 'Invalid date.' };
  if (!/^\d{2}:\d{2}$/.test(input.local_time))       return { error: 'Invalid time.' };
  if (input.duration_min <= 0 || input.duration_min > 480) {
    return { error: 'Duration must be between 1 and 480 minutes.' };
  }

  const startUtc = sastLocalToUtc(input.local_date, input.local_time);
  if (Number.isNaN(startUtc.getTime())) return { error: 'Could not parse the scheduled time.' };

  const supabase = await createClient();

  const { data: lead, error: leadErr } = await supabase
    .from('crm_leads')
    .select('id, practice_name, contact_first_name, contact_last_name, phone')
    .eq('id', input.lead_id)
    .single();
  if (leadErr || !lead) return { error: leadErr?.message ?? 'Lead not found.' };

  const contactName = [lead.contact_first_name, lead.contact_last_name].filter(Boolean).join(' ');
  const calendarUrl = buildLeadCalendarLink({
    practiceName:   lead.practice_name,
    contactName:    contactName || null,
    contactPhone:   lead.phone,
    startUtc,
    durationMin:    input.duration_min,
    overrideTitle:  input.override_title,
    notes:          input.notes,
  });

  const title = input.override_title?.trim() || `betternow intro — ${lead.practice_name}`;

  const { error: actErr } = await supabase.from('crm_activities').insert({
    lead_id:     input.lead_id,
    type:        input.type,
    title:       'Scheduled: ' + title,
    body:        input.notes?.trim() || null,
    occurred_at: startUtc.toISOString(),
    created_by:  guard.userId,
  });
  if (actErr) return { error: actErr.message };

  const stageBump = input.type === 'meeting' ? 'meeting_scheduled' : undefined;
  const patch: Record<string, unknown> = { next_follow_up_at: startUtc.toISOString() };
  if (stageBump) patch.stage = stageBump;

  const { error: updErr } = await supabase.from('crm_leads').update(patch).eq('id', input.lead_id);
  if (updErr) return { error: updErr.message };

  revalidatePath(`/crm/leads/${input.lead_id}`);
  revalidatePath('/crm');
  return { calendarUrl };
}

// ─── markFollowupDone — "done → schedule next" one-click flow ─────────

export async function markFollowupDone(
  leadId:     string,
  nextIsoUtc: string | null,
  note?:      string,
): Promise<{ error?: string }> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  await supabase.from('crm_activities').insert({
    lead_id:    leadId,
    type:       'call',       // most touches are calls; sales can override with logActivity if needed
    title:      'Follow-up done',
    body:       note?.trim() || null,
    created_by: guard.userId,
  });

  const { error } = await supabase
    .from('crm_leads')
    .update({ next_follow_up_at: nextIsoUtc })
    .eq('id', leadId);
  if (error) return { error: error.message };

  revalidatePath('/crm');
  revalidatePath(`/crm/leads/${leadId}`);
  return {};
}

// ─── markSigned — create a practice_invitation, move stage to 'signed' ─
//
// Accepts an optional contactId picked in the invite sheet — the
// invite carries THAT contact's name/phone as the "who to expect to
// sign up" (defaults to the primary contact if omitted). The invite's
// locked email is always the chosen contact's email. Since 0075 also
// prefills street/suburb/city/province onto /signup/practice.

export async function markSigned(leadId: string, opts?: { contactId?: string | null }): Promise<{
  error?:     string;
  inviteUrl?: string;
  recipientEmail?: string;
  recipientName?:  string;
}> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();

  const { data: lead } = await supabase
    .from('crm_leads')
    .select('id, practice_name, contact_first_name, contact_last_name, email, phone, specialty, stage, converted_practice_id, street_address, suburb, city, province')
    .eq('id', leadId)
    .single();
  if (!lead) return { error: 'Lead not found.' };
  if (lead.converted_practice_id) return { error: 'Lead already converted to a practice.' };

  // Resolve the recipient contact — either the requested one, or the
  // lead's current primary (which mirrors the lead columns).
  let recipient: {
    id:         string;
    first_name: string;
    last_name:  string;
    phone:      string | null;
    email:      string | null;
  } | null = null;

  if (opts?.contactId) {
    const { data: contact } = await supabase
      .from('crm_lead_contacts')
      .select('id, first_name, last_name, phone, email')
      .eq('id', opts.contactId)
      .eq('lead_id', leadId)
      .maybeSingle();
    recipient = (contact ?? null) as typeof recipient;
    if (!recipient) return { error: 'Chosen contact not found on this lead.' };
  } else {
    const { data: primary } = await supabase
      .from('crm_lead_contacts')
      .select('id, first_name, last_name, phone, email')
      .eq('lead_id', leadId)
      .eq('is_primary', true)
      .maybeSingle();
    // Fallback for the very-first-run edge case where the backfill has
    // not seeded a primary yet — read straight off the lead columns.
    recipient = (primary as typeof recipient) ?? {
      id:         '',
      first_name: lead.contact_first_name,
      last_name:  lead.contact_last_name,
      phone:      lead.phone,
      email:      lead.email,
    };
  }

  if (!recipient.email) {
    return { error: 'The chosen contact needs an email address to send the practice invite.' };
  }

  // Idempotency: if an active (unexpired, unaccepted) invite already
  // exists for this lead, reuse its token instead of creating another.
  const { data: existing } = await supabase
    .from('practice_invitations')
    .select('token, expires_at, accepted_at')
    .eq('lead_id', leadId)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  let token: string;
  if (existing?.token) {
    token = existing.token;
  } else {
    token = randomBytes(32).toString('hex');

    const { error: invErr } = await supabase.from('practice_invitations').insert({
      email:              recipient.email,
      practice_name:      lead.practice_name,
      contact_first_name: recipient.first_name,
      contact_last_name:  recipient.last_name,
      phone:              recipient.phone,
      specialty:          lead.specialty,
      street_address:     lead.street_address,
      suburb:             lead.suburb,
      city:               lead.city,
      province:           lead.province,
      lead_id:            leadId,
      invited_by:         guard.userId,
      token,
    });
    if (invErr) return { error: invErr.message };
  }

  if (lead.stage !== 'signed') {
    const { error: stErr } = await supabase.from('crm_leads').update({ stage: 'signed' }).eq('id', leadId);
    if (stErr) return { error: stErr.message };
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const inviteUrl = `${base}/signup/practice?token=${token}`;

  revalidatePath(`/crm/leads/${leadId}`);
  revalidatePath('/crm/board');
  return {
    inviteUrl,
    recipientEmail: recipient.email,
    recipientName:  `${recipient.first_name} ${recipient.last_name}`.trim(),
  };
}
