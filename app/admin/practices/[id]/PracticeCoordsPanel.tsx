'use client';

import { useState, useTransition } from 'react';
import type {
  RegeocodeResult,
} from '@/app/admin/practices/actions';

type Props = {
  practiceId: string;
  latitude:   number | null;
  longitude:  number | null;
  /** Server actions threaded down so this client component doesn't import them. */
  regeocodeAction: (practiceId: string) => Promise<RegeocodeResult>;
  setCoordsAction: (practiceId: string, latitude: number, longitude: number) => Promise<{ error: string | null }>;
  clearCoordsAction: (practiceId: string) => Promise<{ error: string | null }>;
};

// Admin-only panel for managing a practice's geocoded coordinates.
// Three controls:
//   • Re-geocode — re-runs Google geocoding against the stored address.
//     Used when signup-time geocoding failed (Google down / dev had no
//     key) or when the address has been corrected.
//   • Manual lat/long entry — fall-through when Google can't find the
//     pin or returns the wrong one. SA-range validated server-side.
//   • Clear — NULL the coords (takes the practice out of the
//     "practices near me" filter without removing the address).

export default function PracticeCoordsPanel({
  practiceId,
  latitude,
  longitude,
  regeocodeAction,
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

  function onRegeocode() {
    setMessage(null);
    startTransition(async () => {
      const r = await regeocodeAction(practiceId);
      if (r.ok) {
        setLatInput(String(r.latitude));
        setLngInput(String(r.longitude));
        flash('ok', `Geocoded to ${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}.`);
      } else {
        flash('error', r.error);
      }
    });
  }

  function onSave() {
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
    <div className="space-y-3">
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

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onRegeocode}
          disabled={isPending}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:shadow-md disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          {isPending ? 'Working…' : 'Re-geocode from address'}
        </button>
        <button
          type="button"
          onClick={onSave}
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
