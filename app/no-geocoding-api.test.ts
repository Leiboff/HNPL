import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Regression — the legacy Geocoding API integration is confined ─────
//
// The "Places (New) everywhere" sweep retired the free-form use of the
// legacy Geocoding integration:
//   • lib/maps/geocode.ts                       (server-side Geocoding wrapper) — REMOVED
//   • app/patient/explore/actions.ts            (geocodeSuburb server action)   — REMOVED
//   • regeocodePractice action                  (admin re-geocode)              — REMOVED
//   • GOOGLE_MAPS_API_KEY                       (server-only Geocoding key)     — REMOVED
//
// Reverse geocoding then moved to Places (New) SearchNearby, which
// returns nothing in POI-sparse areas (most residential SA). To keep
// the feature working we brought the Geocoding endpoint BACK on a
// SINGLE server-only route — app/api/reverse-geocode/route.ts — using
// a new server-only key GOOGLE_GEOCODING_SERVER_KEY. That endpoint is
// still forbidden EVERYWHERE ELSE in the codebase, because:
//   • Our NEXT_PUBLIC_GOOGLE_PLACES_KEY is HTTP-referrer-restricted
//     (correctly — it's a browser key).
//   • The Geocoding web service rejects referrer-restricted keys —
//     any browser call to maps.googleapis.com/maps/api/geocode with
//     that key 403s in production while passing mocked tests.
// So the endpoint's ONLY authorised caller is the server route above.
//
// These tests guard both the confinement (allow-listed callers) and
// the residual removals (old symbols still gone). They walk the source
// tree directly, excluding THIS test file from its own scan so the
// literal mentions of retired / confined symbols in the test comments
// don't false-positive.

const ROOT       = resolve(process.cwd());
const SCAN_DIRS  = ['app', 'lib'];
const SKIP_DIRS  = new Set(['node_modules', '.next', '.turbo', '.git']);
const SELF       = 'app/no-geocoding-api.test.ts'; // exclude self from scans

function* walk(dir: string): Generator<string> {
  let names: string[];
  // Use the string-overload explicitly (third overload via no options).
  // readdirSync() can return Dirent[] depending on options/types; the
  // bare call returns string[] which is what we want here.
  try { names = readdirSync(dir) as string[]; } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) yield* walk(full);
    else if (s.isFile()) {
      const rel = full.slice(ROOT.length + 1).split('\\').join('/');
      if (rel === SELF) continue;
      // Source-only — skip lock files, generated assets, fixtures.
      if (/\.(ts|tsx|js|jsx|sql|json|md)$/.test(name)) yield full;
    }
  }
}

function search(pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(resolve(ROOT, dir))) {
      let content: string;
      try { content = readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          const rel = file.slice(ROOT.length + 1).split('\\').join('/');
          hits.push({ file: rel, line: i + 1, text: lines[i] });
        }
      }
    }
  }
  return hits;
}

describe('Geocoding API — confined to the ONE server-only route', () => {
  it('the Geocoding endpoint is referenced ONLY in app/api/reverse-geocode/{route.ts,route.test.ts}', () => {
    const hits = search(/maps\.googleapis\.com\/maps\/api\/geocode/);
    const files = new Set(hits.map((h) => h.file));
    // The confinement allow-list. Any other file appearing here is
    // an escape of the endpoint to a broader surface — including,
    // critically, the browser (referrer-restricted key would 403).
    const ALLOWED = new Set([
      'app/api/reverse-geocode/route.ts',
      'app/api/reverse-geocode/route.test.ts',
    ]);
    for (const f of files) {
      expect(ALLOWED.has(f)).toBe(true);
    }
    // The runtime file MUST reference the endpoint (this is a
    // presence assertion, not just an absence one).
    expect(files.has('app/api/reverse-geocode/route.ts')).toBe(true);
  });

  it('the endpoint is NEVER called from client code (a `use client` file)', () => {
    // A file that contains a call to the Geocoding endpoint AND
    // has 'use client' at the top would be a runtime 403 in prod.
    const hits = search(/maps\.googleapis\.com\/maps\/api\/geocode/);
    for (const { file } of hits) {
      const content = readFileSync(resolve(ROOT, file), 'utf8');
      const firstLine = content.split(/\r?\n/, 3).join('\n');
      expect(firstLine).not.toMatch(/^\s*['"]use client['"]/m);
    }
  });

  it('the lib/maps/geocode module still does not exist / is not imported', () => {
    expect(search(/['"]@\/lib\/maps\/geocode['"]/)).toEqual([]);
    expect(search(/['"]\.\.?\/.*lib\/maps\/geocode['"]/)).toEqual([]);
  });

  it('no code imports geocodeAddress (the old wrapper symbol)', () => {
    expect(search(/import\s*\{[^}]*\bgeocodeAddress\b/)).toEqual([]);
  });

  it('no source file READS process.env.GOOGLE_MAPS_API_KEY (retired name)', () => {
    // The retired name stays retired. The NEW server-only key is
    // GOOGLE_GEOCODING_SERVER_KEY — see the route file.
    expect(search(/process\.env\.GOOGLE_MAPS_API_KEY/)).toEqual([]);
  });

  it('the new server-only key IS read (and only from the server route file)', () => {
    const hits = search(/process\.env\.GOOGLE_GEOCODING_SERVER_KEY/);
    const files = new Set(hits.map((h) => h.file));
    expect(files.has('app/api/reverse-geocode/route.ts')).toBe(true);
    // No NEXT_PUBLIC prefix (would leak the key into the bundle).
    expect(search(/NEXT_PUBLIC_GOOGLE_GEOCODING/)).toEqual([]);
  });

  it('the regeocodePractice admin action no longer exists', () => {
    expect(search(/\bregeocodePractice\b/)).toEqual([]);
  });

  it('the geocodeSuburb server action no longer exists', () => {
    expect(search(/\bgeocodeSuburb\b/)).toEqual([]);
  });
});

describe('Places API (New) — wired in the right places, no server-side key leaked to the browser', () => {
  it('the Places (New) endpoints are only referenced in the Places wrapper modules + their tests', () => {
    const hits = search(/places\.googleapis\.com/);
    const files = new Set(hits.map((h) => h.file));
    // Runtime module + test companion for the browser-side
    // autocomplete / place-details wrapper. `reverseGeocode.test.ts`
    // may reference the URL only inside a negative-assertion string
    // ("never any places.googleapis.com URL from the browser") — the
    // scan can't distinguish literal-in-string from a call.
    const ALLOWED = new Set([
      'lib/maps/places.ts',
      'lib/maps/places.test.ts',
      'lib/maps/reverseGeocode.test.ts',
      // Server-only locality Text Search for the bulk quick-import path
      // (app/crm/import/quickActions.ts) — a SEPARATE, server-only key
      // (GOOGLE_PLACES_SERVER_KEY), never the browser one.
      'lib/crm/localityGeocode.ts',
      'lib/crm/localityGeocode.test.ts',
      // CSP must name the browser Places origin explicitly; this is a
      // connect-src permission, not another API call implementation.
      'lib/security/csp.ts',
      'lib/security/csp.test.ts',
    ]);
    for (const f of files) {
      expect(ALLOWED.has(f)).toBe(true);
    }
    expect(files.has('lib/maps/places.ts')).toBe(true);
  });

  it('the field mask declared in lib/maps/places is Essentials-only', () => {
    const places = readFileSync(resolve(ROOT, 'lib/maps/places.ts'), 'utf8');
    // The single source-of-truth field mask constant.
    expect(places).toMatch(/PLACE_DETAILS_FIELD_MASK\s*=\s*['"]id,location,formattedAddress,addressComponents['"]/);
    // Pro/Atmosphere fields must NOT appear as quoted strings in
    // places.ts (e.g. inside a field-mask constant). The [^'"\r\n]
    // class keeps the match anchored to a single line so bare-word
    // mentions in a multi-line JSDoc comment don't false-positive.
    expect(places).not.toMatch(/['"][^'"\r\n]*reviews?[^'"\r\n]*['"]/);
    expect(places).not.toMatch(/['"][^'"\r\n]*\bphotos?\b[^'"\r\n]*['"]/);
    expect(places).not.toMatch(/['"][^'"\r\n]*openingHours[^'"\r\n]*['"]/);
    expect(places).not.toMatch(/['"][^'"\r\n]*priceLevel[^'"\r\n]*['"]/);
    expect(places).not.toMatch(/['"][^'"\r\n]*\brating\b[^'"\r\n]*['"]/);
  });

  it('the ONLY Google env reaching the browser bundle is the Places key', () => {
    // Find every NEXT_PUBLIC_*GOOGLE* identifier reference. Only the
    // Places key should appear; the old server-only key, if it ever
    // ended up here, would surface as NEXT_PUBLIC_GOOGLE_MAPS_*.
    const hits = search(/NEXT_PUBLIC_[A-Z_]*GOOGLE[A-Z_]*/);
    const idents = new Set<string>();
    for (const h of hits) {
      const m = h.text.match(/NEXT_PUBLIC_[A-Z_]*GOOGLE[A-Z_]*/);
      if (m) idents.add(m[0]);
    }
    expect(Array.from(idents)).toEqual(['NEXT_PUBLIC_GOOGLE_PLACES_KEY']);
  });
});
