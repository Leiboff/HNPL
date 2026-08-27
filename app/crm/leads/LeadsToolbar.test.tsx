import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LeadsToolbar from './LeadsToolbar';

const push = vi.fn();
let params = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/crm/leads',
  useSearchParams: () => params,
}));

const COMMON_PROPS = {
  specialties: ['Cardiology'],
  cities: ['Cape Town'],
  owners: [{ id: 'owner-1', name: 'Steve' }],
  isAdmin: true,
  currentUserId: 'user-1',
  distanceSortActive: false,
  locating: false,
  onSelectDistanceSort: vi.fn(),
};

beforeEach(() => {
  push.mockClear();
  params = new URLSearchParams();
  COMMON_PROPS.onSelectDistanceSort.mockClear();
});

describe('LeadsToolbar — retail-style Sort/Filter buttons', () => {
  it('renders exactly two buttons; both sheets start closed', () => {
    render(<LeadsToolbar {...COMMON_PROPS} />);
    expect(screen.getByTestId('open-sort-sheet')).toBeTruthy();
    expect(screen.getByTestId('open-filter-sheet')).toBeTruthy();
    expect(screen.queryByTestId('sort-option:updated')).toBeNull();
    expect(screen.queryByTestId('leads-filter-dropdowns')).toBeNull();
  });

  it('opens the Sort sheet, navigates on picking an option, and closes it', () => {
    render(<LeadsToolbar {...COMMON_PROPS} />);
    fireEvent.click(screen.getByTestId('open-sort-sheet'));
    expect(screen.getByTestId('sort-option:updated')).toBeTruthy();

    fireEvent.click(screen.getByTestId('sort-option:updated'));
    expect(push).toHaveBeenCalledWith('/crm/leads?sort=updated');
    expect(screen.queryByTestId('sort-option:updated')).toBeNull(); // sheet closed
  });

  it('lists "Distance from me" as an explicit Sort option that calls onSelectDistanceSort instead of navigating', () => {
    render(<LeadsToolbar {...COMMON_PROPS} />);
    fireEvent.click(screen.getByTestId('open-sort-sheet'));
    fireEvent.click(screen.getByTestId('sort-option:distance'));
    expect(COMMON_PROPS.onSelectDistanceSort).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows "Sort: Distance from me" as the button label when distanceSortActive is true', () => {
    render(<LeadsToolbar {...COMMON_PROPS} distanceSortActive />);
    expect(screen.getByTestId('open-sort-sheet').textContent).toContain('Distance from me');
  });

  it('opens the Filter sheet with the stacked dropdowns and no badge when nothing is active', () => {
    render(<LeadsToolbar {...COMMON_PROPS} />);
    expect(screen.queryByTestId('clear-all-filters')).toBeNull();
    fireEvent.click(screen.getByTestId('open-filter-sheet'));
    expect(screen.getByTestId('leads-filter-dropdowns')).toBeTruthy();
    expect(screen.queryByTestId('clear-all-filters')).toBeNull();
  });

  it('shows an active-filter-count badge and a "Clear all filters" button when filters are set', () => {
    params = new URLSearchParams({ stage: 'new', overdue: 'true' });
    render(<LeadsToolbar {...COMMON_PROPS} />);
    expect(screen.getByTestId('open-filter-sheet').textContent).toContain('2');

    fireEvent.click(screen.getByTestId('open-filter-sheet'));
    fireEvent.click(screen.getByTestId('clear-all-filters'));
    expect(push).toHaveBeenCalledWith('/crm/leads');
  });

  it('closes a sheet via the Done button', () => {
    render(<LeadsToolbar {...COMMON_PROPS} />);
    fireEvent.click(screen.getByTestId('open-sort-sheet'));
    fireEvent.click(screen.getByTestId('close-sheet'));
    expect(screen.queryByTestId('sort-option:updated')).toBeNull();
  });
});
