'use client';

import { useMemo, useState } from 'react';
import LeadsToolbar from './LeadsToolbar';
import LeadsResultsList, { type LeadRow } from './LeadsResultsList';
import type { LeadScore } from '@/lib/crm/priorityScore';
import { haversineKm } from '@/lib/crm/mapPlanner';

// ─── Leads list surface — toolbar + results, distance-sort owner ──────
//
// Only the browser knows the viewer's live location, so distance-from-me
// can't be a server-driven sort like the others. This component is the
// one place that owns that geolocation state, deriving both the active
// indicator/option for LeadsToolbar's Sort sheet and the display order +
// per-row km for LeadsResultsList — the two children stay simple/props-in.

export default function LeadsListSection({
  rows, owners, scores, specialties, cities, isAdmin, currentUserId,
}: {
  rows: LeadRow[];
  owners: Array<{ id: string; name: string }>;
  scores?: Record<string, LeadScore>;
  specialties: readonly string[];
  cities: string[];
  isAdmin: boolean;
  currentUserId: string;
}) {
  const [userLoc, setUserLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [locErr, setLocErr] = useState<string | null>(null);
  const [sortByDistance, setSortByDistance] = useState(false);
  const [locating, setLocating] = useState(false);

  function requestDistanceSort() {
    if (userLoc) { setSortByDistance(true); return; }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocErr("Your browser doesn't support location.");
      return;
    }
    setLocating(true);
    setLocErr(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setSortByDistance(true);
        setLocating(false);
      },
      (err) => {
        setLocErr(err.message || 'Could not get your location.');
        setLocating(false);
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 8_000 },
    );
  }

  const distanceById = useMemo(() => {
    if (!sortByDistance || !userLoc) return undefined;
    const map: Record<string, number | null> = {};
    for (const r of rows) {
      map[r.id] = r.latitude != null && r.longitude != null
        ? haversineKm(userLoc, { lat: r.latitude, lng: r.longitude })
        : null;
    }
    return map;
  }, [sortByDistance, userLoc, rows]);

  const displayRows = useMemo(() => {
    if (!distanceById) return rows;
    return [...rows].sort((a, b) => {
      const da = distanceById[a.id];
      const db = distanceById[b.id];
      if (da == null && db == null) return 0;
      if (da == null) return 1;   // no coords — sinks to the bottom
      if (db == null) return -1;
      return da - db;
    });
  }, [rows, distanceById]);

  return (
    <div className="space-y-3">
      <LeadsToolbar
        specialties={specialties}
        cities={cities}
        owners={owners}
        isAdmin={isAdmin}
        currentUserId={currentUserId}
        distanceSortActive={sortByDistance}
        locating={locating}
        onSelectDistanceSort={requestDistanceSort}
      />
      {locErr && <div role="alert" className="text-xs rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700">{locErr}</div>}
      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <p className="text-gray-500">No leads match. Try clearing filters or creating a new lead.</p>
        </div>
      ) : (
        <LeadsResultsList
          rows={displayRows}
          owners={owners}
          scores={scores}
          distanceById={distanceById}
        />
      )}
    </div>
  );
}
