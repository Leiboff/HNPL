'use client';

import Link from 'next/link';
import { formatDistanceKm } from '@/lib/maps/haversine';
import type { LocationOnCard, PractitionerCard } from '@/lib/practitioner/grouping';

// ─── PractitionerListCard — flatter, simpler layout ────────────────────
//
// One card per grouped practitioner (HPCSA-keyed, NULL fallback).
// Shows only the CLOSEST location — the detail screen
// (/patient/practitioner/[memberId]) is where a multi-location
// practitioner's full list lives. This card has no nested
// practice-in-a-box; the closest location's AREA (suburb, city) +
// distance appears as a plain line, and the actions sit at the
// bottom.
//
// The card body itself is a Link to the detail screen so the whole
// tile is one big tap-zone. The Call-to-book and Get-directions
// action buttons are inside a `pointer-events-auto` sibling row that
// stops event propagation — a tap on Call dials the practice; a tap
// on Directions opens maps; a tap anywhere else opens the detail.
//
// Explicitly kept on this card (per the current decision):
//   • HPCSA badge — the trust signal is worth the space.
//
// Explicitly absent (do not re-introduce):
//   • The practice's name (nested box). Only the AREA is shown here
//     — the detail screen names each practice.
//   • Any "Cover" / "In Network" / "Premier Plus" language.
//   • Any Vet/Hospital/Pharmacy chip.

// ─── Helpers ───────────────────────────────────────────────────────────

function initialsOf(card: PractitionerCard): string {
  const first = (card.firstName || '').trim()[0] ?? '';
  const last  = (card.lastName  || '').trim()[0] ?? '';
  return `${first}${last}`.toUpperCase() || '·';
}

/**
 * Google Maps universal search URL. Coords when available (precise
 * pin); locality string fallback so a coord-less practice can still
 * be found on maps.
 */
function mapsHref(loc: LocationOnCard): string | null {
  if (loc.latitude != null && loc.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`;
  }
  const fallback = [loc.practice_name, loc.suburb, loc.city].filter(Boolean).join(', ');
  if (!fallback) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallback)}`;
}

function areaLine(loc: LocationOnCard | undefined, distanceKm: number | null): string {
  if (!loc) return '';
  const area = [loc.suburb, loc.city].filter(Boolean).join(', ');
  const distText = distanceKm != null ? formatDistanceKm(distanceKm) : null;
  if (area && distText) return `${area} · ${distText} away`;
  if (area)             return area;
  if (distText)         return distText;
  return '';
}

// ─── PractitionerListCard ──────────────────────────────────────────────

export default function PractitionerListCard({ card }: { card: PractitionerCard }) {
  const nearest = card.locations[0];
  const totalLocations = card.locations.length;
  const maps    = nearest ? mapsHref(nearest) : null;

  return (
    <article
      className="relative bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm hover:shadow-md transition-shadow"
      data-testid={`practitioner-card-${card.id}`}
    >
      {/* Whole-card link — sits UNDER the action buttons via z-index. */}
      <Link
        href={`/patient/practitioner/${card.representativeMemberId}`}
        data-testid={`practitioner-card-${card.id}-view`}
        aria-label={`View ${card.fullName}`}
        className="absolute inset-0 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#15A89E]/40"
      />

      <div className="relative px-5 py-4 space-y-3">
        {/* Header — avatar + name/specialty (compact) */}
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
            {card.hpcsaRegistered && (
              <span
                className="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
                data-testid={`practitioner-card-${card.id}-hpcsa`}
                title="Registered with the Health Professions Council of South Africa."
              >
                HPCSA registered
              </span>
            )}
          </div>
        </header>

        {/* Closest location — AREA line, no practice-name box */}
        {nearest && (
          <div className="space-y-1" data-testid={`practitioner-card-${card.id}-area`}>
            <p className="text-sm text-gray-700 flex items-center gap-1.5">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden className="shrink-0 text-gray-400">
                <path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z" strokeLinejoin="round" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
              <span className="truncate">{areaLine(nearest, nearest.distanceKm) || '—'}</span>
            </p>
            {totalLocations >= 2 && (
              <p className="text-[11px] text-gray-400 pl-[19px]">
                Also practises at {totalLocations - 1} other location{totalLocations - 1 === 1 ? '' : 's'} — see profile.
              </p>
            )}
          </div>
        )}

        {/* Actions — at the BOTTOM of the card. z-index above the
            whole-card Link so taps here don't navigate. */}
        {nearest && (
          <div className="relative z-10 flex flex-wrap items-center gap-2 pt-1">
            {nearest.phone && (
              <a
                href={`tel:${nearest.phone}`}
                data-testid={`practitioner-card-${card.id}-call`}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white shadow-sm hover:shadow"
                style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Call to book
              </a>
            )}
            {maps && (
              <a
                href={maps}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`practitioner-card-${card.id}-directions`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-[#13294B] hover:bg-gray-50"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path d="M3 11l18-7-7 18-2.5-7.5L3 11z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Get directions
              </a>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
