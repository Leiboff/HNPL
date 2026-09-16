import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CategoryCount } from '@/lib/practitioner/categories';

// ─── Tests — the navy Find-care header ────────────────────────────────
//
// Landing → "Find care" + the total count (unchanged brand line).
// Inside a specialty → the SPECIALTY is the title, the count is that
// specialty's own, and a labelled back control returns to the specialty
// list. The title has to follow the URL param, because the Filters
// drawer in the sheet rewrites it (ExploreView.selectSpecialty).

const currentParams = new URLSearchParams();
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return { ...actual, useSearchParams: () => currentParams };
});

function setParams(next: Record<string, string>) {
  for (const k of Array.from(currentParams.keys())) currentParams.delete(k);
  for (const [k, v] of Object.entries(next)) currentParams.set(k, v);
}

import ExploreHeader from './ExploreHeader';

const CATEGORIES: CategoryCount[] = [
  { specialty: 'General Dental Practitioner', count: 8 },
  { specialty: 'Physiotherapy',               count: 1 },
];

describe('ExploreHeader — landing', () => {
  beforeEach(() => { setParams({}); });

  it('titles "Find care" and counts the whole directory', () => {
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-title').textContent).toBe('Find care');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 9 practitioners near you.');
    // No back control on the landing — there's nowhere above it.
    expect(screen.queryByTestId('results-back-to-landing')).toBeNull();
  });

  it('drops the count from the line when the directory is empty', () => {
    render(<ExploreHeader practitionerCount={0} categories={[]} />);
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at practitioners near you.');
  });
});

describe('ExploreHeader — inside a specialty', () => {
  it('promotes the specialty to the title with its own practitioner count', () => {
    setParams({ view: 'results', specialty: 'General Dental Practitioner' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-title').textContent)
      .toBe('General Dental Practitioner');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 8 practitioners.');
  });

  it('singularises a one-practitioner specialty', () => {
    setParams({ view: 'results', specialty: 'Physiotherapy' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 1 practitioner.');
  });

  it('renders a labelled back control pointing at the specialty list', () => {
    setParams({ view: 'results', specialty: 'Physiotherapy' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    const back = screen.getByTestId('results-back-to-landing');
    expect(back.getAttribute('href')).toBe('/patient/explore');
    expect(back.textContent).toContain('All specialties');
    expect(back.getAttribute('aria-label')).toBe('Back to all specialties');
  });

  it('a hand-typed specialty with nobody behind it never claims practitioners', () => {
    setParams({ view: 'results', specialty: 'Urology' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-title').textContent).toBe('Urology');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('No practitioners listed here yet.');
  });

  it('a search or an unfiltered results view titles "All practitioners"', () => {
    setParams({ view: 'results', q: 'berger' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    // The query itself is NOT echoed here: the search box in the sheet
    // owns that text and can change without the URL, so a header that
    // quoted it would go stale mid-typing.
    expect(screen.getByTestId('explore-header-title').textContent).toBe('All practitioners');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 9 practitioners.');
    expect(screen.getByTestId('results-back-to-landing')).toBeTruthy();
  });
});
