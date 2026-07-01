import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Regression — the legacy Geocoding API integration is fully removed ─
//
// The "Places (New) everywhere" migration retired:
//   • lib/maps/geocode.ts                       (server-side Geocoding wrapper)
//   • app/patient/explore/actions.ts            (geocodeSuburb server action)
//   • regeocodePractice action                  (admin re-geocode)
//   • GOOGLE_MAPS_API_KEY                       (server-only Geocoding key)
//
// These tests guard the removal. They walk the source tree directly (no
// git grep — which would miss untracked / staged-only files), excluding
// THIS test file from its own scan so the literal mentions of retired
// symbols in the test comments + descriptions don't false-positive.

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

describe('Geocoding API — fully removed', () => {
  it('no source file references the Geocoding REST endpoint', () => {
    expect(search(/maps\.googleapis\.com\/maps\/api\/geocode/)).toEqual([]);
  });

  it('the lib/maps/geocode module no longer exists / is imported anywhere', () => {
    expect(search(/['"]@\/lib\/maps\/geocode['"]/)).toEqual([]);
    expect(search(/['"]\.\.?\/.*lib\/maps\/geocode['"]/)).toEqual([]);
  });

  it('no code imports geocodeAddress (the old wrapper symbol)', () => {
    // Match the import-statement shape so the test's own narrative
    // mentions ("the geocodeAddress wrapper") don't false-positive.
    expect(search(/import\s*\{[^}]*\bgeocodeAddress\b/)).toEqual([]);
  });

  it('no source file READS process.env.GOOGLE_MAPS_API_KEY (retired)', () => {
    // The server-only Geocoding key is gone. The browser-exposed
    // Places key (NEXT_PUBLIC_GOOGLE_PLACES_KEY) is the only Google
    // env reference now. A narrative comment mentioning the retired
    // name is fine; what's not fine is any code actually READING it.
    expect(search(/process\.env\.GOOGLE_MAPS_API_KEY/)).toEqual([]);
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
    // Runtime modules and their test companions are the only
    // acceptable owners of the Places (New) URL. The forward-lookup
    // wrapper (places.ts) + the reverse-geocode wrapper
    // (reverseGeocode.ts) are the two modules; both may be
    // referenced by their `.test` companions.
    const ALLOWED = new Set([
      'lib/maps/places.ts',
      'lib/maps/places.test.ts',
      'lib/maps/reverseGeocode.ts',
      'lib/maps/reverseGeocode.test.ts',
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
