import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { DirectoryRow } from '@/lib/practitioner/grouping';

// ─── Tests — Find a Practitioner UI ────────────────────────────────────
//
// Behavioural tests over <ExploreView/>. The pure grouping/bucketing
// rules are pinned in lib/practitioner/grouping.test.ts; these tests
// prove the COMPONENT wires them up correctly and that the geolocation
// state machine still re-prompts on every mount + on the retry button.
//
// PlacesAutocomplete is mocked — the real one calls Google Places.

vi.mock('@/app/_components/PlacesAutocomplete', () => ({
  default: () => null,
}));

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

// ─── Tests ──────────────────────────────────────────────────────────────

describe('ExploreView — no-location renders every practitioner', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('shows BOTH coord-having and coord-less practitioners when location is denied', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-coord',   first_name: 'Has',  last_name: 'Coords',     practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 'm-nocoord', first_name: 'No',   last_name: 'Coords',     practice_latitude: null,    practice_longitude: null }),
    ];
    render(<ExploreView rows={rows} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    expect(screen.getByText('Has Coords')).toBeTruthy();
    expect(screen.getByText('No Coords')).toBeTruthy();
    expect(screen.queryByText('Other practitioners')).toBeNull();
  });
});

describe('ExploreView — geolocation re-prompts on every mount', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('fires getCurrentPosition on first mount', () => {
    render(<ExploreView rows={[r({ member_id: 'a' })]} />);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('fires AGAIN on remount (revisits get a fresh attempt)', () => {
    const { unmount } = render(<ExploreView rows={[r({ member_id: 'a' })]} />);
    unmount();
    render(<ExploreView rows={[r({ member_id: 'a' })]} />);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it('"Try location" button re-fires getCurrentPosition after denial', () => {
    render(<ExploreView rows={[r({ member_id: 'a' })]} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    const btn = screen.getByTestId('explore-try-location-again');
    act(() => { fireEvent.click(btn); });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2);
  });
});

describe('ExploreView — grouping by HPCSA produces one card with multiple locations', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('two rows with the SAME hpcsa_group_key → ONE card showing both practices', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-a', hpcsa_group_key: 'hash-X', hpcsa_registered: true, first_name: 'Jane', last_name: 'Doe', practice_id: 'pA', practice_name: 'Sandton Rooms',  practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 'm-b', hpcsa_group_key: 'hash-X', hpcsa_registered: true, first_name: 'Jane', last_name: 'Doe', practice_id: 'pB', practice_name: 'Rosebank Rooms', practice_latitude: -26.15, practice_longitude: 28.04 }),
    ];
    render(<ExploreView rows={rows} />);

    // One card.
    expect(screen.getAllByText('Jane Doe')).toHaveLength(1);
    // Both locations listed.
    expect(screen.getByText('Sandton Rooms')).toBeTruthy();
    expect(screen.getByText('Rosebank Rooms')).toBeTruthy();
    // HPCSA badge present.
    expect(screen.getByText(/HPCSA registered/)).toBeTruthy();
  });

  it('row with NULL hpcsa_group_key → standalone card (NOT hidden)', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-solo', hpcsa_group_key: null, hpcsa_registered: false, first_name: 'No', last_name: 'HPCSA' }),
    ];
    render(<ExploreView rows={rows} />);
    expect(screen.getByText('No HPCSA')).toBeTruthy();
    // No badge for a non-registered row.
    expect(screen.queryByText(/HPCSA registered/)).toBeNull();
  });
});

describe('ExploreView — filters work and AND together', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('specialty chip narrows the visible cards', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-dent',  hpcsa_group_key: 'd', specialty: 'Dentistry',     first_name: 'D',  last_name: 'Dent' }),
      r({ member_id: 'm-physio',hpcsa_group_key: 'p', specialty: 'Physiotherapy', first_name: 'P',  last_name: 'Physio' }),
    ];
    render(<ExploreView rows={rows} />);
    // Before filter: both visible.
    expect(screen.getByText('D Dent')).toBeTruthy();
    expect(screen.getByText('P Physio')).toBeTruthy();

    // Click "Physiotherapy" specialty chip.
    act(() => { fireEvent.click(screen.getByTestId('filter-specialty-Physiotherapy')); });
    expect(screen.queryByText('D Dent')).toBeNull();
    expect(screen.getByText('P Physio')).toBeTruthy();
  });
});

describe('ExploreView — distance: appears if ANY location within radius (multi-practice practitioner)', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('a 2-location practitioner with one within 25km + one beyond → card appears, locations listed nearest-first', () => {
    const rows: DirectoryRow[] = [
      // ~0 km from (-26.10, 28.05)
      r({ member_id: 'm-near', hpcsa_group_key: 'h', first_name: 'Two', last_name: 'Sites', practice_id: 'p-near', practice_name: 'Near Site', practice_latitude: -26.10, practice_longitude: 28.05 }),
      // ~120+ km from (-26.10, 28.05)
      r({ member_id: 'm-far',  hpcsa_group_key: 'h', first_name: 'Two', last_name: 'Sites', practice_id: 'p-far',  practice_name: 'Far Site',  practice_latitude: -25.00, practice_longitude: 28.05 }),
    ];
    render(<ExploreView rows={rows} />);
    // Grant location → triggers granted state with radius=25 by default.
    act(() => {
      const [ok] = geo.getCurrentPosition.mock.calls[0]!;
      ok?.({ coords: { latitude: -26.10, longitude: 28.05 } } as GeolocationPosition);
    });

    // Card visible (because at least one location is within 25 km).
    expect(screen.getByText('Two Sites')).toBeTruthy();
    // BOTH locations are present on the card.
    expect(screen.getByText('Near Site')).toBeTruthy();
    expect(screen.getByText('Far Site')).toBeTruthy();

    // Near Site appears in DOM BEFORE Far Site (nearest-first sort).
    const nearEl = screen.getByText('Near Site');
    const farEl  = screen.getByText('Far Site');
    const order  = nearEl.compareDocumentPosition(farEl);
    // Node.DOCUMENT_POSITION_FOLLOWING = 4 → farEl comes after nearEl
    expect(order & 4).toBe(4);
  });
});
