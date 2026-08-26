'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import { parseAddressComponents } from '@/lib/maps/places';
import { updateLead } from '../leads/actions';
import {
  buildGoogleMapsDirUrl,
  nearestNeighbourOrder,
  pinColourForStage,
  STAGE_LEGEND,
} from '@/lib/crm/mapPlanner';
import type { MapLeadRow } from './page';
import { SPECIALTIES } from '@/lib/specialties';

// ─── /crm/map client ─────────────────────────────────────────────────
//
// Loads the Google Maps JS API from the existing NEXT_PUBLIC key when
// the component mounts. Renders pins colour-coded by stage. Tap → mini
// card. "Plan route" panel: select 2-8 leads, order them nearest-
// neighbour from a chosen start (or default to the first selection),
// build a /maps/dir/ deep link. No Directions-API calls — the URL
// hands off to Google Maps for the actual routing.

const STAGES = ['new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost'] as const;

type Props = {
  withCoords: MapLeadRow[];
  noCoords:   MapLeadRow[];
  apiKey:     string;
};

type FilterState = {
  stage:      string;
  specialty:  string;
  overdue:    boolean;
};

// Minimal Google Maps JS API type surface — enough for the calls we
// make here. Avoids pulling in @types/google.maps as a dep just for
// one route. Anything beyond these shapes is treated as `any` at the
// call site.
type LatLngLiteral = { lat: number; lng: number };
type GMap = {
  fitBounds: (bounds: unknown, padding?: number | { top?: number; right?: number; bottom?: number; left?: number }) => void;
};
type GMarker = { setMap: (m: GMap | null) => void; setIcon: (icon: unknown) => void; addListener: (name: string, cb: () => void) => void };
declare global {
  interface Window {
    google?: {
      maps: {
        Map:                new (el: HTMLElement, opts: unknown) => GMap;
        Marker:             new (opts: unknown) => GMarker;
        LatLngBounds:       new () => { extend: (p: LatLngLiteral) => void };
        SymbolPath:         { CIRCLE: unknown };
      };
    };
    gm_authFailure?: () => void;
  }
}
// Local shortcut — resolved at runtime after the script loads.
type GNS = NonNullable<Window['google']>;

// Sized up from Google's default marker scale and given a heavier white
// stroke so pins read clearly against the basemap — small/thin pins were
// getting lost among Google's own road and POI icon clutter.
function pinIcon(g: GNS, color: string, selected: boolean) {
  return {
    path: g.maps.SymbolPath.CIRCLE,
    scale: selected ? 13 : 9,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 2.5,
  };
}

export default function MapClient({ withCoords, noCoords, apiKey }: Props) {
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [filters,  setFilters]  = useState<FilterState>({ stage: '', specialty: '', overdue: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routeIds,   setRouteIds]   = useState<string[]>([]);
  const [start,      setStart]      = useState<{ lat: number; lng: number } | null>(null);
  const [locErr,     setLocErr]     = useState<string | null>(null);
  const [noCoordRows, setNoCoordRows] = useState<MapLeadRow[]>(noCoords);
  const [pinRows,     setPinRows]     = useState<MapLeadRow[]>(withCoords);

  const mapRef  = useRef<HTMLDivElement>(null);
  const mapInst = useRef<GMap | null>(null);
  const markers = useRef<Map<string, GMarker>>(new Map());

  // ── Filtered set — shared logic with the list view (client-side) ──
  const visiblePins = pinRows.filter(r => {
    if (filters.stage     && r.stage     !== filters.stage)     return false;
    if (filters.specialty && r.specialty !== filters.specialty) return false;
    if (filters.overdue   && !r.overdueFollowup)                return false;
    return true;
  });

  // ── Load Google Maps JS API ────────────────────────────────────
  useEffect(() => {
    if (!apiKey) { setMapError('missing_key'); return; }
    if (typeof window === 'undefined') return;
    if (window.google?.maps) { setMapReady(true); return; }

    // Google calls this global (rather than the <script> 'error' event) when
    // the key loads but is rejected at runtime — wrong referrer restriction,
    // Maps JS API not enabled on the key, quota exceeded, etc. Without this,
    // the script's 'load' event still fires and the map silently stays a
    // blank/grey box with only a console error to explain why.
    window.gm_authFailure = () => setMapError('auth_failure');

    const existing = document.querySelector<HTMLScriptElement>('script[data-crm-maps-loader="1"]');
    if (existing) {
      existing.addEventListener('load',  () => setMapReady(true));
      existing.addEventListener('error', () => setMapError('script_error'));
      return;
    }
    // NOTE: deliberately no `loading=async` — with it, google.maps.Map /
    // Marker / LatLngBounds / SymbolPath are only populated via an explicit
    // google.maps.importLibrary() call, not synchronously on script 'load'.
    // Every access below (e.g. `new g.maps.Map(...)`) assumes synchronous
    // population, so we use the classic loading mode that guarantees it.
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
    s.async = true;
    s.defer = true;
    s.setAttribute('data-crm-maps-loader', '1');
    s.addEventListener('load',  () => setMapReady(true));
    s.addEventListener('error', () => setMapError('script_error'));
    document.head.appendChild(s);
  }, [apiKey]);

  // ── Instantiate the map once ready ─────────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    if (!mapRef.current) return;
    if (mapInst.current) return;
    const g: GNS | undefined = window.google;
    if (!g) return;
    // Default centre: Johannesburg CBD-ish.
    mapInst.current = new g.maps.Map(mapRef.current, {
      center: { lat: -26.2041, lng: 28.0473 },
      zoom:   9,
      mapTypeControl: false,
      streetViewControl: false,
      // Quiet the default basemap furniture (POI icons/labels, transit,
      // highway shields) so the stage-coloured lead pins stand out —
      // otherwise they get lost among Google's own icon clutter.
      styles: [
        { featureType: 'poi',      elementType: 'labels', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi',      elementType: 'geometry', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit',  stylers: [{ visibility: 'off' }] },
        { featureType: 'road',     elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
      ],
    });
    if (visiblePins.length > 0) {
      const bounds = new g.maps.LatLngBounds();
      for (const p of visiblePins) if (p.lat != null && p.lng != null) bounds.extend({ lat: p.lat, lng: p.lng });
      mapInst.current.fitBounds(bounds, 48);
    }
    // We intentionally build markers in a separate effect below.
  }, [mapReady, visiblePins]);

  // ── Sync markers with the filtered pin set ─────────────────────
  useEffect(() => {
    if (!mapReady || !mapInst.current) return;
    const g: GNS | undefined = window.google;
    if (!g) return;
    const wanted = new Set(visiblePins.map(p => p.id));
    for (const [id, marker] of markers.current) {
      if (!wanted.has(id)) { marker.setMap(null); markers.current.delete(id); }
    }
    for (const p of visiblePins) {
      if (p.lat == null || p.lng == null) continue;
      let m = markers.current.get(p.id);
      const color = pinColourForStage(p.stage);
      const icon = pinIcon(g, color, routeIds.includes(p.id));
      if (!m) {
        m = new g.maps.Marker({
          position: { lat: p.lat, lng: p.lng },
          map:      mapInst.current,
          title:    p.practiceName,
          icon,
          zIndex: routeIds.includes(p.id) ? 999 : undefined,
        });
        m.addListener('click', () => setSelectedId(p.id));
        markers.current.set(p.id, m);
      } else {
        m.setIcon(icon);
      }
    }
  }, [visiblePins, routeIds, mapReady]);

  // ── Selected mini-card ────────────────────────────────────────
  const selectedLead = pinRows.find(r => r.id === selectedId) ?? null;

  // ── Route helpers ─────────────────────────────────────────────
  function toggleRoute(id: string) {
    setRouteIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 8) return prev;
      return [...prev, id];
    });
  }

  const orderedRouteStops = useCallback(() => {
    const stops = routeIds
      .map(id => pinRows.find(r => r.id === id))
      .filter((r): r is MapLeadRow => !!r && r.lat != null && r.lng != null)
      .map(r => ({ id: r.id, lat: r.lat!, lng: r.lng! }));
    if (stops.length < 2) return [];
    const origin = start ?? { lat: stops[0].lat, lng: stops[0].lng };
    return nearestNeighbourOrder(origin, stops);
  }, [routeIds, pinRows, start]);

  function useMyLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocErr('Your browser doesn\'t support geolocation.');
      return;
    }
    // Explicit user gesture — prompt is safe here.
    navigator.geolocation.getCurrentPosition(
      (pos) => setStart({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setLocErr(err.message || 'Could not get your location.'),
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 8_000 },
    );
  }

  const routeUrl = orderedRouteStops().length >= 2
    ? buildGoogleMapsDirUrl(start, orderedRouteStops())
    : null;

  // ── Backfill lat/lng for a no-coord lead ──────────────────────
  async function backfillCoords(leadId: string, addressLine: string, latitude: number, longitude: number, place: {
    street: string | null; suburb: string | null; city: string | null; province: string | null;
  }) {
    const res = await updateLead(leadId, {
      formatted_address: addressLine,
      street_address:    place.street ?? addressLine,
      latitude,
      longitude,
      suburb:   place.suburb   ?? undefined,
      city:     place.city     ?? undefined,
      province: place.province ?? undefined,
    });
    if (res.error) { alert(res.error); return; }
    // Move the row from noCoords → withCoords in local state.
    const backfilled = noCoordRows.find(r => r.id === leadId);
    if (!backfilled) return;
    const promoted: MapLeadRow = { ...backfilled, lat: latitude, lng: longitude };
    setNoCoordRows(prev => prev.filter(r => r.id !== leadId));
    setPinRows(prev => [...prev, promoted]);
  }

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-140px)] md:h-[calc(100vh-70px)]">
      {/* Map */}
      <div className="relative flex-1 min-h-[300px]" data-testid="crm-map-container">
        {mapError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
            <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm max-w-md text-center" data-testid="crm-map-error">
              {mapError === 'missing_key'
                ? 'Google Maps API key not set (NEXT_PUBLIC_GOOGLE_PLACES_KEY). Ask the admin to configure it.'
                : mapError === 'auth_failure'
                ? "Google Maps rejected the API key at runtime. In GCP Console, check that the key's API restrictions include \"Maps JavaScript API\" (not just Places API) and that its HTTP referrer allow-list covers this domain."
                : 'The Google Maps JS API failed to load. If this persists, the key may not be restricted to include the Maps JavaScript API.'
              }
            </div>
          </div>
        ) : !mapReady ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">Loading map…</div>
        ) : null}
        <div ref={mapRef} className="absolute inset-0" />
      </div>

      {/* Side panel */}
      <aside className="md:w-96 flex-shrink-0 border-l border-gray-200 bg-white overflow-y-auto p-4 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">Map</h1>
          <p className="text-xs text-gray-500">Territory-planning view — {visiblePins.length} plotted, {noCoordRows.length} without coords.</p>
        </div>

        {/* Filters — shared shape with /crm/leads */}
        <div className="space-y-2" data-testid="crm-map-filters">
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-xs text-gray-500 uppercase tracking-wide">Stage:</span>
            <button type="button" onClick={() => setFilters(f => ({ ...f, stage: '' }))} className={chip(!filters.stage)}>All</button>
            {STAGES.map(s => (
              <button key={s} type="button" onClick={() => setFilters(f => ({ ...f, stage: f.stage === s ? '' : s }))} className={chip(filters.stage === s)}>
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-xs text-gray-500 uppercase tracking-wide">Specialty:</span>
            <button type="button" onClick={() => setFilters(f => ({ ...f, specialty: '' }))} className={chip(!filters.specialty)}>All</button>
            {SPECIALTIES.map(s => (
              <button key={s} type="button" onClick={() => setFilters(f => ({ ...f, specialty: f.specialty === s ? '' : s }))} className={chip(filters.specialty === s)}>
                {s}
              </button>
            ))}
          </div>
          <div>
            <button
              type="button"
              onClick={() => setFilters(f => ({ ...f, overdue: !f.overdue }))}
              className={
                'rounded-full px-3 py-1 text-xs font-medium border ' +
                (filters.overdue ? 'border-red-200 bg-red-50 text-red-800' : 'border-gray-200 bg-white text-gray-600')
              }
              data-testid="crm-map-overdue-filter"
            >
              Overdue follow-up only
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs" data-testid="crm-map-legend">
          <p className="font-semibold text-gray-700 mb-1.5">Pin colours</p>
          <ul className="grid grid-cols-2 gap-1">
            {STAGE_LEGEND.map(l => (
              <li key={l.key} className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: l.color }} aria-hidden />
                <span className="capitalize">{l.label}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Selected mini-card */}
        {selectedLead && (
          <div className="rounded-xl border border-gray-200 p-3" data-testid="crm-map-selected-card">
            <p className="text-sm font-semibold" style={{ color: '#13294B' }}>{selectedLead.practiceName}</p>
            <p className="text-xs text-gray-600">{selectedLead.contactName}</p>
            <p className="mt-1 text-xs text-gray-500 capitalize">Stage: {selectedLead.stage.replace(/_/g, ' ')}</p>
            {selectedLead.nextFollowUpAt && (
              <p className="text-xs text-gray-500">
                Follow-up: {new Date(selectedLead.nextFollowUpAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })}
              </p>
            )}
            {selectedLead.suburbCity && <p className="text-xs text-gray-500">{selectedLead.suburbCity}</p>}
            <div className="mt-2 flex gap-2 flex-wrap">
              {selectedLead.phone && (
                <a href={`tel:${selectedLead.phone}`} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-2 py-1 text-xs">Call</a>
              )}
              <Link href={`/crm/leads/${selectedLead.id}`} className="rounded-lg bg-[#13294B] text-white px-2 py-1 text-xs">Open lead →</Link>
              <button type="button" onClick={() => toggleRoute(selectedLead.id)} className="rounded-lg border border-[#15A89E] text-[#15A89E] bg-white px-2 py-1 text-xs">
                {routeIds.includes(selectedLead.id) ? 'Remove from route' : 'Add to route'}
              </button>
            </div>
          </div>
        )}

        {/* Route planner */}
        <div className="rounded-xl border border-gray-200 p-3 space-y-2" data-testid="crm-map-route-panel">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Plan route</p>
            <p className="text-xs text-gray-500 tabular-nums">{routeIds.length} of 8</p>
          </div>
          {routeIds.length === 0 ? (
            <p className="text-xs text-gray-500">Tap pins or lead rows to add stops. Order is optimised nearest-neighbour from your chosen start.</p>
          ) : (
            <ol className="text-xs text-gray-700 list-decimal pl-4 space-y-0.5">
              {orderedRouteStops().map((s, i) => {
                const r = pinRows.find(x => x.id === s.id);
                return <li key={s.id + i}>{r?.practiceName ?? s.id}</li>;
              })}
            </ol>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={useMyLocation} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-2 py-1.5 text-xs">
              Start from my location
            </button>
            {start && <button type="button" onClick={() => setStart(null)} className="rounded-lg border border-gray-200 bg-white text-gray-500 px-2 py-1.5 text-xs">Clear start</button>}
          </div>
          {locErr && <p role="alert" className="text-xs text-red-700">{locErr}</p>}
          {routeUrl ? (
            <a
              href={routeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex rounded-lg bg-[#13294B] text-white px-3 py-2 text-xs font-medium"
              data-testid="crm-map-open-in-google"
            >
              Open in Google Maps →
            </a>
          ) : routeIds.length > 0 && routeIds.length < 2 ? (
            <p className="text-xs text-gray-500">Add at least 2 stops.</p>
          ) : null}
        </div>

        {/* No-coords tray */}
        {noCoordRows.length > 0 && (
          <div className="rounded-xl border border-gray-200 p-3 space-y-2" data-testid="crm-map-no-coords-tray">
            <p className="text-sm font-semibold text-gray-900">Missing coordinates ({noCoordRows.length})</p>
            <p className="text-[11px] text-gray-500">These leads have no lat/lng. Add an address and we&apos;ll pin them.</p>
            <ul className="space-y-2 max-h-80 overflow-y-auto">
              {noCoordRows.map(r => (
                <li key={r.id} className="rounded-lg border border-gray-100 p-2">
                  <p className="text-xs font-semibold text-gray-900 truncate">{r.practiceName}</p>
                  <p className="text-[11px] text-gray-500">{r.contactName}</p>
                  <div className="mt-1">
                    <PlacesAutocomplete
                      variant="address"
                      inputId={`backfill-${r.id}`}
                      placeholder="Search their address…"
                      onSelect={(place) => {
                        const parsed = parseAddressComponents(place.addressComponents);
                        void backfillCoords(r.id, place.formattedAddress, place.latitude, place.longitude, {
                          street:   parsed.addressLine1,
                          suburb:   parsed.suburb,
                          city:     parsed.city,
                          province: parsed.province,
                        });
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

function chip(active: boolean): string {
  return 'rounded-full px-3 py-1 text-xs font-medium border capitalize ' +
    (active
      ? 'border-[#15A89E] bg-[#15A89E]/10 text-[#15A89E]'
      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300');
}
