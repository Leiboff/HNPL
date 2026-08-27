'use server';

import { createClient } from '@/lib/supabase/server';
import { ENABLE_CRM_ADDRESS_SUGGESTIONS } from '@/lib/featureFlags';
import {
  rankAddressMatches, excludeDismissed, orderedLeadPair,
  type LeadForAddressMatch, type AddressMatchSuggestion,
} from '@/lib/crm/addressMatch';

// ─── Address/duplicate-practice suggestions — server actions ─────────
//
// Behind ENABLE_CRM_ADDRESS_SUGGESTIONS (default OFF). Candidates are
// found via the indexed address_match_key or a shared normalised
// building name — a coarse SQL filter — then ranked precisely by
// lib/crm/addressMatch.ts comparing the structured fields directly.
// NEVER auto-merge: this only ever returns suggestions for a human to
// act on (extends lib/crm/dedupe.ts's warn-and-confirm philosophy).

const LEAD_MATCH_SELECT =
  'id, practice_name, building_name, unit, landline, street_address, formatted_address, suburb, latitude, longitude';

async function guardSalesOrAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: 'Not authenticated.' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'sales' && profile?.role !== 'admin') return { ok: false as const, error: 'Unauthorized.' };
  return { ok: true as const, userId: user.id };
}

export async function getAddressSuggestions(leadId: string): Promise<AddressMatchSuggestion[]> {
  if (!ENABLE_CRM_ADDRESS_SUGGESTIONS) return [];
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return [];

  const supabase = await createClient();
  const { data: lead } = await supabase
    .from('crm_leads')
    .select(`${LEAD_MATCH_SELECT}, address_match_key`)
    .eq('id', leadId)
    .maybeSingle();
  if (!lead) return [];

  const orClauses: string[] = [];
  if (lead.address_match_key) orClauses.push(`address_match_key.eq.${lead.address_match_key}`);
  if (lead.building_name)     orClauses.push(`building_name.ilike.${lead.building_name}`);
  if (lead.landline)          orClauses.push(`landline.ilike.${lead.landline}`);
  if (orClauses.length === 0) return [];

  const { data: candidates } = await supabase
    .from('crm_leads')
    .select(LEAD_MATCH_SELECT)
    .is('archived_at', null)
    .neq('id', leadId)
    .or(orClauses.join(','))
    .limit(50);

  const ranked = rankAddressMatches(lead as LeadForAddressMatch, (candidates ?? []) as LeadForAddressMatch[]);
  if (ranked.length === 0) return [];

  const otherIds = ranked.map(r => r.otherLeadId);
  const pairs = otherIds.map(id => orderedLeadPair(leadId, id));
  const { data: dismissedRows } = await supabase
    .from('crm_suggestion_dismissals')
    .select('lead_a_id, lead_b_id, kind')
    .in('lead_a_id', Array.from(new Set(pairs.map(p => p[0]))));

  return excludeDismissed(leadId, ranked, (dismissedRows ?? []) as Array<{ lead_a_id: string; lead_b_id: string; kind: 'duplicate_practice' | 'prospecting_hint' }>);
}

export async function dismissAddressSuggestion(
  leadId: string,
  otherLeadId: string,
  kind: 'duplicate_practice' | 'prospecting_hint',
): Promise<{ error?: string }> {
  const guard = await guardSalesOrAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createClient();
  const [lead_a_id, lead_b_id] = orderedLeadPair(leadId, otherLeadId);
  const { error } = await supabase
    .from('crm_suggestion_dismissals')
    .insert({ lead_a_id, lead_b_id, kind, dismissed_by: guard.userId });
  // A duplicate dismissal (unique index) is not an error from the
  // caller's point of view — the pair is already dismissed either way.
  if (error && !/duplicate key/i.test(error.message)) return { error: error.message };
  return {};
}
