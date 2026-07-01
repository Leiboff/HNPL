// ─── Category counts — data-driven "Browse by specialty" landing ───────
//
// Given the grouped-card set (one card per HPCSA-keyed practitioner),
// count DISTINCT practitioners per specialty and return the list
// sorted by count desc, then alphabetically by specialty.
//
// Rules (from the brief):
//   • Only specialties that have ≥1 live practitioner appear. Empty
//     specialties are dropped — never rendered.
//   • Cards with a null specialty do NOT create a category (a
//     nameless bucket would confuse the patient).
//   • A practitioner with N locations is still counted as ONE — we
//     count PEOPLE, not locations. The grouping helper already
//     collapses locations into a single card, so this is just
//     "count cards whose specialty === s".
//
// The function is pure — no DB, no UI. Tests in categories.test.ts.

import type { PractitionerCard } from './grouping';

export type CategoryCount = {
  specialty: string;   // never null (we filter nulls out)
  count:     number;   // >= 1 (we drop empty categories)
};

export function categoryCounts(cards: PractitionerCard[]): CategoryCount[] {
  const bySpecialty = new Map<string, number>();
  for (const c of cards) {
    if (!c.specialty) continue;               // drop null-specialty rows
    const s = c.specialty;
    bySpecialty.set(s, (bySpecialty.get(s) ?? 0) + 1);
  }

  return Array.from(bySpecialty.entries())
    .filter(([, count]) => count > 0)         // never emit an empty category
    .map(([specialty, count]) => ({ specialty, count }))
    .sort((a, b) =>
      b.count - a.count                       // most-populated first...
      || a.specialty.localeCompare(b.specialty), // ...then alphabetical tiebreak
    );
}
