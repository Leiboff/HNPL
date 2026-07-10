import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-text pins — location UX (LocationRow + ChangeLocationSheet) ─
//
// These pins protect the invariants a UI refactor could quietly break:
//   • The old "Use my location" pill / "Near your current location"
//     caption / "Optional — helps show" caption are gone from the
//     explore views.
//   • ExploreView renders <LocationRow> and <ChangeLocationSheet>
//     (both Landing and Results screens share the sheet).
//   • The shared sessionStorage key is namespaced + versioned.
//   • DetailView hydrates from readStoredLocation before falling back
//     to a browser geolocation prompt.
//
// If any of these regresses, the discovery UX drifts back toward the
// old pill / silent-prompt pattern we deliberately removed.

const ROOT  = resolve(process.cwd());
const read  = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SHARED  = read('lib/patient/sharedLocation.ts');
const ROW     = read('app/patient/explore/LocationRow.tsx');
const SHEET   = read('app/patient/explore/ChangeLocationSheet.tsx');
const EXPLORE = read('app/patient/explore/ExploreView.tsx');
const LANDING = read('app/patient/explore/Landing.tsx');
const DETAIL  = read('app/patient/practitioner/[memberId]/DetailView.tsx');

describe('sharedLocation — namespaced + versioned storage key', () => {
  it('storage key is scoped to hnpl + patient + version', () => {
    expect(SHARED).toMatch(/hnpl:patient-location:v1/);
  });
  it('uses sessionStorage (not localStorage) — POPIA-clean, tab-scoped', () => {
    expect(SHARED).toMatch(/window\.sessionStorage\.getItem/);
    expect(SHARED).toMatch(/window\.sessionStorage\.setItem/);
    expect(SHARED).not.toMatch(/window\.localStorage/);
  });
});

describe('LocationRow — the tap target', () => {
  it('exposes the row + value testids', () => {
    expect(ROW).toMatch(/data-testid="location-row"/);
    expect(ROW).toMatch(/data-testid="location-row-value"/);
  });
  it('default value copy is "Choose location" when no label + not loading', () => {
    expect(ROW).toMatch(/'Choose location'/);
  });
});

describe('ChangeLocationSheet — reuses SettingsSheet overlay pattern', () => {
  it('bottom sheet on mobile, centered modal on desktop', () => {
    // items-end for mobile bottom sheet; md:items-center for desktop modal.
    expect(SHEET).toMatch(/items-end md:items-center/);
    expect(SHEET).toMatch(/rounded-t-2xl md:rounded-2xl/);
  });
  it('has role="dialog" and aria-modal', () => {
    expect(SHEET).toMatch(/role="dialog"/);
    expect(SHEET).toMatch(/aria-modal="true"/);
  });
  it('confirm button copy is "Select location" (matches the brief)', () => {
    expect(SHEET).toMatch(/Select location/);
  });
  it('reuses the existing PlacesAutocomplete with locality variant', () => {
    expect(SHEET).toMatch(/from '@\/app\/_components\/PlacesAutocomplete'/);
    expect(SHEET).toMatch(/variant="locality"/);
  });
  it('reverse-geocode uses the existing reverseGeocodeSuburb helper (no second integration path)', () => {
    expect(SHEET).toMatch(/from '@\/lib\/maps\/reverseGeocode'/);
    expect(SHEET).toMatch(/reverseGeocodeSuburb/);
  });
});

describe('ExploreView — renders the row + sheet; old pill/caption REMOVED', () => {
  it('imports LocationRow and ChangeLocationSheet', () => {
    expect(EXPLORE).toMatch(/from '.\/LocationRow'/);
    expect(EXPLORE).toMatch(/from '.\/ChangeLocationSheet'/);
  });
  it('reads + writes shared location', () => {
    expect(EXPLORE).toMatch(/readStoredLocation/);
    expect(EXPLORE).toMatch(/writeStoredLocation/);
  });
  it('does NOT render the old "Use my location" button anymore', () => {
    // The trigger button and its testid are gone. (The docstring
    // that explains what was removed still mentions the phrase — we
    // only pin removal of the actual UI marker, not the historical
    // reference in comments.)
    expect(EXPLORE).not.toMatch(/data-testid="use-my-location"/);
    expect(EXPLORE).not.toMatch(/onUseMyLocation/);
  });
  it('does NOT render the old "Near your current location" caption in the UI', () => {
    // Template-string prefix "`Near ..." is what the old caption
    // used; the label is now the row's value directly, no prefix.
    expect(EXPLORE).not.toMatch(/`Near \$\{/);
  });
});

describe('Landing — the row is placed under the search bar (no pill / suburb fallback)', () => {
  it('has no local "Use my location" button', () => {
    // The testid is gone. The phrase remains in the docstring
    // explaining the removal — we pin the UI marker, not the
    // historical comment.
    expect(LANDING).not.toMatch(/data-testid="use-my-location"/);
    expect(LANDING).not.toMatch(/onUseMyLocation/);
  });
  it('has no local suburb-fallback PlacesAutocomplete (the sheet owns it now)', () => {
    expect(LANDING).not.toMatch(/PlacesAutocomplete/);
  });
  it('has no "Optional — helps show" caption', () => {
    expect(LANDING).not.toMatch(/Optional — helps show/);
  });
  it('accepts a locationRow prop for the orchestrator to inject', () => {
    expect(LANDING).toMatch(/locationRow/);
  });
});

describe('DetailView — hydrates from shared location before prompting', () => {
  it('imports readStoredLocation', () => {
    expect(DETAIL).toMatch(/from '@\/lib\/patient\/sharedLocation'/);
    expect(DETAIL).toMatch(/readStoredLocation/);
  });
  it('skips getCurrentPosition when the hydration already produced a granted state', () => {
    // The effect must gate on requesting → don't re-prompt when
    // hydrated from storage. Look for the guard.
    expect(DETAIL).toMatch(/if \(geo\.kind !== 'requesting'\) return/);
  });
});
