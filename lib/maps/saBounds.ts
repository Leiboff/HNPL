// ─── South-Africa coordinate bounding box ──────────────────────────────
//
// Backstop validation for any lat/long that lands in the DB — whether
// from Places (a real picked place will pass), from admin manual entry
// (the load-bearing reason this exists), or from a future import.
//
// SA's mainland bounding box is roughly:
//   latitude  ∈ [-35, -22]   (south latitudes — note the sign)
//   longitude ∈ [16, 33]     (east longitudes)
//
// A manual entry outside this range is almost certainly a transposed /
// wrong-sign typo (positive latitude → Arabian Sea; negative longitude
// → Pacific). Rejecting at the action layer surfaces the typo to the
// admin instead of pinning the practice on the wrong continent.

export const SA_BOUNDS = {
  latMin: -35,
  latMax: -22,
  lngMin:  16,
  lngMax:  33,
} as const;

export function isWithinSouthAfrica(latitude: number, longitude: number): boolean {
  return (
    latitude  >= SA_BOUNDS.latMin && latitude  <= SA_BOUNDS.latMax &&
    longitude >= SA_BOUNDS.lngMin && longitude <= SA_BOUNDS.lngMax
  );
}
