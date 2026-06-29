import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { PracticeCard } from './page';

// ─── Tests — explore page geolocation re-prompt + no-location render ───
//
// Bug 1: a coord-having practice was vanishing when the user hadn't
// granted location. Bug 2: the geolocation prompt wasn't firing on
// every visit. Both fixes are in ExploreView.tsx; this file pins
// them so future edits can't silently regress.
//
// We mock PlacesAutocomplete to a stub — the real one calls Google
// Places HTTPs APIs which aren't relevant here.

vi.mock('@/app/_components/PlacesAutocomplete', () => ({
  default: () => null,
}));

import ExploreView from './ExploreView';

// ─── Helpers ────────────────────────────────────────────────────────────

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

function p(over: Partial<PracticeCard> = {}): PracticeCard {
  return {
    id:        'p',
    name:      'Practice',
    specialty: null,
    phone:     null,
    email:     null,
    suburb:    null,
    city:      null,
    latitude:  null,
    longitude: null,
    ...over,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('ExploreView — no-location state renders ALL approved practices', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('renders BOTH coord-having and coord-less practices when getCurrentPosition errors (denied/dismissed)', () => {
    // Bug 1 repro: pre-fix, Cross Road (coord-having) was invisible in
    // this state. Now it MUST appear alongside Norwood.
    const practices: PracticeCard[] = [
      p({ id: 'cross-road', name: 'Cross Road Therapy', latitude: -26.10, longitude: 28.05 }),
      p({ id: 'norwood',    name: 'Norwood Medical',    latitude: null,    longitude: null  }),
    ];
    render(<ExploreView practices={practices} />);
    // Effect fires getCurrentPosition; trigger the error callback so we
    // land in the denied (no-location) state.
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    expect(screen.getByText('Cross Road Therapy')).toBeTruthy();
    expect(screen.getByText('Norwood Medical')).toBeTruthy();
    // No "Other practices" section in the no-location state — everything
    // is in one list.
    expect(screen.queryByText('Other practices')).toBeNull();
  });

  it('renders ALL approved practices while geolocation is still pending (requesting state)', () => {
    // Browsers can leave the prompt open for ages without firing
    // either callback. The page must NOT hide coord-having practices
    // in the meantime.
    const practices: PracticeCard[] = [
      p({ id: 'cross-road', name: 'Cross Road Therapy', latitude: -26.10, longitude: 28.05 }),
      p({ id: 'norwood',    name: 'Norwood Medical' }),
    ];
    render(<ExploreView practices={practices} />);
    // getCurrentPosition was called but no callback has fired — we're
    // in the 'requesting' state. Both practices must still render.
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Cross Road Therapy')).toBeTruthy();
    expect(screen.getByText('Norwood Medical')).toBeTruthy();
  });

  it('renders ALL approved practices when navigator.geolocation is unavailable', () => {
    removeGeolocation();
    const practices: PracticeCard[] = [
      p({ id: 'cross-road', name: 'Cross Road Therapy', latitude: -26.10, longitude: 28.05 }),
      p({ id: 'norwood',    name: 'Norwood Medical' }),
    ];
    render(<ExploreView practices={practices} />);
    expect(screen.getByText('Cross Road Therapy')).toBeTruthy();
    expect(screen.getByText('Norwood Medical')).toBeTruthy();
  });
});

describe('ExploreView — geolocation is requested on every mount (bug 2)', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('fires getCurrentPosition immediately on mount', () => {
    render(<ExploreView practices={[p({ id: 'a' })]} />);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('fires getCurrentPosition AGAIN on remount (a fresh visit re-attempts the prompt)', () => {
    // Bug 2 contract: every visit to the explore page must attempt
    // the geolocation prompt. Browsers suppress repeat prompts for
    // hard-blocked permissions — that's expected. But our component
    // must always TRY; we never gate the attempt on remembered state.
    const { unmount } = render(<ExploreView practices={[p({ id: 'a' })]} />);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    unmount();
    render(<ExploreView practices={[p({ id: 'a' })]} />);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it('"Try location" button re-fires getCurrentPosition after a denial', () => {
    // Manual escape hatch for the case where the user has changed
    // their browser-level permission since first mount.
    render(<ExploreView practices={[p({ id: 'a' })]} />);
    act(() => {
      const [, err] = geo.getCurrentPosition.mock.calls[0]!;
      err?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);

    const tryBtn = screen.getByTestId('explore-try-location-again');
    act(() => { fireEvent.click(tryBtn); });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(2);
  });
});

describe('ExploreView — granted state still hides beyond-radius and shows others bucket', () => {
  let geo: ReturnType<typeof buildGeolocationStub>;
  beforeEach(() => {
    geo = buildGeolocationStub();
    installGeolocation(geo);
  });
  afterEach(() => { removeGeolocation(); });

  it('granted: shows the "Other practices" header when there are coord-less rows', () => {
    const practices: PracticeCard[] = [
      // Very close to (-26.10, 28.05) so it's well within 25km.
      p({ id: 'nearby',   name: 'Nearby Practice', latitude: -26.10, longitude: 28.05 }),
      p({ id: 'no-coord', name: 'No Coord Clinic' }),
    ];
    render(<ExploreView practices={practices} />);
    act(() => {
      const [ok] = geo.getCurrentPosition.mock.calls[0]!;
      ok?.({ coords: { latitude: -26.10, longitude: 28.05 } } as GeolocationPosition);
    });
    expect(screen.getByText('Nearby Practice')).toBeTruthy();
    expect(screen.getByText('No Coord Clinic')).toBeTruthy();
    expect(screen.getByText('Other practices')).toBeTruthy();
  });
});
