'use client';

import Link from 'next/link';
import { useState, useMemo, useEffect } from 'react';
import PatientScreen from '@/app/patient/PatientScreen';
import { formatDistanceKm, type LatLng } from '@/lib/maps/haversine';
import { readStoredLocation } from '@/lib/patient/sharedLocation';
import {
  decorateWithDistance,
  groupIntoCards,
  type DirectoryRow,
  type LocationOnCard,
} from '@/lib/practitioner/grouping';

// ─── Practitioner detail screen — client ──────────────────────────────
//
// Builds a single PractitionerCard from the (1 or more) view rows the
// server fetched, applies client-side haversine when a location is
// already in the shared session store, and renders:
//   • Hero header — large avatar, name, specialty.
//   • Facilities/Locations section — full list of practices with
//     Call to book + Directions per row, sorted nearest-first.
//   • Sticky bottom action bar — Call to book + Directions for the
//     practitioner's nearest location.
//
// Location handling — NO on-mount browser prompt. We only render
// distances / nearest-first ordering when the user has already set a
// location via /patient/explore's change-location sheet (persisted in
// sessionStorage). If nothing is stored, distances are hidden but
// every location's "Directions" link still works from the practice's
// stored coords / address string, and Call to book is unchanged. That
// keeps the page usable without ever triggering a gesture-less
// permission prompt.
//
// No medical-aid / network / HPCSA badge content here either — same
// rules as the list.

type Props = {
  rows: DirectoryRow[];
};

export default function DetailView({ rows }: Props) {
  // Hydrate the shared location from sessionStorage once. Never fires
  // navigator.geolocation.getCurrentPosition — see the comment above.
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const shared = readStoredLocation();
      if (cancelled || !shared) return;
      setUserLocation({ latitude: shared.latitude, longitude: shared.longitude });
    })();
    return () => { cancelled = true; };
  }, []);

  // Build the same PractitionerCard the list builds — the detail page
  // is just "the same card, more space". groupIntoCards is the SAME
  // pure helper the list uses; passing this practitioner's rows
  // through it yields exactly one card.
  const card = useMemo(() => {
    const decorated = decorateWithDistance(rows, userLocation);
    return groupIntoCards(decorated)[0];
  }, [rows, userLocation]);

  if (!card) {
    // Defensive: the server already handled the not-found case, but
    // a snapshot/restore mid-grouping could leave this empty.
    return null;
  }

  const initials = `${card.firstName[0] ?? ''}${card.lastName[0] ?? ''}`.toUpperCase() || '·';
  const primary  = card.locations[0];
  const primaryMaps = primary ? mapsHref(primary, primary.latitude, primary.longitude) : null;

  return (
    // ── The shell, at last ────────────────────────────────────────────
    //
    // This screen used to lay itself out: its own max-w-2xl column, its own
    // padding, and — the part that showed — no status-bar clearance, so on
    // a phone its back link sat under the notch while every other patient
    // screen cleared it by 58px. It is a SECOND-LEVEL screen (you reach it
    // from Find care, not from the nav bar), so it takes the same `plain`
    // tone and the same back-chevron header as the Account sub-screens.
    <PatientScreen
      tone="plain"
      header={
        <div className="flex items-center gap-3">
          <Link
            href="/patient/explore"
            aria-label="Back to practitioners"
            className="flex-none w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: '#fff', border: '1px solid var(--portal-hairline)', color: 'var(--portal-ink)' }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 6-6 6 6 6" />
            </svg>
          </Link>
          <h1 className="text-[17px] font-semibold truncate" style={{ color: 'var(--portal-ink)' }}>
            {card.fullName}
          </h1>
        </div>
      }
      // The sheet's bottom padding clears the fixed action bar — plus, on a
      // phone, the nav under it — so the last location row is never
      // stranded behind them. Desktop loses the nav's 66px but still has a
      // ~60px bar sitting on the screen edge, so it keeps a clearance of
      // its own rather than dropping to ordinary page padding.
      sheetClassName="px-[18px] pb-[150px] md:pb-[104px]"
    >
    <div className="space-y-6">
      {/* Hero */}
      <header className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm p-6">
        <div className="flex items-start gap-4">
          <div
            aria-hidden
            className="shrink-0 h-16 w-16 rounded-full flex items-center justify-center text-xl font-semibold text-white"
            style={{ background: 'var(--brand-navy-deep)' }}
          >
            {initials}
          </div>
          {/* The name is NOT repeated here. It moved up to the screen
              header when this page joined the shell, and printing it twice
              40px apart reads as a rendering fault rather than emphasis.
              What is left is what the header can't carry: the avatar, the
              specialty, and the one claim the directory exists to make. */}
          <div className="min-w-0">
            {card.specialty && (
              <p className="text-[17px] font-semibold text-gray-900">{card.specialty}</p>
            )}
            <p className="text-xs text-gray-400 mt-2 flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12.5 2.5 2.5L16 9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Payment plans available here
            </p>
          </div>
        </div>
      </header>

      {/* Locations */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Locations ({card.locations.length})
        </h2>
        <ul className="space-y-2">
          {card.locations.map((loc) => (
            <LocationRow key={loc.practice_id} loc={loc} />
          ))}
        </ul>
      </section>

      {/* Sticky bottom action bar — Call to book + Directions for the
          PRIMARY (nearest) location. Discovery-style, BetterNow-branded.
          
          It sits ABOVE the bottom nav, not under it. At `bottom-0 z-10` it
          was drawn at the same place as PatientBottomNav (bottom-0, z-30) —
          which wins on z-index, so on a phone the whole bar, Call to book
          included, was invisible behind the nav. The offset is the nav's own
          geometry: 66px of bar plus whatever the home indicator takes.

          The offset is a RESPONSIVE CLASS, not an inline style, and that is
          the whole reason it can't be inline: PatientBottomNav is md:hidden,
          so from md up there is no nav to clear and the bar belongs on the
          screen edge. An inline `bottom` carries no breakpoint, so it went
          on reserving 66px for a nav that wasn't there and left the bar
          floating in the margin. */}
      {primary && (
        <div
          className="fixed inset-x-0 z-40 bg-white px-4 py-3 bottom-[calc(66px+env(safe-area-inset-bottom))] md:bottom-0"
          style={{
            borderTop: '1px solid var(--portal-hairline)',
            boxShadow: '0 -2px 12px -5px rgba(11,31,58,0.18)',
          }}
        >
          {/* Wraps rather than truncates. At 390px the two buttons take
              ~270px of a 358px row, which left the practice name about
              sixty pixels and "Bryanston De…" — the one thing the bar has
              to be unambiguous about, since the buttons act on THIS
              location and a practitioner can have several. */}
          <div className="mx-auto max-w-md md:max-w-3xl lg:max-w-5xl flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-xs text-gray-500 w-full md:w-auto md:flex-1 min-w-0 truncate">
              <span className="font-medium text-gray-900">{primary.practice_name}</span>
              {primary.distanceKm != null && (
                <span style={{ color: 'var(--portal-accent)' }}> · {formatDistanceKm(primary.distanceKm)}</span>
              )}
            </p>
            {primaryMaps && (
              <a
                href={primaryMaps}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="detail-primary-directions"
                className="ml-auto md:ml-0 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-[var(--portal-ink)] hover:bg-gray-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path d="M3 11l18-7-7 18-2.5-7.5L3 11z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Directions
              </a>
            )}
            {primary.phone && (
              <a
                href={`tel:${primary.phone}`}
                data-testid="detail-primary-call"
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-white shadow-sm hover:shadow"
                style={{ background: 'var(--brand-navy-deep)' }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Call to book
              </a>
            )}
          </div>
        </div>
      )}
    </div>
    </PatientScreen>
  );
}

// ─── LocationRow ───────────────────────────────────────────────────────
//
// Full-width row with the practice name, locality, distance, and the
// two action buttons. Same shape as the list card's rows so the
// visual rhythm is consistent across both screens.

function LocationRow({ loc }: { loc: LocationOnCard }) {
  const localityLine = [loc.suburb, loc.city].filter(Boolean).join(', ');
  const maps         = mapsHref(loc, loc.latitude, loc.longitude);
  return (
    <li
      className="flex items-start justify-between gap-3 rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3"
      data-testid={`detail-location-${loc.practice_id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-gray-900 truncate">{loc.practice_name}</p>
        {localityLine && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">{localityLine}</p>
        )}
        {loc.distanceKm != null && (
          <p className="text-xs font-medium mt-1" style={{ color: 'var(--portal-accent)' }}>
            {formatDistanceKm(loc.distanceKm)}
          </p>
        )}
      </div>
      <div className="shrink-0 flex flex-col gap-1.5 items-stretch">
        {loc.phone && (
          <a
            href={`tel:${loc.phone}`}
            data-testid={`detail-location-call-${loc.practice_id}`}
            className="inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm"
            style={{ background: 'var(--brand-navy-deep)' }}
          >
            Call to book
          </a>
        )}
        {maps && (
          <a
            href={maps}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`detail-location-directions-${loc.practice_id}`}
            className="inline-flex items-center justify-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-[var(--portal-ink)] hover:bg-gray-50"
          >
            Directions
          </a>
        )}
      </div>
    </li>
  );
}

function mapsHref(loc: LocationOnCard, latitude: number | null, longitude: number | null): string | null {
  if (latitude != null && longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  }
  const fallback = [loc.practice_name, loc.suburb, loc.city].filter(Boolean).join(', ');
  if (!fallback) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallback)}`;
}
