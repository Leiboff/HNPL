// ─── Practitioner identity across practices — HPCSA grouping ──────────
//
// Mirrors migration 0064's practitioner directory view normalisation
// exactly: trim + lowercase, then md5. NULL/empty stays NULL — never a
// group key, and
// a NULL key must never hide a contact (same rule as 0064). The hash
// is computed by a DB trigger (0118); this is the JS mirror used for
// pure-function testing and any client-side grouping.

import { createHash } from 'node:crypto';

export function hashHpcsaNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return createHash('md5').update(trimmed.toLowerCase()).digest('hex');
}

export type ContactWithHpcsa = {
  id:              string;
  lead_id:         string;
  hpcsa_group_key: string | null;
};

/**
 * Groups contacts sharing a non-null hpcsa_group_key. Contacts with a
 * NULL key are omitted from every group (never silently hidden
 * elsewhere — the caller still has them via the original list).
 */
export function groupContactsByHpcsa<T extends ContactWithHpcsa>(contacts: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const c of contacts) {
    if (!c.hpcsa_group_key) continue;
    const arr = groups.get(c.hpcsa_group_key) ?? [];
    arr.push(c);
    groups.set(c.hpcsa_group_key, arr);
  }
  return groups;
}

/**
 * Other leads (by id) the same practitioner (same hpcsa_group_key)
 * also appears at — excludes the lead the contact itself belongs to.
 */
export function findOtherLeadsForContact<T extends ContactWithHpcsa>(
  contact: T,
  allContacts: T[],
): string[] {
  if (!contact.hpcsa_group_key) return [];
  const leadIds = new Set<string>();
  for (const c of allContacts) {
    if (c.hpcsa_group_key === contact.hpcsa_group_key && c.lead_id !== contact.lead_id) {
      leadIds.add(c.lead_id);
    }
  }
  return Array.from(leadIds);
}

const HIGH_CONVERSION_STAGES = new Set(['new', 'contacted', 'nurture']);

/**
 * True when `lead` (in new/contacted/nurture) has a contact whose
 * hpcsa_group_key also appears on a contact at an onboarded lead —
 * the "highest-conversion route into a new practice" signal. Backs the
 * "Practitioner already onboarded elsewhere" saved view.
 */
export function hasOnboardedPractitionerMatch(
  leadStage: string,
  leadContacts: Array<{ hpcsa_group_key: string | null }>,
  onboardedHpcsaKeys: ReadonlySet<string>,
): boolean {
  if (!HIGH_CONVERSION_STAGES.has(leadStage)) return false;
  return leadContacts.some(c => !!c.hpcsa_group_key && onboardedHpcsaKeys.has(c.hpcsa_group_key));
}
