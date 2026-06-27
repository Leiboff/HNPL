'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  autocompletePlaces,
  fetchPlaceDetails,
  newSessionToken,
  type PlaceSuggestion,
  type PlaceDetails,
} from '@/lib/maps/places';

// ─── PlacesAutocomplete — shared type-ahead picker ──────────────────────
//
// Owns the Places (New) session-token lifecycle so cost-correctness
// happens by construction, not by caller discipline:
//   • Mints ONE token on mount (and after each selection).
//   • Passes THAT token on every keystroke's Autocomplete request.
//   • Passes THAT token on the terminating Place Details request.
//   • Mints a fresh token after the selection — the previous one is
//     consumed by the Place Details call.
//
// Used at three sites:
//   • Practice signup (variant='address')           — street-address bias.
//   • Patient explore suburb search (variant='locality') — locality bias.
//   • Admin practice coords re-pick (variant='address')  — street bias.
//
// Each call site gets the same UX: type → dropdown → click → onSelect
// fires with full PlaceDetails (formattedAddress + lat/lng + parsed
// components). The component itself doesn't store the choice — the
// parent does, in whatever shape it needs.

const DEBOUNCE_MS = 200;

export type PlacesVariant = 'address' | 'locality';

type Props = {
  /** UX placeholder for the text field. */
  placeholder?: string;
  /** Initial text value (e.g. an existing practice's stored address). */
  initialValue?: string;
  /** id for the underlying input (for label association). */
  inputId?: string;
  /** Disabled while a parent action is in-flight. */
  disabled?: boolean;
  /**
   *  'address'  — bias to street_address / premise (full pickable addresses).
   *  'locality' — bias to localities/sublocalities (suburb/area search).
   */
  variant: PlacesVariant;
  /**
   * Fires once a place's full details are loaded. The parent stores
   * what it needs (lat/lng for the suburb search; lat/lng + formatted
   * address + parsed components for the signup / admin re-pick).
   */
  onSelect: (place: PlaceDetails) => void;
  /** Optional className override on the wrapping div. */
  className?: string;
};

const PRIMARY_TYPES_BY_VARIANT: Record<PlacesVariant, string[] | undefined> = {
  // Full addresses — leave empty for Google's default ranking (best UX
  // for real residential / business addresses).
  address:  undefined,
  // Locality bias — picks suburbs and the broader administrative
  // areas, not individual street addresses. Matches a patient typing
  // "Rosebank".
  locality: ['locality', 'sublocality'],
};

export default function PlacesAutocomplete({
  placeholder,
  initialValue = '',
  inputId,
  disabled = false,
  variant,
  onSelect,
  className,
}: Props) {
  const [query,      setQuery]      = useState(initialValue);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open,       setOpen]       = useState(false);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // Session-token lifecycle: ONE per autocomplete-→-selection cycle.
  // Ref keeps it stable across re-renders (we don't want it in state
  // because changing it shouldn't trigger renders).
  const sessionTokenRef = useRef<string>('');
  useEffect(() => {
    // Mint the first token client-side only (crypto.randomUUID is
    // browser/Node). Avoids SSR mismatch.
    sessionTokenRef.current = newSessionToken();
  }, []);

  // Debounce the input → autocomplete fetch. Cancel-on-change pattern
  // prevents a slow request landing AFTER a newer keystroke and
  // overwriting fresh suggestions with stale ones.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(0);

  const containerRef = useRef<HTMLDivElement>(null);

  const fetchSuggestions = useCallback(async (input: string) => {
    if (!sessionTokenRef.current) return;
    const reqId = ++inFlightRef.current;
    setLoading(true);
    setError(null);
    const out = await autocompletePlaces(input, sessionTokenRef.current, {
      includedPrimaryTypes: PRIMARY_TYPES_BY_VARIANT[variant],
    });
    if (reqId !== inFlightRef.current) return; // stale response
    setSuggestions(out);
    setOpen(out.length > 0);
    setLoading(false);
  }, [variant]);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!v.trim()) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => { void fetchSuggestions(v); }, DEBOUNCE_MS);
  }

  async function onPick(suggestion: PlaceSuggestion) {
    setOpen(false);
    setLoading(true);
    setError(null);
    const tokenInUse = sessionTokenRef.current;
    const details    = await fetchPlaceDetails(suggestion.placeId, tokenInUse);
    setLoading(false);
    if (!details) {
      setError("Couldn't load the selected place's details. Please try again.");
      return;
    }
    setQuery(details.formattedAddress);
    // Mint a fresh token AFTER the terminating Place Details call.
    // The previous token is now consumed; the next interaction is a
    // new session. Without this, the next keystroke would re-use the
    // consumed token and bill at per-keystroke rates.
    sessionTokenRef.current = newSessionToken();
    onSelect(details);
  }

  // Close on outside click — real menu semantics.
  useEffect(() => {
    if (!open) return;
    function handler(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  const inputCls =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
    'focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed';

  const apiKeyMissing = typeof process !== 'undefined' && !process.env.NEXT_PUBLIC_GOOGLE_PLACES_KEY;

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <input
        id={inputId}
        type="text"
        value={query}
        onChange={onChange}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className={inputCls}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          {suggestions.map((s) => (
            <li key={s.placeId} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => { void onPick(s); }}
                className="w-full text-left px-3 py-2 hover:bg-gray-50"
              >
                <p className="text-sm font-medium text-gray-900 truncate">{s.primaryText}</p>
                {s.secondaryText && (
                  <p className="text-xs text-gray-500 truncate">{s.secondaryText}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && (
        <p className="mt-1 text-[11px] text-gray-500">Searching…</p>
      )}
      {error && (
        <p className="mt-1 text-[11px] text-red-600">{error}</p>
      )}
      {apiKeyMissing && (
        <p className="mt-1 text-[11px] text-amber-700">
          Places API key not configured (dev only).
        </p>
      )}
    </div>
  );
}
