// ─── Parse a single "Location" import column into suburb/city/province ──
//
// Bulk-import sources describe a lead's location as one free-text
// column, typically "<suburb> , <municipality>, <province>" (e.g.
// "Springs , Springs, Gauteng"). Google's Places Text Search
// (lib/crm/localityGeocode.ts) takes the whole string as its query, but
// crm_leads stores suburb/city/province as separate columns for
// filtering — so we split defensively rather than assume exactly 3
// comma-separated parts are always present.

export type ParsedLocation = {
  suburb:   string | null;
  city:     string | null;
  province: string | null;
};

export function parseNeighbourhoodLocation(raw: string): ParsedLocation {
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 3) return { suburb: parts[0], city: parts[1], province: parts.slice(2).join(', ') };
  if (parts.length === 2) return { suburb: null, city: parts[0], province: parts[1] };
  if (parts.length === 1) return { suburb: null, city: null, province: parts[0] };
  return { suburb: null, city: null, province: null };
}
