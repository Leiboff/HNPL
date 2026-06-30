import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type { DirectoryRow } from '@/lib/practitioner/grouping';

// ─── Tests — Find a Practitioner UI (post-redesign) ────────────────────
//
// Behavioural tests over <ExploreView/>. The pure grouping/bucketing
// rules are pinned in lib/practitioner/grouping.test.ts; these tests
// prove the COMPONENT wires them up correctly, the geo state machine
// re-prompts on every mount + on the retry button, and the new
// list-card UX (single-location inline + multi-location expander +
// Call to book + Directions) renders + behaves correctly.
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

describe('ExploreView — grouping by HPCSA: ONE card per practitioner', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('two rows with the SAME hpcsa_group_key → ONE card (nearest location inline; rest behind expander)', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-a', hpcsa_group_key: 'hash-X', hpcsa_registered: true, first_name: 'Jane', last_name: 'Doe', practice_id: 'pA', practice_name: 'Sandton Rooms',  practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 'm-b', hpcsa_group_key: 'hash-X', hpcsa_registered: true, first_name: 'Jane', last_name: 'Doe', practice_id: 'pB', practice_name: 'Rosebank Rooms', practice_latitude: -26.15, practice_longitude: 28.04 }),
    ];
    render(<ExploreView rows={rows} />);

    // One name appears once.
    expect(screen.getAllByText('Jane Doe')).toHaveLength(1);

    // The nearest location renders inline; the OTHER is behind a
    // "Show all 2 locations" expander (this is the redesign).
    expect(screen.queryByText('Rosebank Rooms')).toBeNull();

    // The expander reveals the second location.
    const expand = screen.getByText(/Show all 2 locations/);
    act(() => { fireEvent.click(expand); });
    expect(screen.getByText('Rosebank Rooms')).toBeTruthy();
  });

  it('row with NULL hpcsa_group_key → standalone card (NOT hidden)', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-solo', hpcsa_group_key: null, hpcsa_registered: false, first_name: 'No', last_name: 'HPCSA' }),
    ];
    render(<ExploreView rows={rows} />);
    expect(screen.getByText('No HPCSA')).toBeTruthy();
  });
});

describe('ExploreView — list card UX: Call to book + Directions + tap-to-detail', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('Call to book is a tel: link to the practice phone', () => {
    render(<ExploreView rows={[r({ member_id: 'm1', practice_id: 'p1', practice_phone: '+27 11 555 0001' })]} />);
    // tel: anchor exists for this practice.
    const tel = document.querySelector('a[href="tel:+27 11 555 0001"]') as HTMLAnchorElement | null;
    expect(tel).not.toBeNull();
    expect(tel!.textContent).toMatch(/Call to book/);
  });

  it('Directions is a maps link to the practice coords when available', () => {
    render(<ExploreView rows={[r({ member_id: 'm1', practice_id: 'p1', practice_latitude: -26.10, practice_longitude: 28.05 })]} />);
    const maps = Array.from(document.querySelectorAll('a[target="_blank"]'))
      .find((a) => (a as HTMLAnchorElement).href.includes('maps.google.com')
                || (a as HTMLAnchorElement).href.includes('google.com/maps')) as HTMLAnchorElement | undefined;
    expect(maps).toBeDefined();
    expect(maps!.href).toContain('-26.1,28.05');
    expect(maps!.textContent).toMatch(/Directions/);
  });

  it('"View profile" links to /patient/practitioner/<member_id>', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-target', hpcsa_group_key: 'hash', first_name: 'Target', last_name: 'Person' }),
    ];
    render(<ExploreView rows={rows} />);
    const card = screen.getByTestId('practitioner-card-hash');
    const view = within(card).getByText(/View profile/);
    expect(view.getAttribute('href')).toBe('/patient/practitioner/m-target');
  });
});

describe('ExploreView — header polish: collapsible filters drawer', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('Filters drawer is collapsed by default; opens on toggle; specialty narrows results', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-dent',   hpcsa_group_key: 'd', specialty: 'Dentistry',     first_name: 'D',  last_name: 'Dent' }),
      r({ member_id: 'm-physio', hpcsa_group_key: 'p', specialty: 'Physiotherapy', first_name: 'P',  last_name: 'Physio' }),
    ];
    render(<ExploreView rows={rows} />);

    // Both visible initially.
    expect(screen.getByText('D Dent')).toBeTruthy();
    expect(screen.getByText('P Physio')).toBeTruthy();

    // Filters closed by default — the chips don't exist in the DOM.
    expect(screen.queryByTestId('filter-specialty-Physiotherapy')).toBeNull();

    // Open the drawer.
    act(() => { fireEvent.click(screen.getByTestId('filters-toggle')); });
    act(() => { fireEvent.click(screen.getByTestId('filter-specialty-Physiotherapy')); });

    expect(screen.queryByText('D Dent')).toBeNull();
    expect(screen.getByText('P Physio')).toBeTruthy();
  });
});

describe('ExploreView — Discovery-borrow guardrails (BetterNow tone)', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('NO medical-aid-network language anywhere (Cover / In Network / Premier Plus / primary GP)', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm1', first_name: 'A', last_name: 'B' }),
    ];
    const { container } = render(<ExploreView rows={rows} />);
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('cover');
    expect(text).not.toContain('in network');
    expect(text).not.toContain('full network');
    expect(text).not.toContain('partial network');
    expect(text).not.toContain('premier plus');
    expect(text).not.toContain('nominate as primary');
    expect(text).not.toContain('medical aid');
    expect(text).not.toContain('medical scheme');
  });

  it('NO HPCSA badge — registration is assumed, not displayed', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm1', hpcsa_registered: true,  first_name: 'A', last_name: 'B' }),
      r({ member_id: 'm2', hpcsa_registered: false, first_name: 'C', last_name: 'D' }),
    ];
    render(<ExploreView rows={rows} />);
    expect(screen.queryByText(/HPCSA registered/)).toBeNull();
    expect(screen.queryByText(/HPCSA/)).toBeNull();
  });
});
