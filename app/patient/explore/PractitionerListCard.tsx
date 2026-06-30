'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatDistanceKm } from '@/lib/maps/haversine';
import type { LocationOnCard, PractitionerCard } from '@/lib/practitioner/grouping';

// ─── PractitionerListCard — the "Find a Practitioner" list tile ────────
//
// Presentation-only restyle of the per-card render in ExploreView.
// Same data (PractitionerCard from lib/practitioner/grouping), same
// HPCSA-based grouping, same nearest-first ordering — just a tighter
// information-rich layout with Call-to-book + Directions per location.
//
// Layout rules:
//   • Header: circular avatar (initials), name, specialty.
//   • If 1 location → render that single LocationRow inline.
//   • If 2+ locations → render the nearest LocationRow inline + a
//     "Show all N locations" button that toggles the rest.
//   • Each LocationRow has Call to book (tel:) and Directions (Google
//     Maps universal URL) action buttons.
//   • A "View profile →" link in the bottom-right opens
//     /patient/practitioner/[memberId] for the full detail screen.
//
// Things deliberately ABSENT from this card (do NOT add them — the
// brief is explicit about stripping Discovery's medical-aid language
// + the HPCSA badge):
//   • No "Cover" / "In Network" / "Full network cover" /
//     "Premier Plus" / any medical-aid-network strings.
//   • No "HPCSA registered ✓" badge (registration is assumed for
//     every listed practitioner; the visual badge added noise).
//   • No "Nominate as primary GP" — BetterNow isn't a medical scheme.

// ─── Helpers ───────────────────────────────────────────────────────────

function initialsOf(card: PractitionerCard): string {
  const first = (card.firstName || '').trim()[0] ?? '';
  const last  = (card.lastName  || '').trim()[0] ?? '';
  return `${first}${last}`.toUpperCase() || '·';
}

/**
 * Build a Google Maps universal search URL. Coords get priority
 * (precise pin); falls back to suburb/city string for rows without
 * a geocode. Opening in a new tab keeps the explore session.
 */
function mapsHref(loc: LocationOnCard, latitude: number | null, longitude: number | null): string | null {
  if (latitude != null && longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }
  const fallback = [loc.practice_name, loc.suburb, loc.city].filter(Boolean).join(', ');
  if (!fallback) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallback)}`;
}

// ─── LocationRow ───────────────────────────────────────────────────────

function LocationRow({
  loc,
  testIdPrefix,
}: {
  loc:          LocationOnCard;
  testIdPrefix: string;
}) {
  const localityLine = [loc.suburb, loc.city].filter(Boolean).join(', ');
  const maps         = mapsHref(loc, loc.latitude, loc.longitude);
  return (
    <li
      className="flex items-start justify-between gap-3 rounded-xl border border-gray-100 bg-white px-3.5 py-3"
      data-testid={`${testIdPrefix}-location-${loc.practice_id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900 truncate">{loc.practice_name}</p>
        {localityLine && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">{localityLine}</p>
        )}
        {loc.distanceKm != null && (
          <p className="text-xs font-medium mt-1" style={{ color: '#15A89E' }}>
            {formatDistanceKm(loc.distanceKm)}
          </p>
        )}
      </div>
      <div className="shrink-0 flex flex-col gap-1.5 items-stretch">
        {loc.phone ? (
          <a
            href={`tel:${loc.phone}`}
            data-testid={`${testIdPrefix}-call-${loc.practice_id}`}
            className="inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:shadow"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Call to book
          </a>
        ) : null}
        {maps ? (
          <a
            href={maps}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`${testIdPrefix}-directions-${loc.practice_id}`}
            className="inline-flex items-center justify-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-[#13294B] hover:bg-gray-50"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path d="M3 11l18-7-7 18-2.5-7.5L3 11z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Directions
          </a>
        ) : null}
      </div>
    </li>
  );
}

// ─── PractitionerListCard ──────────────────────────────────────────────

export default function PractitionerListCard({ card }: { card: PractitionerCard }) {
  const [expanded, setExpanded] = useState(false);
  const total = card.locations.length;
  const nearest = card.locations[0];
  const rest    = card.locations.slice(1);

  return (
    <article
      className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4 space-y-3"
      data-testid={`practitioner-card-${card.id}`}
    >
      {/* Header: avatar + name + specialty + view-profile link */}
      <header className="flex items-start gap-3">
        <div
          aria-hidden
          className="shrink-0 h-11 w-11 rounded-full flex items-center justify-center text-sm font-semibold text-white"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {initialsOf(card)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 truncate">{card.fullName}</p>
          {card.specialty && (
            <p className="text-xs text-gray-500 mt-0.5">{card.specialty}</p>
          )}
        </div>
        <Link
          href={`/patient/practitioner/${card.representativeMemberId}`}
          data-testid={`practitioner-card-${card.id}-view`}
          className="shrink-0 text-xs font-semibold underline underline-offset-2"
          style={{ color: '#13294B' }}
        >
          View profile →
        </Link>
      </header>

      {/* Locations — always show nearest; expander for 2+ */}
      {nearest && (
        <ul className="space-y-2">
          <LocationRow loc={nearest} testIdPrefix={`practitioner-card-${card.id}`} />

          {total >= 2 && !expanded && (
            <li>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                data-testid={`practitioner-card-${card.id}-expand`}
                className="w-full text-left rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3.5 py-2.5 text-xs font-semibold text-[#13294B] hover:bg-gray-100"
              >
                Show all {total} locations
              </button>
            </li>
          )}

          {total >= 2 && expanded && (
            <>
              {rest.map((loc) => (
                <LocationRow key={loc.practice_id} loc={loc} testIdPrefix={`practitioner-card-${card.id}`} />
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  data-testid={`practitioner-card-${card.id}-collapse`}
                  className="w-full text-left rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3.5 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-100"
                >
                  Hide other locations
                </button>
              </li>
            </>
          )}
        </ul>
      )}
    </article>
  );
}
