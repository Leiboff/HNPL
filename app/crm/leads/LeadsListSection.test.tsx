import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LeadsListSection from './LeadsListSection';
import type { LeadRow } from './LeadsResultsList';

vi.mock('./actions', () => ({ bulkAssignOwner: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/crm/leads',
  useSearchParams: () => new URLSearchParams(),
}));

const BASE_ROW: LeadRow = {
  id: 'lead-1',
  practice_name: 'Test Practice',
  contact_first_name: 'Jane',
  contact_last_name: 'Doe',
  phone: null,
  email: null,
  stage: 'new',
  specialty: null,
  suburb: null,
  city: null,
  next_follow_up_at: null,
  updated_at: '2026-08-01T00:00:00Z',
  estimated_monthly_billings: null,
  latitude: null,
  longitude: null,
};

const COMMON_PROPS = {
  owners: [],
  specialties: ['Cardiology'],
  cities: ['Cape Town'],
  isAdmin: false,
  currentUserId: 'user-1',
};

describe('LeadsListSection — "Distance from me" sort, owned here (not the results table)', () => {
  const FAR:  LeadRow = { ...BASE_ROW, id: 'far',  practice_name: 'Far Practice',  latitude: -33.9, longitude: 25.6 };  // ~Gqeberha
  const NEAR: LeadRow = { ...BASE_ROW, id: 'near', practice_name: 'Near Practice', latitude: -26.21, longitude: 28.05 }; // ~Joburg CBD
  const NO_COORDS: LeadRow = { ...BASE_ROW, id: 'no-coords', practice_name: 'No Coords Practice', latitude: null, longitude: null };

  // User is right at the "near" lead's coordinates.
  const USER_POS = { coords: { latitude: -26.2041, longitude: 28.0473 } };

  beforeEach(() => {
    Object.defineProperty(global.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: vi.fn((success) => success(USER_POS)) },
    });
  });

  it('has no Distance column until "Distance from me" is picked from the Sort sheet', () => {
    render(<LeadsListSection rows={[NEAR, FAR]} {...COMMON_PROPS} />);
    expect(screen.queryByTestId('lead-distance:near')).toBeNull();
  });

  it('picking "Distance from me" in the Sort sheet requests location and sorts ascending', async () => {
    render(<LeadsListSection rows={[FAR, NEAR, NO_COORDS]} {...COMMON_PROPS} />);
    fireEvent.click(screen.getByTestId('open-sort-sheet'));
    fireEvent.click(screen.getByTestId('sort-option:distance'));

    await waitFor(() => expect(screen.getByTestId('lead-distance:near').textContent).not.toBe('—'));

    const rowsInOrder = screen.getAllByRole('row').slice(1);
    const namesInOrder = rowsInOrder.map(r => r.textContent);
    const nearIdx = namesInOrder.findIndex(t => t?.includes('Near Practice'));
    const farIdx  = namesInOrder.findIndex(t => t?.includes('Far Practice'));
    const noCoordsIdx = namesInOrder.findIndex(t => t?.includes('No Coords Practice'));

    expect(nearIdx).toBeLessThan(farIdx); // ascending — nearest first
    expect(noCoordsIdx).toBeGreaterThan(farIdx); // no-coords leads sink to the bottom
    expect(screen.getByTestId('lead-distance:near').textContent).toMatch(/^\d+\.\d km$/);
    expect(parseFloat(screen.getByTestId('lead-distance:near').textContent!))
      .toBeLessThan(parseFloat(screen.getByTestId('lead-distance:far').textContent!));
  });

  it('shows a location error inline and never crashes when geolocation fails', async () => {
    Object.defineProperty(global.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: vi.fn((_success, error) => error({ message: 'User denied geolocation' })) },
    });
    render(<LeadsListSection rows={[NEAR, FAR]} {...COMMON_PROPS} />);
    fireEvent.click(screen.getByTestId('open-sort-sheet'));
    fireEvent.click(screen.getByTestId('sort-option:distance'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('User denied geolocation'));
    expect(screen.queryByTestId('lead-distance:near')).toBeNull();
  });
});

describe('LeadsListSection — empty state', () => {
  it('shows the empty message (and still shows the toolbar) when rows is empty', () => {
    render(<LeadsListSection rows={[]} {...COMMON_PROPS} />);
    expect(screen.getByText(/No leads match/)).toBeTruthy();
    expect(screen.getByTestId('open-sort-sheet')).toBeTruthy();
    expect(screen.getByTestId('open-filter-sheet')).toBeTruthy();
  });
});
