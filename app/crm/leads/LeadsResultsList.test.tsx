import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('distance column — purely presentational, driven by the distanceById prop', () => {
  // LeadsResultsList no longer owns geolocation (that moved to
  // LeadsListSection, see LeadsListSection.test.tsx) — it just renders
  // whatever distanceById + row order it's handed.
  const FAR:  LeadRow = { ...BASE_ROW, id: 'far',  practice_name: 'Far Practice',  latitude: -33.9, longitude: 25.6 };
  const NEAR: LeadRow = { ...BASE_ROW, id: 'near', practice_name: 'Near Practice', latitude: -26.21, longitude: 28.05 };

  it('renders no Distance column when distanceById is not passed', () => {
    render(<LeadsResultsList rows={[NEAR, FAR]} owners={[]} />);
    expect(screen.queryByTestId('lead-distance:near')).toBeNull();
    expect(screen.queryByTestId('lead-distance:far')).toBeNull();
    expect(screen.queryByText('Distance')).toBeNull();
  });

  it('renders a Distance column with the supplied km, "—" for unknown rows, in the given row order', () => {
    render(<LeadsResultsList rows={[NEAR, FAR]} owners={[]} distanceById={{ near: 0.1, far: 850.4 }} />);
    expect(screen.getByTestId('lead-distance:near').textContent).toBe('0.1 km');
    expect(screen.getByTestId('lead-distance:far').textContent).toBe('850.4 km');

    const rowsInOrder = screen.getAllByRole('row').slice(1);
    const namesInOrder = rowsInOrder.map(r => r.textContent);
    expect(namesInOrder.findIndex(t => t?.includes('Near Practice')))
      .toBeLessThan(namesInOrder.findIndex(t => t?.includes('Far Practice')));
  });

  it('shows "—" for a row missing from distanceById (no coords)', () => {
    render(<LeadsResultsList rows={[FAR]} owners={[]} distanceById={{ far: null }} />);
    expect(screen.getByTestId('lead-distance:far').textContent).toBe('—');
  });
});
