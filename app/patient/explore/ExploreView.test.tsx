import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { DirectoryRow } from '@/lib/practitioner/grouping';

// ─── Tests — Find a Practitioner UI (landing + results) ────────────────
//
// Two views under /patient/explore, controlled by URL params:
//   • No params → Landing (data-driven categories + search + "See all").
//   • ?view=results OR ?specialty=X OR ?q=X → Results list.
//
// We drive the URL params via a mockable useSearchParams stub.
//
// PlacesAutocomplete is mocked in two ways depending on the test:
//   • The default mock is a passive no-op (renders null).
//   • The sheet interaction tests override it with a mock exposing a
//     testable "pick" button that fires onSelect with a canned
//     PlaceDetails payload.

const placesOnSelectRef: { current: ((p: {
  latitude: number; longitude: number; formattedAddress: string;
  addressComponents: Array<{ longText: string; shortText: string; types: string[] }>;
}) => void) | null } = { current: null };

vi.mock('@/app/_components/PlacesAutocomplete', () => ({
  default: (props: {
    onSelect: (p: {
      latitude: number; longitude: number; formattedAddress: string;
      addressComponents: Array<{ longText: string; shortText: string; types: string[] }>;
    }) => void;
    inputId?: string;
    placeholder?: string;
  }) => {
    placesOnSelectRef.current = props.onSelect;
    return null;
  },
}));

// Reverse-geocode is best-effort — tests inject the return value so we
// can prove both the success path (suburb label appears) AND the
// fallback path (null → generic "Locating…" fallback).
const reverseGeocodeMock = vi.fn<(latitude: number, longitude: number) => Promise<string | null>>();
vi.mock('@/lib/maps/reverseGeocode', async () => {
  const actual = await vi.importActual<typeof import('@/lib/maps/reverseGeocode')>('@/lib/maps/reverseGeocode');
  return {
    ...actual,
    reverseGeocodeSuburb: (latitude: number, longitude: number) => reverseGeocodeMock(latitude, longitude),
  };
});

// Mockable useSearchParams — each test sets the params it needs.
const currentParams = new URLSearchParams();
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return {
    ...actual,
    useSearchParams: () => currentParams,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  };
});

function setParams(params: Record<string, string>) {
  Array.from(currentParams.keys()).forEach((k) => currentParams.delete(k));
  for (const [k, v] of Object.entries(params)) currentParams.set(k, v);
}

// Default the reverse-geocode mock to a resolved null. Individual
// tests override it via reverseGeocodeMock.mockResolvedValueOnce(...).
beforeEach(() => {
  reverseGeocodeMock.mockReset();
  reverseGeocodeMock.mockResolvedValue(null);
  placesOnSelectRef.current = null;
  // Location persists via sessionStorage across the SPA — tests must
  // start from a clean slate to avoid cross-test leakage.
  window.sessionStorage.clear();
});

import ExploreView from './ExploreView';

// ─── Geolocation harness ────────────────────────────────────────────────

type GeoCb = (pos: GeolocationPosition) => void;
type ErrCb = (err: GeolocationPositionError) => void;

function buildGeolocationStub() {
  const getCurrentPosition = vi.fn<
    (success: GeoCb, error?: ErrCb, _opts?: PositionOptions) => void
  >();
  return { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() };
}

function installGeolocation(stub: ReturnType<typeof buildGeolocationStub>) {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value:        stub,
    configurable: true,
  });
}

function removeGeolocation() {
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value:        undefined,
    configurable: true,
  });
}

function r(over: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    member_id:          'm-1',
    hpcsa_group_key:    null,
    hpcsa_registered:   false,
    first_name:         'Jane',
    last_name:          'Doe',
    specialty:          'Dentistry',
    practice_id:        'p-1',
    practice_name:      'Sandton Rooms',
    practice_suburb:    'Sandton',
    practice_city:      'Johannesburg',
    practice_latitude:  -26.10,
    practice_longitude:  28.05,
    practice_phone:     '+27 11 555 0001',
    ...over,
  };
}

// ─── Landing view (default, no URL params) ─────────────────────────────

describe('ExploreView — landing is the default view', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    setParams({});
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('renders the Landing screen (category picker + See all) when no query params are present', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-dent',    hpcsa_group_key: 'd',  specialty: 'Dentistry',     first_name: 'D' }),
      r({ member_id: 'm-physio',  hpcsa_group_key: 'p',  specialty: 'Physiotherapy', first_name: 'P' }),
    ];
    render(<ExploreView rows={rows} />);
    expect(screen.getByTestId('landing-categories')).toBeTruthy();
    expect(screen.getByTestId('landing-see-all')).toBeTruthy();
    // Neither the results-list "Filters" toggle nor a card header
    // should appear on landing.
    expect(screen.queryByTestId('filters-toggle')).toBeNull();
  });

  it('categories are data-driven — only specialties with ≥1 live practitioner appear', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'a', hpcsa_group_key: 'ha', specialty: 'Dentistry',     first_name: 'A' }),
      r({ member_id: 'b', hpcsa_group_key: 'hb', specialty: 'Physiotherapy', first_name: 'B' }),
    ];
    render(<ExploreView rows={rows} />);
    expect(screen.getByTestId('landing-category-Dentistry')).toBeTruthy();
    expect(screen.getByTestId('landing-category-Physiotherapy')).toBeTruthy();
    // Pharmacy / Hospital / Vet are not hard-coded; they never appear
    // just because a designer might have listed them.
    expect(screen.queryByText(/Pharmacy/)).toBeNull();
    expect(screen.queryByText(/Hospital/)).toBeNull();
    expect(screen.queryByText(/Vet(erinary)?/i)).toBeNull();
  });

  it('category tiles show the correct count (distinct practitioners per specialty)', () => {
    const rows: DirectoryRow[] = [
      // 2 dentists (2 groups)
      r({ member_id: 'a', hpcsa_group_key: 'ha', specialty: 'Dentistry', first_name: 'A' }),
      r({ member_id: 'b', hpcsa_group_key: 'hb', specialty: 'Dentistry', first_name: 'B' }),
      // 1 physio
      r({ member_id: 'c', hpcsa_group_key: 'hc', specialty: 'Physiotherapy', first_name: 'C' }),
    ];
    render(<ExploreView rows={rows} />);
    const dent   = screen.getByTestId('landing-category-Dentistry');
    const physio = screen.getByTestId('landing-category-Physiotherapy');
    expect(dent.textContent).toMatch(/2 practitioners/);
    expect(physio.textContent).toMatch(/1 practitioner\b/);
  });

  it('the See-all tile links to ?view=results (no specialty filter)', () => {
    render(<ExploreView rows={[r()]} />);
    const seeAll = screen.getByTestId('landing-see-all') as HTMLAnchorElement;
    expect(seeAll.getAttribute('href')).toBe('/patient/explore?view=results');
  });

  it('a category tile links to ?view=results&specialty=<name>', () => {
    render(<ExploreView rows={[r({ specialty: 'Dentistry' })]} />);
    const tile = screen.getByTestId('landing-category-Dentistry') as HTMLAnchorElement;
    expect(tile.getAttribute('href')).toBe('/patient/explore?view=results&specialty=Dentistry');
  });
});

// ─── Location row (Discovery-Health-style) — replaces "Use my location" pill ─

describe('ExploreView — Location row (replaces the pill / caption)', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    setParams({});
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('renders LocationRow with "Choose location" when no location is set', () => {
    render(<ExploreView rows={[r()]} />);
    // Simulate the browser denying the auto-prompt so the row
    // settles into its "nothing chosen" state.
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    const row = screen.getByTestId('location-row');
    expect(row).toBeTruthy();
    expect(screen.getByTestId('location-row-value').textContent).toMatch(/Choose location/);
  });

  it('renders LocationRow with "Suburb, City" once a location is resolved via reverse-geocode', async () => {
    reverseGeocodeMock.mockResolvedValueOnce('Glenhazel, Johannesburg');
    render(<ExploreView rows={[r()]} />);
    await act(async () => {
      const [ok] = geo.getCurrentPosition.mock.calls[0]!;
      ok?.({ coords: { latitude: -26.10, longitude: 28.05 } } as GeolocationPosition);
      // Flush reverse-geocode microtask
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('location-row-value').textContent).toMatch(/Glenhazel, Johannesburg/);
  });

  it('the OLD "Use my location" pill and "Near your current location" caption are removed', () => {
    render(<ExploreView rows={[r()]} />);
    expect(screen.queryByTestId('use-my-location')).toBeNull();
    expect(screen.queryByText(/Near your current location/i)).toBeNull();
    // "Optional — helps show nearest first." caption is gone.
    expect(screen.queryByText(/Optional — helps show/i)).toBeNull();
  });

  it('tapping the LocationRow opens the ChangeLocationSheet', () => {
    render(<ExploreView rows={[r()]} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    // Sheet is closed to start with.
    expect(screen.queryByTestId('change-location-sheet')).toBeNull();
    act(() => { fireEvent.click(screen.getByTestId('location-row')); });
    expect(screen.getByTestId('change-location-sheet')).toBeTruthy();
    // Close button dismisses.
    act(() => { fireEvent.click(screen.getByTestId('change-location-close')); });
    expect(screen.queryByTestId('change-location-sheet')).toBeNull();
  });

  it('picking a suburb via autocomplete updates the LocationRow and persists to sessionStorage', () => {
    render(<ExploreView rows={[r()]} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    // Open sheet
    act(() => { fireEvent.click(screen.getByTestId('location-row')); });
    // The autocomplete's onSelect is captured on mount via the module mock.
    expect(placesOnSelectRef.current).not.toBeNull();
    // Simulate picking a place.
    act(() => {
      placesOnSelectRef.current!({
        latitude:         -26.14,
        longitude:         28.04,
        formattedAddress: 'Rosebank, Johannesburg, South Africa',
        addressComponents: [
          { longText: 'Rosebank',      shortText: 'Rosebank', types: ['sublocality', 'sublocality_level_1'] },
          { longText: 'Johannesburg',  shortText: 'JHB',      types: ['locality'] },
        ],
      });
    });
    // Draft summary is visible with the resolved label.
    expect(screen.getByTestId('change-location-draft-suburb').textContent).toMatch(/Rosebank, Johannesburg/);
    // Confirm.
    act(() => { fireEvent.click(screen.getByTestId('change-location-confirm')); });
    // Sheet closes.
    expect(screen.queryByTestId('change-location-sheet')).toBeNull();
    // Row shows the new label.
    expect(screen.getByTestId('location-row-value').textContent).toMatch(/Rosebank, Johannesburg/);
    // sessionStorage now has the entry.
    const stored = JSON.parse(window.sessionStorage.getItem('hnpl:patient-location:v1') ?? 'null');
    expect(stored).toMatchObject({
      latitude:  -26.14,
      longitude:  28.04,
      label:     'Rosebank, Johannesburg',
      source:    'suburb',
    });
  });

  it('"Use current location" inside the sheet: geolocation grant → reverse-geocode → row updates', async () => {
    reverseGeocodeMock.mockResolvedValueOnce('Melville, Johannesburg');
    render(<ExploreView rows={[r()]} />);
    // Deny the initial auto-prompt so the sheet path is clean.
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    // Open sheet
    act(() => { fireEvent.click(screen.getByTestId('location-row')); });
    // Sheet-level Use-current-location tap → fires geolocation again.
    act(() => { fireEvent.click(screen.getByTestId('change-location-use-current')); });
    // The sheet made a fresh call to getCurrentPosition (call 2).
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2);
    await act(async () => {
      const [ok] = geo.getCurrentPosition.mock.calls[1]!;
      ok?.({ coords: { latitude: -26.18, longitude: 28.02 } } as GeolocationPosition);
      // Flush reverse-geocode
      await Promise.resolve();
      await Promise.resolve();
    });
    // Confirm.
    act(() => { fireEvent.click(screen.getByTestId('change-location-confirm')); });
    // Row shows the resolved suburb label.
    expect(screen.getByTestId('location-row-value').textContent).toMatch(/Melville, Johannesburg/);
  });

  it('"Use current location" DENIED inside the sheet: sheet stays usable, autocomplete still works', () => {
    render(<ExploreView rows={[r()]} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    // Open sheet.
    act(() => { fireEvent.click(screen.getByTestId('location-row')); });
    // Tap use-current → geolocation error callback fires immediately.
    act(() => { fireEvent.click(screen.getByTestId('change-location-use-current')); });
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[1]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    // Sheet is still open, no crash, sensible message.
    expect(screen.getByTestId('change-location-sheet')).toBeTruthy();
    expect(screen.getByTestId('change-location-use-current-detail').textContent).toMatch(/blocked|denied|Location blocked/i);
    // Autocomplete still works — the shared onSelect ref is still bound.
    expect(placesOnSelectRef.current).not.toBeNull();
    // Confirm is disabled (no draft committed).
    const confirm = screen.getByTestId('change-location-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('persistence: stored location hydrates on mount — no re-prompt', () => {
    // Pre-populate storage BEFORE mount.
    window.sessionStorage.setItem('hnpl:patient-location:v1', JSON.stringify({
      latitude: -26.20, longitude: 28.10, label: 'Sandhurst, Johannesburg', source: 'suburb',
    }));
    render(<ExploreView rows={[r()]} />);
    // Since a stored location was found, we do NOT auto-prompt.
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    // Row shows the hydrated label.
    expect(screen.getByTestId('location-row-value').textContent).toMatch(/Sandhurst, Johannesburg/);
  });

  it('ordering re-sorts when a new location is picked (nearest-first from the new coords)', () => {
    setParams({ view: 'results' });
    // Two practitioners ~11 km apart, coords chosen so BOTH stay
    // within the default 25 km radius from either pick location.
    const rows: DirectoryRow[] = [
      r({ member_id: 'n', hpcsa_group_key: 'hn', first_name: 'N', last_name: 'North', practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 's', hpcsa_group_key: 'hs', first_name: 'S', last_name: 'South', practice_latitude: -26.20, practice_longitude: 28.05 }),
    ];
    window.sessionStorage.setItem('hnpl:patient-location:v1', JSON.stringify({
      latitude: -26.19, longitude: 28.05, label: 'Southern, JHB', source: 'suburb',
    }));
    const { rerender } = render(<ExploreView rows={rows} />);
    // South is nearest to (-26.19, 28.05) → South card is rendered first.
    let text = document.body.textContent ?? '';
    let sIdx = text.indexOf('S South');
    let nIdx = text.indexOf('N North');
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(nIdx).toBeGreaterThanOrEqual(0);
    expect(sIdx).toBeLessThan(nIdx);

    // Now pick a north-biased location via the sheet.
    act(() => { fireEvent.click(screen.getByTestId('location-row')); });
    act(() => {
      placesOnSelectRef.current!({
        latitude:  -26.09, longitude: 28.05,
        formattedAddress: 'Northern, JHB',
        addressComponents: [{ longText: 'Northern', shortText: 'N', types: ['sublocality'] }, { longText: 'Johannesburg', shortText: 'JHB', types: ['locality'] }],
      });
    });
    act(() => { fireEvent.click(screen.getByTestId('change-location-confirm')); });
    rerender(<ExploreView rows={rows} />);
    // North is now nearest → North card is rendered first.
    text = document.body.textContent ?? '';
    sIdx = text.indexOf('S South');
    nIdx = text.indexOf('N North');
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(nIdx).toBeGreaterThanOrEqual(0);
    expect(nIdx).toBeLessThan(sIdx);
  });
});

// ─── Results view (any URL param present) ──────────────────────────────

describe('ExploreView — results view when URL params are present', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    setParams({ view: 'results' });
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('renders the results list with the Filters toggle and back-to-landing link', () => {
    render(<ExploreView rows={[r()]} />);
    expect(screen.getByTestId('filters-toggle')).toBeTruthy();
    expect(screen.getByTestId('results-back-to-landing')).toBeTruthy();
    // Landing surfaces are NOT rendered in results mode.
    expect(screen.queryByTestId('landing-categories')).toBeNull();
  });

  it('an initial ?specialty=X pre-filters the list', () => {
    setParams({ view: 'results', specialty: 'Physiotherapy' });
    const rows: DirectoryRow[] = [
      r({ member_id: 'd', hpcsa_group_key: 'hd', specialty: 'Dentistry',     first_name: 'D', last_name: 'Dent' }),
      r({ member_id: 'p', hpcsa_group_key: 'hp', specialty: 'Physiotherapy', first_name: 'P', last_name: 'Physio' }),
    ];
    render(<ExploreView rows={rows} />);
    expect(screen.getByText('P Physio')).toBeTruthy();
    expect(screen.queryByText('D Dent')).toBeNull();
  });

  it('no-location still shows every practitioner (the no-location contract)', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'co', hpcsa_group_key: 'hco', first_name: 'Has',  last_name: 'Coords',  practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 'nc', hpcsa_group_key: 'hnc', first_name: 'No',   last_name: 'Coords',  practice_latitude: null,    practice_longitude: null }),
    ];
    render(<ExploreView rows={rows} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    expect(screen.getByText('Has Coords')).toBeTruthy();
    expect(screen.getByText('No Coords')).toBeTruthy();
  });

  it('LocationRow lives under the search bar on the results view too', () => {
    render(<ExploreView rows={[r()]} />);
    // The row must render in results mode.
    expect(screen.getByTestId('location-row')).toBeTruthy();
    // Old pill / caption remain removed.
    expect(screen.queryByTestId('use-my-location')).toBeNull();
    expect(screen.queryByText(/Near your current location/i)).toBeNull();
  });
});

// ─── Card layout (results view rendering) ──────────────────────────────

describe('ExploreView — simplified list card', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    setParams({ view: 'results' });
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('card shows name + specialty; the HPCSA badge is FINAL — no longer rendered', () => {
    render(<ExploreView rows={[r({
      member_id: 'm1', hpcsa_group_key: 'hh', hpcsa_registered: true,
      first_name: 'Alice', last_name: 'Smith', specialty: 'Dentistry',
    })]} />);
    expect(screen.getByText('Alice Smith')).toBeTruthy();
    expect(screen.getByText('Dentistry')).toBeTruthy();
    // The HPCSA badge has been removed from discovery entirely.
    expect(screen.queryByTestId('practitioner-card-hh-hpcsa')).toBeNull();
    expect(screen.queryByText(/HPCSA registered/i)).toBeNull();
  });

  it('card location line is STACKED — suburb on one row, "N km away" beneath (Fix 3)', () => {
    render(<ExploreView rows={[r({
      member_id: 'm1', hpcsa_group_key: 'hh',
      practice_name: 'Sandton Rooms',
      practice_suburb: 'Glenhazel', practice_city: 'Johannesburg',
      practice_latitude: -26.10, practice_longitude: 28.05,
    })]} />);
    act(() => {
      const [ok] = geo.getCurrentPosition.mock.calls[0]!;
      ok?.({ coords: { latitude: -26.10, longitude: 28.05 } } as GeolocationPosition);
    });

    // Suburb-only line contains the suburb but NOT the "km" fragment.
    const area = screen.getByTestId('practitioner-card-hh-area');
    const suburbLine = area.querySelector('p')!;
    expect(suburbLine.textContent).toMatch(/Glenhazel, Johannesburg/);
    expect(suburbLine.textContent).not.toMatch(/km/);

    // A SEPARATE distance line lives beneath it.
    const distanceLine = screen.getByTestId('practitioner-card-hh-distance');
    expect(distanceLine.textContent).toMatch(/km/);
    expect(distanceLine.textContent).toMatch(/away/);

    // The distance element comes AFTER the suburb element in the DOM.
    const order = suburbLine.compareDocumentPosition(distanceLine);
    expect(order & 4).toBe(4);   // DOCUMENT_POSITION_FOLLOWING
  });

  it('card location shows ONLY the suburb line (no empty "km away") when there is no user location', () => {
    render(<ExploreView rows={[r({
      member_id: 'm1', hpcsa_group_key: 'hh',
      practice_name: 'Sandton Rooms',
      practice_suburb: 'Glenhazel', practice_city: 'Johannesburg',
    })]} />);
    // Deny geo → no distance → distance line should NOT render.
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    expect(screen.getByTestId('practitioner-card-hh-area').textContent).toMatch(/Glenhazel, Johannesburg/);
    expect(screen.queryByTestId('practitioner-card-hh-distance')).toBeNull();
  });

  it('card shows the AREA (suburb, city) of the closest location, NOT the practice name', () => {
    render(<ExploreView rows={[r({
      member_id: 'm1', hpcsa_group_key: 'hh',
      practice_name: 'Sandton Rooms',
      practice_suburb: 'Glenhazel', practice_city: 'Johannesburg',
    })]} />);
    const area = screen.getByTestId('practitioner-card-hh-area');
    expect(area.textContent).toMatch(/Glenhazel, Johannesburg/);
    expect(area.textContent).not.toMatch(/Sandton Rooms/);
    expect(screen.queryByText('Sandton Rooms')).toBeNull();
  });

  it('a multi-location practitioner shows ONLY the closest location on the card (all locations live on the detail screen)', () => {
    render(<ExploreView rows={[
      r({ member_id: 'a', hpcsa_group_key: 'hh', practice_id: 'pA', practice_name: 'A', practice_suburb: 'Sandton',  practice_city: 'JHB', practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 'b', hpcsa_group_key: 'hh', practice_id: 'pB', practice_name: 'B', practice_suburb: 'Rosebank', practice_city: 'JHB', practice_latitude: -26.15, practice_longitude: 28.04 }),
    ]} />);
    // No "Show all N locations" expander — the closest location is
    // the only one on the card; the detail screen has the rest.
    expect(screen.queryByText(/Show all/)).toBeNull();
    // A subtle "also practises at 1 other location" hint is fine —
    // the card just doesn't nest a full location list.
    expect(screen.getByText(/other location/i)).toBeTruthy();
  });

  it('Call to book (tel:) and Get directions (maps) live at the BOTTOM of the card', () => {
    render(<ExploreView rows={[r({
      member_id: 'm1', hpcsa_group_key: 'hh', practice_id: 'pA',
      practice_phone: '+27 11 555 0001',
      practice_latitude: -26.10, practice_longitude: 28.05,
    })]} />);
    const call = screen.getByTestId('practitioner-card-hh-call') as HTMLAnchorElement;
    const dir  = screen.getByTestId('practitioner-card-hh-directions') as HTMLAnchorElement;
    expect(call.href).toBe('tel:+27 11 555 0001');
    expect(dir.href).toContain('google.com/maps');
    expect(call.textContent).toMatch(/Call to book/);
    expect(dir.textContent).toMatch(/Get directions/);
  });

  it('"View" link on the card goes to /patient/practitioner/<member_id>', () => {
    const rows: DirectoryRow[] = [r({ member_id: 'm-target', hpcsa_group_key: 'hh', first_name: 'Target', last_name: 'Person' })];
    render(<ExploreView rows={rows} />);
    const view = screen.getByTestId('practitioner-card-hh-view') as HTMLAnchorElement;
    expect(view.getAttribute('href')).toBe('/patient/practitioner/m-target');
  });
});

// ─── Discovery-borrow guardrails ───────────────────────────────────────

describe('ExploreView — BetterNow tone: no medical-aid-network language, no Vet/A-Z', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    setParams({});
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('landing has NO Cover / In Network / Premier Plus / medical aid / medical scheme language', () => {
    const { container } = render(<ExploreView rows={[r()]} />);
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('cover');
    expect(text).not.toContain('in network');
    expect(text).not.toContain('full network');
    expect(text).not.toContain('premier plus');
    expect(text).not.toContain('nominate as primary');
    expect(text).not.toContain('medical aid');
    expect(text).not.toContain('medical scheme');
  });

  it('landing has no hard-coded Doctor / Dentist / Pharmacy / Hospital / Vet category grid', () => {
    // Categories are DATA-DRIVEN. When there are zero practitioners
    // at all, no categories show up — proving no hard-coded list.
    render(<ExploreView rows={[]} />);
    expect(screen.queryByTestId('landing-category-Doctor')).toBeNull();
    expect(screen.queryByTestId('landing-category-Dentist')).toBeNull();
    expect(screen.queryByTestId('landing-category-Pharmacy')).toBeNull();
    expect(screen.queryByTestId('landing-category-Hospital')).toBeNull();
    expect(screen.queryByTestId('landing-category-Vet')).toBeNull();
    expect(screen.queryByTestId('landing-category-Veterinary')).toBeNull();
  });

  it('landing has no A-Z alphabetical specialty list (no A B C … Z scaffolding)', () => {
    // We assert against the presence of a scaffolded A-Z index in
    // the DOM. Categories that HAPPEN to be alphabetical don't count
    // — the test looks for the A-Z-index header pattern.
    render(<ExploreView rows={[r({ specialty: 'Dentistry' })]} />);
    expect(screen.queryByText(/^A\s*[·|]\s*B\s*[·|]/)).toBeNull();
    expect(screen.queryByText(/Alphabetical/i)).toBeNull();
    expect(screen.queryByText(/Browse\s+A[-–]Z/i)).toBeNull();
  });
});

// ─── Fix 4 — no "Other practitioners" subheading ───────────────────────

describe('ExploreView — Fix 4: one continuous results list', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    setParams({ view: 'results' });
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('does NOT render the "Other practitioners" subheading, even when there are coord-less cards', () => {
    // Grant location so the bucketing splits into near vs other:
    // "near" = has coords + within radius; "other" = coord-less.
    const rows: DirectoryRow[] = [
      r({ member_id: 'has', hpcsa_group_key: 'h1', first_name: 'Coord',   last_name: 'Has', practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 'no',  hpcsa_group_key: 'h2', first_name: 'Coord',   last_name: 'No',  practice_latitude: null,    practice_longitude: null }),
    ];
    render(<ExploreView rows={rows} />);
    act(() => {
      const [ok] = geo.getCurrentPosition.mock.calls[0]!;
      ok?.({ coords: { latitude: -26.10, longitude: 28.05 } } as GeolocationPosition);
    });

    // Both cards render.
    expect(screen.getByText('Coord Has')).toBeTruthy();
    expect(screen.getByText('Coord No')).toBeTruthy();
    // The subheading is gone.
    expect(screen.queryByText(/Other practitioners/i)).toBeNull();
  });

  it('no-location state still shows every practitioner (unchanged contract) and NO subheading', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'a', hpcsa_group_key: 'ha', first_name: 'A', last_name: 'A' }),
      r({ member_id: 'b', hpcsa_group_key: 'hb', first_name: 'B', last_name: 'B' }),
    ];
    render(<ExploreView rows={rows} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    expect(screen.getByText('A A')).toBeTruthy();
    expect(screen.getByText('B B')).toBeTruthy();
    expect(screen.queryByText(/Other practitioners/i)).toBeNull();
  });
});
