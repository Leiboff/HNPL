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
// Explicitly absent (do not re-introduce):
//   • The HPCSA-registered badge — final, per the current decision.
//     Registration is assumed for every listed practitioner; the
//     visible badge was noise. The `hpcsa_group_key` hash the
//     grouping helper uses is UNAFFECTED — that's a hidden merge
//     key, never rendered.
//   • The practice's name (nested box). Only the AREA is shown here
//     — the detail screen names each practice.
//   • Any "Cover" / "In Network" / "Premier Plus" language.
//   • Any Vet/Hospital/Pharmacy chip.
//
// Location line — STACKED (two lines):
//   1. Suburb, City (with a pin icon)
//   2. N km away  (only when distance is known)
// Previously the two were joined on one line and truncated on narrow
// screens; stacking fixes the truncation without changing the data.

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

function areaOnly(loc: LocationOnCard | undefined): string {
  if (!loc) return '';
  return [loc.suburb, loc.city].filter(Boolean).join(', ');
}

// ─── PractitionerListCard ──────────────────────────────────────────────

export default function PractitionerListCard({ card }: { card: PractitionerCard }) {
  const nearest = card.locations[0];
  const totalLocations = card.locations.length;
  const maps    = nearest ? mapsHref(nearest) : null;

  return (
    <article
      className="bn-card-hover relative bg-white rounded-card"
      style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 8px -3px rgba(15,31,58,.09)' }}
      data-testid={`practitioner-card-${card.id}`}
    >
      {/* Whole-card link — sits UNDER the action buttons via z-index. */}
      <Link
        href={`/patient/practitioner/${card.representativeMemberId}`}
        data-testid={`practitioner-card-${card.id}-view`}
        aria-label={`View ${card.fullName}`}
        className="absolute inset-0 rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--portal-accent)]/40"
      />

      <div className="relative px-5 py-4 space-y-3">
        {/* Header — avatar + name/specialty (compact). HPCSA badge
            intentionally absent (see module header). */}
        <header className="flex items-start gap-3">
          <div
            aria-hidden
            className="shrink-0 h-[46px] w-[46px] rounded-tile flex items-center justify-center text-[14px] font-semibold"
            style={{ background: 'rgba(21,168,158,.1)', color: 'var(--portal-accent-ink)' }}
          >
            {initialsOf(card)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>{card.fullName}</p>
            <div className="mt-[7px] flex flex-wrap items-center gap-1.5">
              {card.specialty && (
                <span
                  className="text-[11px] font-medium rounded-full px-[9px] py-[5px]"
                  style={{ background: 'var(--portal-wash)', color: 'var(--portal-muted)' }}
                >
                  {card.specialty}
                </span>
              )}
              {/* The reason this directory exists, said on every card. It
                  is the product's actual claim — not a marketing line —
                  and 3 is the maximum plan_type the schema allows, so it
                  cannot drift from what checkout will offer. */}
              <span
                className="text-[11px] font-medium rounded-full px-[9px] py-[5px]"
                style={{ background: 'rgba(21,168,158,.12)', color: 'var(--portal-accent-ink)' }}
              >
                Up to 3 instalments
              </span>
            </div>
          </div>
        </header>

        {/* Closest location — TWO stacked lines:
              1. Suburb, City   (with pin icon)
              2. N km away      (only when distance is known)
            Previously joined on one line with `·` and truncated on
            narrow screens. Stacking fixes truncation without any
            change to the underlying data. */}
        {nearest && (() => {
          const area     = areaOnly(nearest);
          const distText = nearest.distanceKm != null ? formatDistanceKm(nearest.distanceKm) : null;
          return (
            <div className="space-y-0.5" data-testid={`practitioner-card-${card.id}-area`}>
              <p className="text-sm text-gray-700 flex items-center gap-1.5">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden className="shrink-0 text-gray-400">
                  <path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z" strokeLinejoin="round" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
                <span>{area || '—'}</span>
              </p>
              {distText && (
                <p
                  className="text-xs font-medium pl-4.75"
                  style={{ color: 'var(--portal-accent)' }}
                  data-testid={`practitioner-card-${card.id}-distance`}
                >
                  {distText} away
                </p>
              )}
              {totalLocations >= 2 && (
                <p className="text-[11px] text-gray-400 pl-4.75">
                  Also practises at {totalLocations - 1} other location{totalLocations - 1 === 1 ? '' : 's'} — see profile.
                </p>
              )}
            </div>
          );
        })()}

        {/* Actions — at the BOTTOM of the card. z-index above the
            whole-card Link so taps here don't navigate. */}
        {nearest && (
          <div className="relative z-10 flex flex-wrap items-center gap-2 pt-1">
            {nearest.phone && (
              <a
                href={`tel:${nearest.phone}`}
                data-testid={`practitioner-card-${card.id}-call`}
                className="bn-btn-navy inline-flex items-center gap-1.5 rounded-chip px-3 py-2 text-[12px] font-semibold text-white"
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-[var(--portal-ink)] hover:bg-gray-50"
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
