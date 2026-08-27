'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// ─── crm_lead_contacts — CRUD + promote-primary ──────────────────────
//
// The primary contact's name / role / phone / email fields mirror the
// parent lead's contact_* columns via DB triggers (see 0075). Every
// existing consumer (dedupe, CSV import, public /practices form,
// compose prefill, list search, board card, inbound tray) keeps
// reading from crm_leads unchanged.

export type LeadContact = {
  id:                 string;
  lead_id:            string;
  first_name:         string;
  last_name:          string;
  role_at_practice:   string | null;
  phone:              string | null;
  email:              string | null;
  is_primary:         boolean;
  interest:           'unknown' | 'cold' | 'warm' | 'hot';
  is_decision_maker:  boolean;
  hpcsa_number:       string | null;
  hpcsa_group_key:    string | null;
  notes:              string | null;
  created_at:         string;
  updated_at:         string;
};

const CONTACT_SELECT = 'id, lead_id, first_name, last_name, role_at_practice, phone, email, is_primary, interest, is_decision_maker, hpcsa_number, hpcsa_group_key, notes, created_at, updated_at';

type Guard =
  | { ok: true;  userId: string; role: 'sales' | 'admin' }
  | { ok: false; error: string };

async function guardSalesOrAdmin(): Promise<Guard> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false, error: 'Unauthorized.' };
  return { ok: true, userId: user.id, role: profile.role as 'sales' | 'admin' };
}

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length ? t : null;
}

// ── addContact ──────────────────────────────────────────────────────

export type AddContactInput = {
  lead_id:            string;
  first_name:         string;
  last_name:          string;
  role_at_practice?:  string | null;
  phone?:             string | null;
  email?:             string | null;
  notes?:             string | null;
  is_primary?:        boolean;
  interest?:          'unknown' | 'cold' | 'warm' | 'hot';
  is_decision_maker?: boolean;
  hpcsa_number?:      string | null;
};

export async function addContact(input: AddContactInput): Promise<{ error?: string; contact?: LeadContact }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };

  if (!input.first_name?.trim()) return { error: 'First name is required.' };
  if (!input.last_name?.trim())  return { error: 'Last name is required.' };

  const supabase = await createClient();

  // If the caller asked for is_primary, demote any current primary
  // FIRST so the unique partial index doesn't conflict.
  if (input.is_primary) {
    await supabase
      .from('crm_lead_contacts')
      .update({ is_primary: false })
      .eq('lead_id', input.lead_id)
      .eq('is_primary', true);
  }

  const row = {
    lead_id:            input.lead_id,
    first_name:         input.first_name.trim(),
    last_name:          input.last_name.trim(),
    role_at_practice:   trimOrNull(input.role_at_practice ?? null),
    phone:              trimOrNull(input.phone ?? null),
    email:              trimOrNull(input.email ?? null)?.toLowerCase() ?? null,
    notes:              trimOrNull(input.notes ?? null),
    is_primary:         !!input.is_primary,
    interest:           input.interest ?? 'unknown',
    is_decision_maker:  !!input.is_decision_maker,
    hpcsa_number:       trimOrNull(input.hpcsa_number ?? null),
    created_by:         g.userId,
  };

  const { data, error } = await supabase
    .from('crm_lead_contacts')
    .insert(row)
    .select(CONTACT_SELECT)
    .single();
  if (error) return { error: error.message };

  revalidatePath(`/crm/leads/${input.lead_id}`);
  return { contact: data as LeadContact };
}

// ── updateContact ───────────────────────────────────────────────────

export type UpdateContactInput = {
  id:                 string;
  lead_id:            string;
  first_name?:        string;
  last_name?:         string;
  role_at_practice?:  string | null;
  phone?:             string | null;
  email?:             string | null;
  notes?:             string | null;
  interest?:          'unknown' | 'cold' | 'warm' | 'hot';
  is_decision_maker?: boolean;
  hpcsa_number?:      string | null;
};

export async function updateContact(input: UpdateContactInput): Promise<{ error?: string; contact?: LeadContact }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };

  const patch: Record<string, unknown> = {};
  if (input.first_name !== undefined) {
    if (!input.first_name.trim()) return { error: 'First name is required.' };
    patch.first_name = input.first_name.trim();
  }
  if (input.last_name !== undefined) {
    if (!input.last_name.trim()) return { error: 'Last name is required.' };
    patch.last_name = input.last_name.trim();
  }
  if (input.role_at_practice !== undefined) patch.role_at_practice = trimOrNull(input.role_at_practice);
  if (input.phone !== undefined)            patch.phone            = trimOrNull(input.phone);
  if (input.email !== undefined) {
    const e = trimOrNull(input.email);
    patch.email = e ? e.toLowerCase() : null;
  }
  if (input.notes !== undefined)            patch.notes            = trimOrNull(input.notes);
  if (input.interest !== undefined)         patch.interest         = input.interest;
  if (input.is_decision_maker !== undefined) patch.is_decision_maker = input.is_decision_maker;
  if (input.hpcsa_number !== undefined)     patch.hpcsa_number      = trimOrNull(input.hpcsa_number);

  if (Object.keys(patch).length === 0) return { error: 'No changes to save.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('crm_lead_contacts')
    .update(patch)
    .eq('id', input.id)
    .eq('lead_id', input.lead_id)
    .select(CONTACT_SELECT)
    .single();
  if (error) return { error: error.message };

  revalidatePath(`/crm/leads/${input.lead_id}`);
  return { contact: data as LeadContact };
}

// ── promotePrimary ──────────────────────────────────────────────────

export async function promotePrimary(input: { id: string; lead_id: string }): Promise<{ error?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };

  const supabase = await createClient();

  // Demote the current primary first (partial unique index).
  const { error: demErr } = await supabase
    .from('crm_lead_contacts')
    .update({ is_primary: false })
    .eq('lead_id', input.lead_id)
    .eq('is_primary', true)
    .neq('id', input.id);
  if (demErr) return { error: demErr.message };

  const { error } = await supabase
    .from('crm_lead_contacts')
    .update({ is_primary: true })
    .eq('id', input.id)
    .eq('lead_id', input.lead_id);
  if (error) return { error: error.message };

  revalidatePath(`/crm/leads/${input.lead_id}`);
  return {};
}

// ── removeContact ───────────────────────────────────────────────────
//
// The DB trigger (0075) rejects a delete that would leave zero contacts
// OR that would leave the lead with no primary. The caller must promote
// another contact first when removing the current primary.

export async function removeContact(input: { id: string; lead_id: string }): Promise<{ error?: string }> {
  const g = await guardSalesOrAdmin();
  if (!g.ok) return { error: g.error };

  const supabase = await createClient();
  const { error } = await supabase
    .from('crm_lead_contacts')
    .delete()
    .eq('id', input.id)
    .eq('lead_id', input.lead_id);
  if (error) return { error: error.message };

  revalidatePath(`/crm/leads/${input.lead_id}`);
  return {};
}
