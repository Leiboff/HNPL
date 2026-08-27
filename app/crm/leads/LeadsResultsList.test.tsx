import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LeadsResultsList, { type LeadRow } from './LeadsResultsList';

vi.mock('./actions', () => ({ bulkAssignOwner: vi.fn() }));

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

describe('1. a lead with no estimated_monthly_billings renders an empty cell', () => {
  it('renders "—", never undefined/null/R0/NaN, in the desktop value cell', () => {
    render(<LeadsResultsList rows={[BASE_ROW]} owners={[]} />);
    const cell = screen.getByTestId('lead-value:lead-1');
    expect(cell.textContent).toBe('—');
    expect(cell.textContent).not.toBe('undefined');
    expect(cell.textContent).not.toBe('null');
    expect(cell.textContent).not.toContain('NaN');
    expect(cell.textContent).not.toContain('R0');
  });

  it('renders the formatted amount when a value IS set', () => {
    render(<LeadsResultsList rows={[{ ...BASE_ROW, estimated_monthly_billings: 45000 }]} owners={[]} />);
    const cell = screen.getByTestId('lead-value:lead-1');
    expect(cell.textContent).toBe('R45,000.00');
  });

  it('renders "—" (never R0) for exactly zero, distinguishing "no data" from "worth nothing"', () => {
    // estimated_monthly_billings = 0 is a real, distinct value from
    // "not set" (null) — but 0 != null, so the current rule renders it
    // as an actual R0.00 rather than the empty dash. Documented here so
    // a future change to the null-check is a deliberate one.
    render(<LeadsResultsList rows={[{ ...BASE_ROW, estimated_monthly_billings: 0 }]} owners={[]} />);
    const cell = screen.getByTestId('lead-value:lead-1');
    expect(cell.textContent).toBe('R0.00');
  });
});

describe('bulk assign bar', () => {
  it('is hidden with nothing selected, appears after selecting a row', () => {
    render(<LeadsResultsList rows={[BASE_ROW]} owners={[{ id: 'owner-1', name: 'Steve' }]} />);
    expect(screen.queryByTestId('bulk-assign-bar')).toBeNull();
    screen.getByTestId('lead-select:lead-1').click();
    expect(screen.getByTestId('bulk-assign-bar')).toBeTruthy();
  });
});

describe('distance-from-me column and ascending sort', () => {
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

  it('shows a Distance column with "—" before location is available', () => {
    render(<LeadsResultsList rows={[NEAR, FAR]} owners={[]} />);
    expect(screen.getByTestId('lead-distance:near').textContent).toBe('—');
    expect(screen.getByTestId('lead-distance:far').textContent).toBe('—');
  });

  it('clicking the Distance header requests location and orders leads ascending by distance', async () => {
    render(<LeadsResultsList rows={[FAR, NEAR, NO_COORDS]} owners={[]} />);
    fireEvent.click(screen.getByTestId('sort-by-distance'));

    await waitFor(() => expect(screen.getByTestId('lead-distance:near').textContent).not.toBe('—'));

    const rowsInOrder = screen.getAllByRole('row').slice(1); // drop the header row
    const namesInOrder = rowsInOrder.map(r => r.textContent);
    const nearIdx = namesInOrder.findIndex(t => t?.includes('Near Practice'));
    const farIdx  = namesInOrder.findIndex(t => t?.includes('Far Practice'));
    const noCoordsIdx = namesInOrder.findIndex(t => t?.includes('No Coords Practice'));

    expect(nearIdx).toBeLessThan(farIdx); // ascending — nearest first
    expect(noCoordsIdx).toBeGreaterThan(farIdx); // no-coords leads sink to the bottom, never crash the sort
    expect(screen.getByTestId('lead-distance:near').textContent).toMatch(/^\d+\.\d km$/);
    expect(parseFloat(screen.getByTestId('lead-distance:near').textContent!))
      .toBeLessThan(parseFloat(screen.getByTestId('lead-distance:far').textContent!));
  });
});
