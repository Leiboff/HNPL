// ─── Address / duplicate-practice matching — pure, tested ─────────────
//
// Extends the warn-and-confirm philosophy of lib/crm/dedupe.ts (never
// auto-merge — surface a signal, let the rep decide) to buildings and
// units rather than phone/email. Behind ENABLE_CRM_ADDRESS_SUGGESTIONS
// (lib/featureFlags.ts), default OFF.
//
// CRITICAL: same-building-different-unit is LOW confidence, never
// reported as a duplicate. SA medical buildings (Life Fourways, Netcare
// Sunninghill, Morningside Mediclinic) hold dozens of unrelated
// practices — a building-level match presented as a duplicate trains
// reps to ignore the banner.

import { normalisePhone } from './dedupe';
import { haversineKm } from './mapPlanner';

const ABBREVIATIONS: Record<string, string> = {
  st:   'street',
  rd:   'road',
  dr:   'drive',
  ave:  'avenue',
  blvd: 'boulevard',
  cnr:  'corner',
  ext:  'extension',
};

const NOISE_WORDS = new Set(['hospital', 'medical', 'centre', 'center', 'complex', 'park', 'the']);

/**
 * Lowercase, strip punctuation, expand common street abbreviations,
 * drop noise words ("Life Fourways Hospital" and "Life Fourways" match).
 */
export function normaliseAddress(raw: string | null | undefined): string {
  if (!raw) return '';
  const stripped = raw.toLowerCase().replace(/[^\w\s]/g, ' ');
  const words = stripped
    .split(/\s+/)
    .filter(Boolean)
    .map(w => ABBREVIATIONS[w] ?? w)
    .filter(w => !NOISE_WORDS.has(w));
  return words.join(' ').trim();
}

/**
 * "Suite 204" / "Ste 204" / "Unit 204" / "#204" / "204" all collapse to
 * "204". Returns null for blank input.
 */
export function normaliseUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/^(?:suite|ste|unit|#)?\s*[.:#-]?\s*(\w+)$/i);
  const unit = m ? m[1] : t;
  return unit.toLowerCase();
}

/**
 * Reuses lib/crm/dedupe.ts's digit-stripping normalisePhone, then folds
 * to the canonical form 0042_normalize_phone_values.sql established
 * (leading '27', no '+' — matching how this module compares digit
 * strings rather than storage format): '011 234 5678', '0112345678',
 * '27112345678', and '+27 11 234 5678' all become '27112345678'.
 */
export function normaliseLandline(raw: string | null | undefined): string | null {
  const digits = normalisePhone(raw);
  if (!digits) return null;
  if (digits.startsWith('27')) return digits;
  if (digits.startsWith('0'))  return '27' + digits.slice(1);
  return digits;
}

export type AddressMatchLead = {
  street_address:    string | null;
  formatted_address?: string | null;
  suburb:            string | null;
};

/**
 * Coarse indexable key — NOT the source of the confidence signals
 * below (those compare structured fields directly). Just enough to
 * find candidate leads sharing a normalised street+suburb via the
 * address_match_key index. Stored by a BEFORE INSERT/UPDATE trigger
 * (0117); this function is the JS mirror of that trigger's SQL.
 */
export function buildAddressMatchKey(lead: AddressMatchLead): string {
  const street = normaliseAddress(lead.street_address || lead.formatted_address || '');
  const suburb = normaliseAddress(lead.suburb || '');
  return [street, suburb].filter(Boolean).join('|');
}

export type MatchConfidence = 'high' | 'medium' | 'low';

// 'duplicate_practice' -> "Possible duplicate practice" banner, [Merge] [Not the same]
// 'prospecting_hint'   -> "Practitioner in the same building" banner, [Add contact] [Dismiss]
export type MatchKind = 'duplicate_practice' | 'prospecting_hint';

export type AddressMatchSignal = {
  confidence: MatchConfidence;
  kind:       MatchKind;
  reason:     string;
};

export type LeadForAddressMatch = {
  id:                string;
  practice_name:     string;
  building_name:     string | null;
  unit:              string | null;
  landline:          string | null;
  street_address:    string | null;
  formatted_address: string | null;
  suburb:            string | null;
  latitude:          number | null;
  longitude:         number | null;
};

const NEARBY_KM = 0.05; // 50m

/**
 * Compare two leads and return the single strongest signal, or null
 * when nothing matches. Ranked high -> medium -> low; the first match
 * found wins (a lead is not scored on multiple signals at once).
 */
export function matchAddress(a: LeadForAddressMatch, b: LeadForAddressMatch): AddressMatchSignal | null {
  const buildingA = normaliseAddress(a.building_name);
  const buildingB = normaliseAddress(b.building_name);
  const unitA = normaliseUnit(a.unit);
  const unitB = normaliseUnit(b.unit);
  const landlineA = normaliseLandline(a.landline);
  const landlineB = normaliseLandline(b.landline);
  const streetA = normaliseAddress(a.street_address || a.formatted_address);
  const streetB = normaliseAddress(b.street_address || b.formatted_address);
  const sameBuilding = !!buildingA && !!buildingB && buildingA === buildingB;

  if (landlineA && landlineB && landlineA === landlineB) {
    return { confidence: 'high', kind: 'duplicate_practice', reason: `Same landline as ${b.practice_name}` };
  }

  if (sameBuilding) {
    if (unitA && unitB) {
      if (unitA === unitB) {
        return { confidence: 'high', kind: 'duplicate_practice', reason: `Same building and unit as ${b.practice_name}` };
      }
      // CRITICAL: different unit in the same building is LOW confidence,
      // never a duplicate — see module header.
      return { confidence: 'low', kind: 'prospecting_hint', reason: `Practitioner in the same building as ${b.practice_name}` };
    }
    if (unitA || unitB) {
      return { confidence: 'medium', kind: 'duplicate_practice', reason: `Same building as ${b.practice_name} — verify unit` };
    }
    // Same building, neither side has a unit on file — treat as the
    // prospecting hint, not a duplicate flag (no unit evidence either way).
    return { confidence: 'low', kind: 'prospecting_hint', reason: `Practitioner in the same building as ${b.practice_name}` };
  }

  if (!buildingA && !buildingB && streetA && streetB && streetA === streetB) {
    return { confidence: 'medium', kind: 'duplicate_practice', reason: `Same street address as ${b.practice_name}` };
  }

  if (a.latitude != null && a.longitude != null && b.latitude != null && b.longitude != null) {
    const distanceKm = haversineKm({ lat: a.latitude, lng: a.longitude }, { lat: b.latitude, lng: b.longitude });
    if (distanceKm <= NEARBY_KM) {
      return { confidence: 'low', kind: 'prospecting_hint', reason: `Nearby — within 50m of ${b.practice_name}` };
    }
  }

  return null;
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { high: 3, medium: 2, low: 1 };

export type AddressMatchSuggestion = AddressMatchSignal & { otherLeadId: string };

/**
 * Rank suggestions across every candidate, highest confidence first,
 * capped at 3 — matching the lead-detail banner's display limit.
 */
export function rankAddressMatches(
  lead: LeadForAddressMatch,
  candidates: LeadForAddressMatch[],
): AddressMatchSuggestion[] {
  const suggestions: AddressMatchSuggestion[] = [];
  for (const candidate of candidates) {
    if (candidate.id === lead.id) continue;
    const signal = matchAddress(lead, candidate);
    if (signal) suggestions.push({ ...signal, otherLeadId: candidate.id });
  }
  return suggestions
    .sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])
    .slice(0, 3);
}

/** Lower UUID first — the canonical pair ordering crm_suggestion_dismissals stores. */
export function orderedLeadPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Filters out suggestions matching a previously-dismissed (leadId, otherLeadId, kind) pair. */
export function excludeDismissed(
  leadId: string,
  suggestions: AddressMatchSuggestion[],
  dismissed: Array<{ lead_a_id: string; lead_b_id: string; kind: MatchKind }>,
): AddressMatchSuggestion[] {
  const dismissedKeys = new Set(dismissed.map(d => `${d.lead_a_id}:${d.lead_b_id}:${d.kind}`));
  return suggestions.filter(s => {
    const [a, b] = orderedLeadPair(leadId, s.otherLeadId);
    return !dismissedKeys.has(`${a}:${b}:${s.kind}`);
  });
}
