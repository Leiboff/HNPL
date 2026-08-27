// ─── Route planner + pin colour + Google Maps deep-link URL ─────────
//
// Pure helpers so both the client (interactive planner) and unit tests
// (route order + URL construction) can share them.

export type Stop = { id: string; lat: number; lng: number };
export type Origin = { lat: number; lng: number };

/** Haversine distance in km between two lat/lng points. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const c = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
}

/**
 * Nearest-neighbour ordering. Given a start point + selected stops,
 * repeatedly picks the nearest remaining stop until all are consumed.
 * Deterministic; order-of-input-independent for equal distances.
 */
export function nearestNeighbourOrder(origin: Origin, stops: Stop[]): Stop[] {
  const remaining = stops.slice();
  const out: Stop[] = [];
  let cursor: Origin = origin;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(cursor, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [chosen] = remaining.splice(bestIdx, 1);
    out.push(chosen);
    cursor = { lat: chosen.lat, lng: chosen.lng };
  }
  return out;
}

/**
 * Build a Google Maps /dir/ deep link. The URL format Google supports:
 *   https://www.google.com/maps/dir/<start>/<stop1>/<stop2>/…
 * Each segment is either "lat,lng" or a URL-encoded place string. We
 * always use lat,lng to avoid Places API calls.
 *
 * Start is optional — when omitted, Google interprets the first stop
 * as the current location on the driver's device.
 */
export function buildGoogleMapsDirUrl(
  start:  { lat: number; lng: number } | null,
  stops:  Array<{ lat: number; lng: number }>,
): string {
  const enc = (p: { lat: number; lng: number }) => `${p.lat},${p.lng}`;
  const parts: string[] = [];
  if (start) parts.push(enc(start));
  for (const s of stops) parts.push(enc(s));
  return `https://www.google.com/maps/dir/${parts.map(encodeURIComponent).join('/')}`;
}

/**
 * Pin colour per stage. Legend labels in-line for the client to
 * render alongside the map. Signed / onboarded / lost use muted tones
 * so live-pipeline stages pop.
 */
export const STAGE_PIN_COLORS: Record<string, string> = {
  new:               '#94A3B8',
  contacted:         '#3B82F6',
  meeting_scheduled: '#F59E0B',
  demo_done:         '#8B5CF6',
  agreement_sent:    '#EF4444',
  nurture:           '#A78BFA',
  signed:            '#10B981',
  onboarded:         '#0F766E',
  lost:              '#6B7280',
};

export const STAGE_LEGEND: Array<{ key: string; label: string; color: string }> = [
  { key: 'new',                label: 'New',                color: STAGE_PIN_COLORS.new },
  { key: 'contacted',          label: 'Contacted',          color: STAGE_PIN_COLORS.contacted },
  { key: 'meeting_scheduled',  label: 'Meeting scheduled',  color: STAGE_PIN_COLORS.meeting_scheduled },
  { key: 'demo_done',          label: 'Demo done',          color: STAGE_PIN_COLORS.demo_done },
  { key: 'agreement_sent',     label: 'Agreement sent',     color: STAGE_PIN_COLORS.agreement_sent },
  { key: 'nurture',            label: 'Nurture',            color: STAGE_PIN_COLORS.nurture },
  { key: 'signed',             label: 'Signed',             color: STAGE_PIN_COLORS.signed },
  { key: 'onboarded',          label: 'Onboarded',          color: STAGE_PIN_COLORS.onboarded },
  { key: 'lost',               label: 'Lost',               color: STAGE_PIN_COLORS.lost },
];

export function pinColourForStage(stage: string): string {
  return STAGE_PIN_COLORS[stage] ?? STAGE_PIN_COLORS.new;
}
