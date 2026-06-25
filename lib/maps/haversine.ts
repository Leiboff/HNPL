// ─── Haversine — great-circle distance between two lat/long points ────
//
// Pure math, client-side. Used by the explore page to sort practices
// by distance from the user (geolocation OR a typed suburb that was
// geocoded server-side). No PostGIS, no Distance Matrix API — straight-
// line is the right model for "practices near me." Driving distance
// would be wrong anyway: a 5 km practice across a freeway feels closer
// than one 3 km away on the wrong side of a no-bridge ravine.
//
// Mean earth radius = 6371 km. Returns kilometres.

const EARTH_RADIUS_KM = 6371;

export type LatLng = { latitude: number; longitude: number };

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Haversine great-circle distance in kilometres. Symmetric:
 * haversineKm(a, b) === haversineKm(b, a).
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude  - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

/**
 * Format a km distance for the practice card. Below 10 km show one
 * decimal place ("3.2 km away"); above show whole km ("47 km away").
 * Negative or NaN guards return an empty string so a botched input
 * doesn't render "NaN km".
 */
export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km) || km < 0) return '';
  if (km < 10) return `${km.toFixed(1)} km away`;
  return `${Math.round(km)} km away`;
}
