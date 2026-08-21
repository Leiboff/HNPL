import { describe, it, expect } from 'vitest';
import { categoryCounts } from './categories';
import type { PractitionerCard } from './grouping';

// ─── Tests — category counts for the discovery landing ─────────────────
//
// Rules pinned:
//   • Empty specialties never appear (data-driven inventory only).
//   • Null-specialty cards are dropped from the counts (no anonymous
//     bucket rendered on the landing).
//   • Count is per DISTINCT practitioner (one card = one count),
//     regardless of how many locations a practitioner has.
//   • Sort: A→Z by specialty name, always — never by count.

function card(over: Partial<PractitionerCard> = {}): PractitionerCard {
  return {
    id:                     'x',
    representativeMemberId: 'mx',
    firstName:              'X',
    lastName:               'X',
    fullName:               'X X',
    specialty:              'Dentistry',
    hpcsaRegistered:        true,
    locations:              [],
    minDistanceKm:          null,
    ...over,
  };
}

describe('categoryCounts', () => {
  it('returns empty list when there are no cards', () => {
    expect(categoryCounts([])).toEqual([]);
  });

  it('drops empty specialties — a specialty with 0 practitioners never appears', () => {
    // Nothing to construct; the function just never emits a category
    // that didn't exist in the input. Sanity check the opposite: one
    // Dentistry card yields exactly [Dentistry].
    const cs = categoryCounts([card({ id: 'a', specialty: 'Dentistry' })]);
    expect(cs).toEqual([{ specialty: 'Dentistry', count: 1 }]);
  });

  it('groups distinct practitioners per specialty (count = number of PEOPLE)', () => {
    const cs = categoryCounts([
      card({ id: 'a', specialty: 'Dentistry' }),
      card({ id: 'b', specialty: 'Dentistry' }),
      card({ id: 'c', specialty: 'Physiotherapy' }),
      card({ id: 'd', specialty: 'Psychology' }),
      card({ id: 'e', specialty: 'Psychology' }),
      card({ id: 'f', specialty: 'Psychology' }),
    ]);
    // Sort: A→Z regardless of count — Psychology has the most
    // practitioners but sorts last, Dentistry the fewest but sorts first.
    expect(cs).toEqual([
      { specialty: 'Dentistry',     count: 2 },
      { specialty: 'Physiotherapy', count: 1 },
      { specialty: 'Psychology',    count: 3 },
    ]);
  });

  it('does not add to the count when the same specialty appears on the same card multiple times', () => {
    // The grouping helper's contract is one card per practitioner
    // (already collapsed across locations). categoryCounts is
    // downstream of that — a practitioner with 5 locations still
    // counts as 1.
    const cs = categoryCounts([card({ id: 'multi', specialty: 'Dentistry' })]);
    expect(cs).toEqual([{ specialty: 'Dentistry', count: 1 }]);
  });

  it('drops cards with a null specialty (no anonymous bucket)', () => {
    const cs = categoryCounts([
      card({ id: 'named', specialty: 'Dentistry' }),
      card({ id: 'nullA', specialty: null }),
      card({ id: 'nullB', specialty: null }),
    ]);
    expect(cs).toEqual([{ specialty: 'Dentistry', count: 1 }]);
  });

  it('always sorts alphabetically, tied counts or not', () => {
    const cs = categoryCounts([
      card({ id: 'a', specialty: 'Zeta' }),
      card({ id: 'b', specialty: 'Alpha' }),
      card({ id: 'c', specialty: 'Mango' }),
    ]);
    expect(cs.map((c) => c.specialty)).toEqual(['Alpha', 'Mango', 'Zeta']);
  });
});
