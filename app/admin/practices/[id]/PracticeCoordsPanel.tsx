'use client';

import { useState, useTransition } from 'react';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import { parseAddressComponents } from '@/lib/maps/places';
import type { PlacePickPayload } from '@/app/admin/practices/actions';

type Props = {
  practiceId: string;
  latitude:   number | null;
  longitude:  number | null;
  /** Server actions threaded down so this client component doesn't import them. */
  updateFromPlaceAction: (practiceId: string, place: PlacePickPayload) => Promise<{ error: string | null }>;
  setCoordsAction:       (practiceId: string, latitude: number, longitude: number) => Promise<{ error: string | null }>;
  clearCoordsAction:     (practiceId: string) => Promise<{ error: string | null }>;
};

// Admin coords-recovery panel. Three controls:
//   • Re-pick address via Google Places (New) — replaces the old
//     "re-geocode from stored address" action. Type → dropdown → pick;
//     coords + formatted address overwrite the stored ones.
//   • Manual lat/long entry — ultimate fallback when Places can't find
//     the place. SA-range validated server-side.
//   • Clear — NULL the coords (takes the practice out of the "near me"
//     filter without removing the address).

export default function PracticeCoordsPanel({
  practiceId,
  latitude,
  longitude,
  updateFromPlaceAction,
  setCoordsAction,
  clearCoordsAction,
}: Props) {
  const [latInput, setLatInput] = useState(latitude  != null ? String(latitude)  : '');
  const [lngInput, setLngInput] = useState(longitude != null ? String(longitude) : '');
  const [message,  setMessage]  = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function flash(kind: 'ok' | 'error', text: string) {
    setMessage({ kind, text });
  }

  function onPlacePicked(formattedAddress: string, lat: number, lng: number, parsed: ReturnType<typeof parseAddressComponents>) {
    setMessage(null);
    startTransition(async () => {
      const r = await updateFromPlaceAction(practiceId, {
        latitude:         lat,
        longitude:        lng,
        formattedAddress,
        suburb:           parsed.suburb,
        city:             parsed.city,
        province:         parsed.province,
        postalCode:       parsed.postalCode,
      });
      if (r.error) {
        flash('error', r.error);
      } else {
        setLatInput(String(lat));
        setLngInput(String(lng));
        flash('ok', `Updated to ${lat.toFixed(6)}, ${lng.toFixed(6)} — ${formattedAddress}`);
      }
    });
  }

  function onSaveManual() {
    setMessage(null);
    const lat = Number(latInput);
    const lng = Number(lngInput);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      flash('error', 'Latitude and longitude must be numbers.');
      return;
    }
    startTransition(async () => {
      const r = await setCoordsAction(practiceId, lat, lng);
      if (r.error) flash('error', r.error);
      else         flash('ok', 'Coordinates saved.');
    });
  }

  function onClear() {
    setMessage(null);
    startTransition(async () => {
      const r = await clearCoordsAction(practiceId);
      if (r.error) {
        flash('error', r.error);
      } else {
        setLatInput('');
        setLngInput('');
        flash('ok', 'Coordinates cleared.');
      }
    });
  }

  const inputCls =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
    'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]';

  const hasCoords = latInput.length > 0 && lngInput.length > 0;

  return (
    <div className="space-y-4">
      {/* ── Re-pick via Places ─────────────────────────────────────── */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          Re-pick address via Google Places
        </label>
        <PlacesAutocomplete
          variant="address"
          placeholder="Type the practice address…"
          disabled={isPending}
          onSelect={(place) => onPlacePicked(
            place.formattedAddress,
            place.latitude,
            place.longitude,
            parseAddressComponents(place.addressComponents),
          )}
        />
        <p className="mt-1 text-[11px] text-gray-500">
          Pick the practice from the dropdown — coords + formatted address overwrite the stored values.
        </p>
      </div>

      {/* ── Manual lat/long ────────────────────────────────────────── */}
      <div className="border-t border-gray-100 pt-4">
        <p className="text-xs font-medium text-gray-600 mb-2">Manual override</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="lat" className="block text-xs font-medium text-gray-600 mb-1">Latitude</label>
            <input
              id="lat"
              type="text"
              inputMode="decimal"
              value={latInput}
              onChange={(e) => setLatInput(e.target.value)}
              placeholder="-26.107567"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="lng" className="block text-xs font-medium text-gray-600 mb-1">Longitude</label>
            <input
              id="lng"
              type="text"
              inputMode="decimal"
              value={lngInput}
              onChange={(e) => setLngInput(e.target.value)}
              placeholder="28.056456"
              className={inputCls}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <button
            type="button"
            onClick={onSaveManual}
            disabled={isPending}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Save manual coords
          </button>
          {hasCoords && (
            <button
              type="button"
              onClick={onClear}
              disabled={isPending}
              className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {message && (
        <p className={`text-xs ${message.kind === 'ok' ? 'text-green-700' : 'text-red-700'}`}>
          {message.text}
        </p>
      )}

      <p className="text-[11px] text-gray-500">
        SA range: latitude ∈ [-35, -22], longitude ∈ [16, 33]. Out-of-range entries are rejected.
      </p>
    </div>
  );
}
