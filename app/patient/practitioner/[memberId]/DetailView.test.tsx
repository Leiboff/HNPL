import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DirectoryRow } from '@/lib/practitioner/grouping';

// ─── Tests — practitioner detail screen ────────────────────────────────
//
// Behavioural tests over <DetailView/>. Same group / haversine
// helpers as the explore list. The DetailView fetches NOTHING — it
// receives the (1 or more) rows the server pre-fetched. Its job is
// to render the practitioner's full Locations section with Call to
// book + Directions, plus a sticky bottom action bar for the
// nearest location.
//
// Same Discovery-borrow guardrails as the list: NO medical-aid-
// network language, NO HPCSA badge. Pinned by tests below.

import DetailView from './DetailView';

// ─── Geolocation harness ───────────────────────────────────────────────

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
    hpcsa_group_key:    'hash-X',
    hpcsa_registered:   true,
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

describe('DetailView — hero + locations list', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('renders the practitioner name, specialty, and ALL their locations', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-a', practice_id: 'pA', practice_name: 'Sandton Rooms',  practice_latitude: -26.10, practice_longitude: 28.05 }),
      r({ member_id: 'm-b', practice_id: 'pB', practice_name: 'Rosebank Rooms', practice_latitude: -26.15, practice_longitude: 28.04 }),
    ];
    render(<DetailView rows={rows} />);

    // The hero shows the practitioner.
    expect(screen.getByRole('heading', { name: 'Jane Doe' })).toBeTruthy();
    expect(screen.getByText('Dentistry')).toBeTruthy();

    // BOTH locations rendered as rows (no expander on the detail
    // view — this IS the detail view). One of them — the nearest —
    // also appears in the sticky bottom bar, so we query inside the
    // location row by testid for unambiguous matching.
    expect(screen.getByTestId('detail-location-pA')).toBeTruthy();
    expect(screen.getByTestId('detail-location-pB')).toBeTruthy();

    // Locations count is shown.
    expect(screen.getByText(/Locations \(2\)/)).toBeTruthy();
  });

  it('Call to book + Directions appear per location', () => {
    const rows: DirectoryRow[] = [r({ practice_id: 'pA', practice_name: 'Sandton Rooms', practice_phone: '+27 11 111 1111' })];
    render(<DetailView rows={rows} />);
    expect(screen.getByTestId('detail-location-call-pA')).toBeTruthy();
    expect(screen.getByTestId('detail-location-directions-pA')).toBeTruthy();
  });

  it('Call to book is a tel: link; Directions is a Google Maps URL', () => {
    const rows: DirectoryRow[] = [r({
      practice_id: 'pA',
      practice_phone: '+27 11 555 0001',
      practice_latitude: -26.10,
      practice_longitude: 28.05,
    })];
    render(<DetailView rows={rows} />);
    const call = screen.getByTestId('detail-location-call-pA') as HTMLAnchorElement;
    const dir  = screen.getByTestId('detail-location-directions-pA') as HTMLAnchorElement;
    expect(call.href).toBe('tel:+27 11 555 0001');
    expect(dir.href).toContain('google.com/maps');
    expect(dir.href).toContain('-26.1,28.05');
  });

  it('sticky bottom bar exposes Call to book + Directions for the nearest location', () => {
    // A location was already set on /patient/explore this session,
    // so distances render immediately. No browser prompt is ever
    // fired on this page (gesture-gated discipline).
    window.sessionStorage.setItem('hnpl:patient-location:v1', JSON.stringify({
      latitude: -26.10, longitude: 28.05, label: 'Sandton, Johannesburg', source: 'suburb',
    }));
    const rows: DirectoryRow[] = [r({
      practice_id: 'pA',
      practice_phone: '+27 11 555 0001',
      practice_latitude: -26.10,
      practice_longitude: 28.05,
    })];
    render(<DetailView rows={rows} />);
    expect(screen.getByTestId('detail-primary-call')).toBeTruthy();
    expect(screen.getByTestId('detail-primary-directions')).toBeTruthy();
    // The prompt was never fired.
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });
});

describe('DetailView — grouping unchanged (one card per HPCSA group)', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('two rows with the same HPCSA → ONE detail card with two locations', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-a', practice_id: 'pA', practice_name: 'A' }),
      r({ member_id: 'm-b', practice_id: 'pB', practice_name: 'B' }),
    ];
    render(<DetailView rows={rows} />);
    // The name appears exactly once (one card).
    expect(screen.getAllByText('Jane Doe')).toHaveLength(1);
    expect(screen.getByText(/Locations \(2\)/)).toBeTruthy();
  });

  it('a NULL hpcsa_group_key row stands alone (not hidden by the grouping fallback)', () => {
    const rows: DirectoryRow[] = [
      r({ member_id: 'm-solo', hpcsa_group_key: null, hpcsa_registered: false, first_name: 'Solo', last_name: 'Person' }),
    ];
    render(<DetailView rows={rows} />);
    expect(screen.getByRole('heading', { name: 'Solo Person' })).toBeTruthy();
    expect(screen.getByText(/Locations \(1\)/)).toBeTruthy();
  });
});

describe('DetailView — never auto-prompts for geolocation (gesture-gated only)', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    // Clear shared-location storage so nothing hydrates.
    window.sessionStorage.clear();
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('does NOT call getCurrentPosition on mount when no location is stored', () => {
    render(<DetailView rows={[r()]} />);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('renders the locations section without a "Try location" nudge — that surface is gone', () => {
    render(<DetailView rows={[r({ practice_id: 'pA' })]} />);
    // The nudge (and its retry button) that used to appear when the
    // browser denied is no longer present at all — we never triggered
    // the request in the first place.
    expect(screen.queryByTestId('detail-try-location')).toBeNull();
    expect(screen.queryByText(/Allow location to see distance/i)).toBeNull();
    // The location row + Directions button still render.
    expect(screen.getByTestId('detail-location-pA')).toBeTruthy();
    expect(screen.getByTestId('detail-location-directions-pA')).toBeTruthy();
  });

  it('degrades gracefully with no stored coords: hides distance line but keeps Directions working', () => {
    const rows: DirectoryRow[] = [r({
      practice_id: 'pA',
      practice_latitude: -26.10,
      practice_longitude: 28.05,
    })];
    render(<DetailView rows={rows} />);
    // No distance line inside the location row.
    const row = screen.getByTestId('detail-location-pA');
    expect(row.textContent).not.toMatch(/km\b/);
    // Directions link still built from the practice coords.
    const dir = screen.getByTestId('detail-location-directions-pA') as HTMLAnchorElement;
    expect(dir.href).toContain('google.com/maps');
    expect(dir.href).toContain('-26.1,28.05');
  });
});

describe('DetailView — shared sessionStorage location', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    window.sessionStorage.clear();
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => {
    removeGeolocation();
    window.sessionStorage.clear();
  });

  it('hydrates the shared location from sessionStorage — no browser prompt on mount', () => {
    // A location was set on /patient/explore in this session. The
    // detail page must NOT re-prompt for permission.
    window.sessionStorage.setItem('hnpl:patient-location:v1', JSON.stringify({
      latitude: -26.10, longitude: 28.05, label: 'Sandton, Johannesburg', source: 'suburb',
    }));
    render(<DetailView rows={[r({
      practice_id: 'pA',
      practice_latitude: -26.10,
      practice_longitude: 28.05,
    })]} />);
    // No prompt fired.
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    // Distance computed from shared coords (same lat/lng ⇒ 0 km).
    expect(screen.getByTestId('detail-primary-directions')).toBeTruthy();
  });
});

describe('DetailView — Discovery-borrow guardrails', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => { geo = buildGeolocationStub(); installGeolocation(geo); });
  afterEach(() => { removeGeolocation(); });

  it('NO medical-aid-network language anywhere on the detail screen', () => {
    const { container } = render(<DetailView rows={[r()]} />);
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

  it('NO HPCSA badge — even when hpcsa_registered=true', () => {
    render(<DetailView rows={[r({ hpcsa_registered: true })]} />);
    expect(screen.queryByText(/HPCSA registered/)).toBeNull();
    expect(screen.queryByText(/HPCSA/)).toBeNull();
  });

  it('no banking / fee_percent / raw HPCSA can be read from the rendered DOM', () => {
    // Sanity check that the directory's exposed shape doesn't leak
    // sensitive content through props the component renders.
    const rows: DirectoryRow[] = [r({ hpcsa_group_key: 'hash-X' })];
    const { container } = render(<DetailView rows={rows} />);
    // The md5 hash from the safe view is allowed (it's a hash, not
    // the raw number) — but `hpcsa_number` / `fee_percent` /
    // `bank_account_number` must NEVER appear in the DOM string.
    const text = container.textContent ?? '';
    for (const forbidden of ['hpcsa_number', 'fee_percent', 'bank_account_number', 'branch_code', 'account_holder']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
