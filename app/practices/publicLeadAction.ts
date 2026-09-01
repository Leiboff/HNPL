'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { isValidEmail } from '@/lib/validation/email';
import { normalizePhoneZA } from '@/lib/validation';
import { neutraliseFormula } from '@/lib/crm/csv';
import { normalisePhone, normaliseEmail } from '@/lib/crm/dedupe';
import { SPECIALTIES } from '@/lib/specialties';
import { checkAndRecord as checkAndRecordPublicLeadRate } from '@/lib/crm/publicLeadRateLimit';
import { consumeAll, clientIp, RATE_LIMITS } from '@/lib/security/rateLimit';

// ─── Public lead capture — /practices form ───────────────────────────
//
// Called from an anonymous, unauthenticated visitor. Inserts a
// crm_leads row with source='inbound', stage='new' via the service
// role (session clients have no crm RLS access — the action itself is
// the only public write path). NEVER returns a crm read or reveals
// whether a lead already exists (dedupe check is done post-insert via
// the same in-CRM dedupe view; the response to the public caller is
// always ok/rate-limited/invalid).
//
// Abuse controls:
//   • honeypot field (fills → drop silently, appear to succeed)
//   • per-IP rate limit (best-effort, in-memory across the instance)
//   • payload validation (server-authoritative)
//   • formula-injection neutralisation on every string field

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export type PublicLeadInput = {
  practiceName:       string;
  contactName:        string;
  phone:              string;
  email:              string;
  specialty:          string;
  suburb:             string;
  message:            string;
  /** Honeypot — bots fill non-empty; humans leave blank because the
   *  field is hidden with `display: none` on the form. */
  website:            string;
};

export type PublicLeadResult =
  | { ok: true }
  | { ok: false; error: 'rate_limited' | 'invalid' | 'server_error'; field?: string; message?: string };

const SPECIALTY_SET = new Set<string>(SPECIALTIES as readonly string[]);

export async function submitPublicLead(input: PublicLeadInput): Promise<PublicLeadResult> {
  // ── 1. Honeypot — drop silently, look successful to the bot ──
  if (input.website && input.website.trim().length > 0) {
    return { ok: true };
  }

  // ── 2. Rate limit per IP ────────────────────────────────────
  const h  = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim()
          || h.get('x-real-ip')
          || 'anon';
  // Two limiters, on purpose (audit F-17). The in-memory one is kept as a
  // free first line that costs no round trip; the shared one is the one
  // that actually holds, because the in-memory buckets are per-lambda and
  // Vercel gives an attacker a fresh budget on every cold instance — which
  // that module's own header says.
  const withinMemory = checkAndRecordPublicLeadRate(ip);
  const withinShared = await consumeAll('public_lead', [
    [await clientIp(), RATE_LIMITS.public_lead.ip],
  ]);
  if (!withinMemory || !withinShared) {
    return { ok: false, error: 'rate_limited', message: 'Too many submissions from this IP.' };
  }

  // ── 3. Validation ────────────────────────────────────────────
  const practice = neutraliseFormula((input.practiceName ?? '').trim().slice(0, 200));
  const contact  = neutraliseFormula((input.contactName  ?? '').trim().slice(0, 120));
  const suburb   = neutraliseFormula((input.suburb       ?? '').trim().slice(0, 120));
  const message  = neutraliseFormula((input.message      ?? '').trim().slice(0, 2000));
  const email    = (input.email ?? '').trim().toLowerCase().slice(0, 254);
  const phoneRaw = (input.phone ?? '').trim().slice(0, 60);
  const specialty = (input.specialty ?? '').trim().slice(0, 60);

  if (!practice) return { ok: false, error: 'invalid', field: 'practiceName', message: 'Practice name is required.' };
  if (!contact)  return { ok: false, error: 'invalid', field: 'contactName',  message: 'Your name is required.' };
  if (!email && !phoneRaw) {
    return { ok: false, error: 'invalid', field: 'email', message: 'Enter an email or a phone number.' };
  }
  if (email && !isValidEmail(email)) {
    return { ok: false, error: 'invalid', field: 'email', message: 'Enter a valid email address.' };
  }
  if (phoneRaw && !normalizePhoneZA(phoneRaw, { allowLandline: true })) {
    return { ok: false, error: 'invalid', field: 'phone', message: 'Enter a valid South African phone number.' };
  }
  if (specialty && !SPECIALTY_SET.has(specialty)) {
    return { ok: false, error: 'invalid', field: 'specialty', message: 'Unknown specialty.' };
  }

  const phoneNormalised = phoneRaw
    ? normalizePhoneZA(phoneRaw, { allowLandline: true }) ?? phoneRaw
    : null;

  // ── 4. Split contact name into first/last (best-effort) ──────
  const parts = contact.split(/\s+/);
  const firstName = parts[0] ?? contact;
  const lastName  = parts.slice(1).join(' ') || '—';

  // ── 5. Owner assignment (if CRM_INBOUND_OWNER_EMAIL is set) ─
  const s = svc();
  let ownerUserId: string | null = null;
  const ownerEmailEnv = process.env.CRM_INBOUND_OWNER_EMAIL;
  if (ownerEmailEnv) {
    const { data: ownerProfile } = await s
      .from('profiles')
      .select('id, role')
      .ilike('email', ownerEmailEnv.trim().toLowerCase())
      .maybeSingle();
    if (ownerProfile && (ownerProfile.role === 'sales' || ownerProfile.role === 'admin')) {
      ownerUserId = ownerProfile.id as string;
    }
  }

  // ── 6. Insert crm_leads row ─────────────────────────────────
  const insertRow: Record<string, unknown> = {
    practice_name:      practice,
    contact_first_name: firstName,
    contact_last_name:  lastName,
    role_at_practice:   null,
    specialty:          specialty || null,
    phone:              phoneNormalised,
    email:              email || null,
    suburb:             suburb || null,
    source:             'inbound',
    stage:              'new',
    owner_user_id:      ownerUserId,
    created_by:         ownerUserId,   // best available signal — no auth.uid()
  };

  const { data: inserted, error } = await s
    .from('crm_leads')
    .insert(insertRow)
    .select('id')
    .single();
  if (error) {
    console.error('[submitPublicLead] insert failed', error);
    return { ok: false, error: 'server_error', message: 'Could not save. Please try again.' };
  }

  // ── 7. Note the submission message as a public activity ─────
  if (message) {
    await s.from('crm_activities').insert({
      lead_id:    inserted!.id,
      type:       'note',
      title:      'Public form submission',
      body:       message,
      occurred_at: new Date().toISOString(),
      created_by:  ownerUserId,
    });
  }

  revalidatePath('/crm');
  revalidatePath('/crm/leads');

  // Never expose whether this lead collides with an existing row —
  // dedupe surfacing is a CRM-side concern.
  return { ok: true };
}
