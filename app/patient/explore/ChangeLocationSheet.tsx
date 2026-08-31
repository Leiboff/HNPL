'use client';

import { useCallback, useEffect, useState } from 'react';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import { extractSuburbLabel, reverseGeocodeSuburb } from '@/lib/maps/reverseGeocode';
import type { SharedLocation } from '@/lib/patient/sharedLocation';

// ─── ChangeLocationSheet — bottom-sheet / centered modal ────────────────
//
// The change-location surface for /patient/explore. Same overlay
// pattern as SettingsSheet (backdrop, Escape closes, body-scroll lock,
// mobile bottom-sheet / desktop centered modal). Two picking paths:
//   1. Places autocomplete (locality-biased) — suburb-level SA search
//      via the shared PlacesAutocomplete component (session-token
//      lifecycle handled inside).
//   2. "Use current location" — triggers navigator.geolocation and
//      reverse-geocodes to a "Suburb, City" label. Handles denied /
//      unsupported / timeout without crashing the sheet.
//
// A DRAFT is populated by whichever path the user takes. Confirm
// ("Select location") applies the draft to the parent + persists to
// sessionStorage + closes. No commit happens without an explicit tap
// on Confirm — matching the brief's radio/confirm semantics.

// Bound the "Resolving suburb…" state so a hung / non-2xx / null-result
// reverse-geocode can't strand the sheet. Coords are already valid at
// this point — the label is cosmetic; downstream ordering + persistence
// work fine without a real suburb string.
const REVERSE_GEOCODE_TIMEOUT_MS = 5_000;
const GPS_FALLBACK_LABEL = 'Current location';

async function resolveGpsLabel(latitude: number, longitude: number): Promise<string> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timerId = setTimeout(() => {
        console.warn('[change-location] reverse-geocode timed out after ' + REVERSE_GEOCODE_TIMEOUT_MS + 'ms — falling back to generic label');
        resolve(null);
      }, REVERSE_GEOCODE_TIMEOUT_MS);
    });
    const label = await Promise.race([
      reverseGeocodeSuburb(latitude, longitude).catch((err: unknown) => {
        console.warn('[change-location] reverse-geocode rejected', err);
        return null;
      }),
      timeoutPromise,
    ]);
    return label ?? GPS_FALLBACK_LABEL;
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

type Draft =
  | { kind: 'none' }
  | { kind: 'suburb'; latitude: number; longitude: number; label: string }
  | { kind: 'gps-requesting' }
  | { kind: 'gps-denied' }
  | { kind: 'gps-unsupported' }
  | { kind: 'gps'; latitude: number; longitude: number; label: string | null };

type Props = {
  onClose:  () => void;
  onCommit: (loc: SharedLocation) => void;
};

// Parent-side conditional render — the sheet is only mounted when
// visible. State resets naturally on unmount so we don't need a
// reset-on-close effect (which would trip the
// react-hooks/set-state-in-effect lint rule).
export default function ChangeLocationSheet({ onClose, onCommit }: Props) {
  const [draft, setDraft] = useState<Draft>({ kind: 'none' });

  // Escape closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prevent body scroll while the sheet is open (mounted).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const startGpsRequest = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setDraft({ kind: 'gps-unsupported' });
      return;
    }
    setDraft({ kind: 'gps-requesting' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latitude  = pos.coords.latitude;
        const longitude = pos.coords.longitude;
        // Show the coords immediately with a null label; the resolver
        // below fills the label in-place. Coord validity — not the
        // label — is what makes the draft committable, so Confirm is
        // enabled the moment we're in `gps` state.
        setDraft({ kind: 'gps', latitude, longitude, label: null });

        // Exit-guaranteed resolver: races the reverse-geocode against
        // a 5s timeout AND catches rejections. Any of (reject /
        // timeout / null) → 'Current location' fallback so the
        // "Resolving suburb…" text can't stay on screen forever.
        // reverseGeocodeSuburb itself never rejects (returns null on
        // every failure path), but the .catch defends against a
        // future refactor of that helper.
        resolveGpsLabel(latitude, longitude).then((label) => {
          setDraft((prev) => {
            if (prev.kind !== 'gps') return prev;
            if (prev.latitude !== latitude || prev.longitude !== longitude) return prev;
            return { ...prev, label };
          });
        });
      },
      () => { setDraft({ kind: 'gps-denied' }); },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );
  }, []);

  const onSuburbSelect = useCallback((place: {
    latitude:          number;
    longitude:         number;
    formattedAddress:  string;
    addressComponents: Array<{ longText: string; shortText: string; types: string[] }>;
  }) => {
    // Prefer the structured "Suburb, City" from address components.
    // Fall back to formattedAddress (already SA-biased via the
    // autocomplete regionCode restriction) so we always render a
    // meaningful label on the row.
    const label = extractSuburbLabel(place.addressComponents) ?? place.formattedAddress;
    setDraft({
      kind:      'suburb',
      latitude:  place.latitude,
      longitude: place.longitude,
      label,
    });
  }, []);

  const canConfirm =
    draft.kind === 'suburb' || draft.kind === 'gps';

  const useCurrentSelected =
    draft.kind === 'gps'
    || draft.kind === 'gps-requesting'
    || draft.kind === 'gps-denied'
    || draft.kind === 'gps-unsupported';

  function onConfirm() {
    if (draft.kind === 'suburb') {
      onCommit({
        latitude:  draft.latitude,
        longitude: draft.longitude,
        label:     draft.label,
        source:    'suburb',
      });
      onClose();
      return;
    }
    if (draft.kind === 'gps') {
      // If the user hit Confirm before reverse-geocode resolved (or
      // it returned null), fall back to a generic label so the
      // LocationRow renders something honest — the coords are real
      // and drive ordering; the label is only display.
      onCommit({
        latitude:  draft.latitude,
        longitude: draft.longitude,
        label:     draft.label ?? 'Current location',
        source:    'gps',
      });
      onClose();
      return;
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
        data-testid="change-location-backdrop"
      />

      {/* Sheet / modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Change location"
        data-testid="change-location-sheet"
        className="
          relative w-full md:max-w-md
          bg-white
          rounded-t-2xl md:rounded-2xl
          shadow-2xl
          max-h-[90dvh] overflow-y-auto
          flex flex-col
        "
      >
        {/* Drag handle (mobile only) */}
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 rounded-full bg-gray-200" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-4 pb-3 md:pt-6">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--portal-ink)' }}>
            Change location
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="change-location-close"
            className="text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-6 space-y-4">
          {/* Autocomplete */}
          <div>
            <label
              htmlFor="change-location-search"
              className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5 block"
            >
              Find a location
            </label>
            <PlacesAutocomplete
              variant="locality"
              inputId="change-location-search"
              placeholder="e.g. Glenhazel"
              onSelect={onSuburbSelect}
            />
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="h-px bg-gray-100 flex-1" />
            <span className="text-[11px] font-medium uppercase tracking-widest text-gray-400">or</span>
            <div className="h-px bg-gray-100 flex-1" />
          </div>

          {/* Use current location — radio-styled option */}
          <button
            type="button"
            onClick={startGpsRequest}
            data-testid="change-location-use-current"
            aria-pressed={useCurrentSelected}
            className={`w-full text-left rounded-xl border px-4 py-3 flex items-start gap-3 transition-colors ${
              useCurrentSelected
                ? 'border-[var(--portal-accent)] bg-[rgba(21,168,158,.06)]'
                : 'border-gray-200 bg-white hover:bg-gray-50'
            }`}
          >
            <span
              className={`mt-0.5 shrink-0 h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                useCurrentSelected ? 'border-[var(--portal-accent)]' : 'border-gray-300'
              }`}
              aria-hidden
            >
              {useCurrentSelected && (
                <span className="h-2 w-2 rounded-full" style={{ background: 'var(--portal-accent)' }} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold" style={{ color: 'var(--portal-ink)' }}>
                Use current location
              </span>
              <span className="mt-0.5 block text-xs text-gray-500" data-testid="change-location-use-current-detail">
                {draft.kind === 'gps' && draft.label
                  ? draft.label
                  : draft.kind === 'gps' && !draft.label
                    ? 'Location captured. Resolving suburb…'
                    : draft.kind === 'gps-requesting'
                      ? 'Waiting for browser permission…'
                      : draft.kind === 'gps-denied'
                        ? "Location blocked in your browser — pick a suburb above instead."
                        : draft.kind === 'gps-unsupported'
                          ? 'Your browser does not support geolocation. Pick a suburb above instead.'
                          : 'We will ask your browser for permission.'}
              </span>
            </span>
          </button>

          {/* Draft summary (only when a suburb has been picked) */}
          {draft.kind === 'suburb' && (
            <div
              className="rounded-xl border border-[var(--portal-accent)]/30 bg-[rgba(21,168,158,.06)] px-4 py-3"
              data-testid="change-location-draft-suburb"
            >
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
                Selected
              </p>
              <p className="mt-0.5 text-sm font-semibold" style={{ color: 'var(--portal-ink)' }}>
                {draft.label}
              </p>
            </div>
          )}

          {/* Confirm */}
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            data-testid="change-location-confirm"
            className="w-full rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed enabled:hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
          >
            Select location
          </button>
        </div>
      </div>
    </div>
  );
}
